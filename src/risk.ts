import type { RiskConfig } from "./config.ts";
import type { Interval } from "./types.ts";

export interface RiskState {
  /** UTC day key, e.g. 2026-11-03. */
  dayKey: string;
  tradesToday: number;
  tradesTodayByInterval: Record<Interval, number>;
  consecutiveLosses: number;
  realizedPnlUsd: number;
  dayStartEquityUsd: number;
  highWaterEquityUsd: number;
  halted: boolean;
  haltReason: string | null;
  cooldownUntilMs: number;
}

export function freshRiskState(dayKey: string, equityUsd: number): RiskState {
  return {
    dayKey,
    tradesToday: 0,
    tradesTodayByInterval: { "5m": 0, "15m": 0 },
    consecutiveLosses: 0,
    realizedPnlUsd: 0,
    dayStartEquityUsd: equityUsd,
    highWaterEquityUsd: equityUsd,
    halted: false,
    haltReason: null,
    cooldownUntilMs: 0,
  };
}

export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export interface RiskCheck {
  ok: boolean;
  reason?: string;
  detail?: Record<string, number | string>;
}

/**
 * Position-level risk limits from the guide: a handful of trades per day, a hard
 * stop after consecutive losses, a daily loss cap, a drawdown kill switch and a
 * cooldown. Sizing is never adjusted for streaks — that is the martingale trap.
 */
export class RiskManager {
  constructor(
    public state: RiskState,
    private readonly config: RiskConfig,
  ) {}

  rollDay(nowMs: number, equityUsd: number): boolean {
    const key = utcDayKey(nowMs);
    if (key === this.state.dayKey) return false;
    this.state.dayKey = key;
    this.state.tradesToday = 0;
    this.state.tradesTodayByInterval = { "5m": 0, "15m": 0 };
    this.state.realizedPnlUsd = 0;
    this.state.dayStartEquityUsd = equityUsd;
    this.state.halted = false;
    this.state.haltReason = null;
    this.state.cooldownUntilMs = 0;
    return true;
  }

  canOpen(params: {
    nowMs: number;
    equityUsd: number;
    openPositions: number;
    interval: Interval;
    killSwitch?: boolean;
  }): RiskCheck {
    const { nowMs, equityUsd, openPositions, interval } = params;
    if (params.killSwitch) return { ok: false, reason: "kill-switch-file-present" };
    if (this.state.halted) return { ok: false, reason: `halted:${this.state.haltReason ?? "unknown"}` };
    if (this.state.cooldownUntilMs > nowMs) {
      return {
        ok: false,
        reason: "cooldown",
        detail: { secondsLeft: Math.round((this.state.cooldownUntilMs - nowMs) / 1000) },
      };
    }
    if (openPositions >= this.config.maxConcurrentPositions) {
      return { ok: false, reason: "max-concurrent-positions", detail: { open: openPositions } };
    }
    if (this.state.tradesToday >= this.config.maxTradesPerDay) {
      return { ok: false, reason: "max-trades-per-day", detail: { trades: this.state.tradesToday } };
    }
    if (this.state.tradesTodayByInterval[interval] >= this.config.maxTradesPerDay) {
      return { ok: false, reason: "max-trades-per-day-interval" };
    }

    const dayLossUsd = this.state.dayStartEquityUsd - equityUsd;
    const dayLimitUsd = (this.state.dayStartEquityUsd * this.config.dailyLossLimitPct) / 100;
    if (dayLimitUsd > 0 && dayLossUsd >= dayLimitUsd) {
      this.halt(`daily-loss-limit:${dayLimitUsd.toFixed(2)}`);
      return { ok: false, reason: "daily-loss-limit", detail: { dayLossUsd: Math.round(dayLossUsd) } };
    }

    const drawdownUsd = this.state.highWaterEquityUsd - equityUsd;
    const drawdownLimitUsd = (this.state.highWaterEquityUsd * this.config.maxDrawdownPct) / 100;
    if (drawdownLimitUsd > 0 && drawdownUsd >= drawdownLimitUsd) {
      this.halt(`max-drawdown:${drawdownLimitUsd.toFixed(2)}`);
      return { ok: false, reason: "max-drawdown", detail: { drawdownUsd: Math.round(drawdownUsd) } };
    }

    return { ok: true };
  }

  recordOpen(interval: Interval): void {
    this.state.tradesToday += 1;
    this.state.tradesTodayByInterval[interval] += 1;
  }

  /** Called with realised PnL in USD once a position is closed or settles. */
  recordClose(pnlUsd: number, nowMs: number, equityUsd: number): void {
    this.state.realizedPnlUsd += pnlUsd;
    if (pnlUsd < 0) {
      this.state.consecutiveLosses += 1;
      this.state.cooldownUntilMs = nowMs + this.config.cooldownAfterLossSec * 1000;
    } else if (pnlUsd > 0) {
      this.state.consecutiveLosses = 0;
    }
    if (equityUsd > this.state.highWaterEquityUsd) this.state.highWaterEquityUsd = equityUsd;

    if (this.state.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      this.halt(`consecutive-losses:${this.state.consecutiveLosses}`);
    }
  }

  halt(reason: string): void {
    this.state.halted = true;
    this.state.haltReason = reason;
  }

  resume(): void {
    this.state.halted = false;
    this.state.haltReason = null;
    this.state.consecutiveLosses = 0;
    this.state.cooldownUntilMs = 0;
  }
}
