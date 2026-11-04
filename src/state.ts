import { existsSync, mkdirSync, readFileSync, appendFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Anchor, Position, TradeRecord } from "./types.ts";
import { freshRiskState, utcDayKey, type RiskState } from "./risk.ts";

export interface PersistedState {
  version: 1;
  bankrollUsd: number;
  highWaterBankrollUsd: number;
  positions: Position[];
  anchors: Record<string, Anchor>;
  risk: RiskState;
  updatedAt: string;
}

export class Store {
  readonly dir: string;
  readonly statePath: string;
  readonly tradesPath: string;
  readonly killSwitchPath: string;
  /** Left behind by a reset so a running engine knows to reload from disk. */
  readonly resetMarkerPath: string;
  /** Left behind by a config save so a running engine reloads its thresholds. */
  readonly configMarkerPath: string;
  /** Left behind by a manual resume/unhalt so a running engine clears halts. */
  readonly resumeMarkerPath: string;
  /** PID of a bot loop started from the dashboard. */
  readonly pidPath: string;
  readonly botLogPath: string;

  constructor(dir: string) {
    this.dir = dir;
    this.statePath = join(dir, "state.json");
    this.tradesPath = join(dir, "trades.ndjson");
    this.killSwitchPath = join(dir, "STOP");
    this.resetMarkerPath = join(dir, "RESET");
    this.configMarkerPath = join(dir, "RELOAD");
    this.resumeMarkerPath = join(dir, "RESUME");
    this.pidPath = join(dir, "bot.pid");
    this.botLogPath = join(dir, "bot.log");
  }

  ensure(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  totalRealizedPnlFromTrades(): number {
    if (!existsSync(this.tradesPath)) return 0;
    try {
      const lines = readFileSync(this.tradesPath, "utf8").trim().split("\n").filter(Boolean);
      let sum = 0;
      for (const line of lines) {
        const trade = JSON.parse(line) as TradeRecord;
        if (typeof trade.pnlUsd === "number") {
          sum += trade.pnlUsd;
        }
      }
      return Math.round(sum * 100000) / 100000;
    } catch {
      return 0;
    }
  }

  load(bankrollUsd: number): PersistedState {
    this.ensure();
    if (!existsSync(this.statePath)) {
      const state: PersistedState = {
        version: 1,
        bankrollUsd,
        highWaterBankrollUsd: bankrollUsd,
        positions: [],
        anchors: {},
        risk: freshRiskState(new Date().toISOString().slice(0, 10), bankrollUsd),
        updatedAt: new Date().toISOString(),
      };
      this.save(state);
      return state;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as PersistedState;
      parsed.positions ??= [];
      parsed.anchors ??= {};
      parsed.risk ??= freshRiskState(new Date().toISOString().slice(0, 10), bankrollUsd);
      parsed.bankrollUsd ??= bankrollUsd;
      parsed.highWaterBankrollUsd ??= bankrollUsd;

      // Reconcile cumulative realized PnL if trades exist but state was wiped by day rollover
      const tradePnlSum = this.totalRealizedPnlFromTrades();
      if (tradePnlSum !== 0 && parsed.risk.realizedPnlUsd === 0) {
        parsed.risk.realizedPnlUsd = tradePnlSum;
      }
      const currentEquity = parsed.bankrollUsd + parsed.risk.realizedPnlUsd;
      if (parsed.risk.highWaterEquityUsd < currentEquity) {
        parsed.risk.highWaterEquityUsd = currentEquity;
      }
      if (parsed.highWaterBankrollUsd < currentEquity) {
        parsed.highWaterBankrollUsd = currentEquity;
      }
      // If halted due to daily-loss-limit but actual day loss does not breach the limit, heal halt status
      if (parsed.risk.halted && parsed.risk.haltReason?.startsWith("daily-loss-limit")) {
        const dayLoss = parsed.risk.dayStartEquityUsd - currentEquity;
        const dayLimit = (parsed.risk.dayStartEquityUsd * 3) / 100;
        if (dayLoss < dayLimit) {
          parsed.risk.halted = false;
          parsed.risk.haltReason = null;
        }
      }

      return parsed;
    } catch {
      const state: PersistedState = {
        version: 1,
        bankrollUsd,
        highWaterBankrollUsd: bankrollUsd,
        positions: [],
        anchors: {},
        risk: freshRiskState(new Date().toISOString().slice(0, 10), bankrollUsd),
        updatedAt: new Date().toISOString(),
      };
      this.save(state);
      return state;
    }
  }

  save(state: PersistedState): void {
    this.ensure();
    state.updatedAt = new Date().toISOString();
    // Write then rename: a reader must never see half a state file, and a crash
    // mid-write must not look like corrupt state on the next start.
    const temp = `${this.statePath}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(temp, this.statePath);
  }

  appendTrade(record: TradeRecord): void {
    this.ensure();
    appendFileSync(this.tradesPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  readTrades(limit = 200): TradeRecord[] {
    if (!existsSync(this.tradesPath)) return [];
    const lines = readFileSync(this.tradesPath, "utf8").trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as TradeRecord;
        } catch {
          return null;
        }
      })
      .filter((record): record is TradeRecord => record !== null);
  }

  killSwitchActive(): boolean {
    return existsSync(this.killSwitchPath);
  }

  /**
   * Wipes positions, trades and risk counters back to a fresh bankroll. Nothing
   * is deleted beyond the bot's own state: a running engine reloads on its next
   * tick from the RESET marker, so a reset is safe either way.
   */
  reset(bankrollUsd: number): PersistedState {
    this.ensure();
    const fresh: PersistedState = {
      version: 1,
      bankrollUsd,
      highWaterBankrollUsd: bankrollUsd,
      positions: [],
      anchors: {},
      risk: freshRiskState(utcDayKey(Date.now()), bankrollUsd),
      updatedAt: new Date().toISOString(),
    };
    this.save(fresh);
    if (existsSync(this.tradesPath)) rmSync(this.tradesPath, { force: true });
    // A clean reset also releases the kill switch, otherwise a restarted bot
    // would silently refuse to trade.
    if (existsSync(this.killSwitchPath)) rmSync(this.killSwitchPath, { force: true });
    writeFileSync(this.resetMarkerPath, `${new Date().toISOString()}\n`, "utf8");
    return fresh;
  }

  clear(): void {
    this.save({
      version: 1,
      bankrollUsd: 0,
      highWaterBankrollUsd: 0,
      positions: [],
      anchors: {},
      risk: freshRiskState(new Date().toISOString().slice(0, 10), 0),
      updatedAt: new Date().toISOString(),
    });
  }
}
