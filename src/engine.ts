import { existsSync, rmSync } from "node:fs";

import { intervalSeconds, loadConfig, type BotConfig } from "./config.ts";
import { LiveExchange } from "./exchangeLive.ts";
import type { Exchange } from "./exchange.ts";
import { log, money, sleep } from "./log.ts";
import { discoverMarket, refreshQuotes, windowStartSec } from "./market.ts";
import { newsStatus } from "./news.ts";
import { volatilityPerSqrtSecond, rangePct } from "./probability.ts";
import type { PriceFeed } from "./priceFeed.ts";
import { RiskManager, type RiskState } from "./risk.ts";
import { evaluateEntry, evaluateExit, inspectMarket, type MarketMetrics } from "./signals.ts";
import { Journal, type BotEvent, type BotSnapshot, type MarketView } from "./telemetry.ts";
import type { Store, PersistedState } from "./state.ts";
import type { Anchor, Interval, MarketRef, OutcomeSide, Position, TradeRecord } from "./types.ts";

export interface EngineOptions {
  config: BotConfig;
  feed: PriceFeed;
  exchange: Exchange;
  store?: Store;
  /** When provided, every decision and the per-tick snapshot are written for a UI. */
  journal?: Journal;
  /** When false nothing is written to disk (used by `scan`). */
  persist: boolean;
}

export class Engine {
  private config: BotConfig;
  private readonly feed: PriceFeed;
  private readonly exchange: Exchange;
  private readonly store?: Store;
  private readonly journal?: Journal;
  private readonly persist: boolean;

  private state: PersistedState;
  private risk: RiskManager;
  private markets = new Map<string, MarketRef>();
  private lastLogAt = new Map<string, number>();
  /** Latest per-market view, published to the dashboard snapshot. */
  private verdicts = new Map<string, MarketView>();
  /** De-dupe signatures so the journal records changes, not every 2s tick. */
  private lastSignature = new Map<string, string>();
  private stopped = false;

  constructor(options: EngineOptions) {
    this.config = options.config;
    this.feed = options.feed;
    this.exchange = options.exchange;
    this.store = options.store;
    this.journal = options.journal;
    this.persist = options.persist && options.store !== undefined;

    const bankroll = this.config.bankrollUsd;
    this.state = this.store
      ? this.store.load(bankroll, this.config.risk.dailyLossLimitPct)
      : {
          version: 1,
          bankrollUsd: bankroll,
          highWaterBankrollUsd: bankroll,
          positions: [],
          anchors: {},
          risk: {
            dayKey: new Date().toISOString().slice(0, 10),
            tradesToday: 0,
            tradesTodayByInterval: { "5m": 0, "15m": 0 },
            consecutiveLosses: 0,
            realizedPnlUsd: 0,
            dayStartEquityUsd: bankroll,
            highWaterEquityUsd: bankroll,
            halted: false,
            haltReason: null,
            cooldownUntilMs: 0,
          },
          updatedAt: new Date().toISOString(),
        };
    this.risk = new RiskManager(this.state.risk, this.config.risk);
  }

  get snapshot(): { state: PersistedState; risk: RiskState } {
    return { state: this.state, risk: this.risk.state };
  }

  async run(options: { durationMs?: number } = {}): Promise<void> {
    const deadline = options.durationMs ? Date.now() + options.durationMs : Number.POSITIVE_INFINITY;
    await this.feed.start();
    log("info", "engine started", {
      mode: this.exchange.mode,
      intervals: this.config.intervals.join(","),
      bankroll: money(this.equityUsd()),
      tradesToday: this.risk.state.tradesToday,
    });

    while (!this.stopped && Date.now() < deadline) {
      try {
        await this.tick();
      } catch (error) {
        log("error", "tick failed", { error: error instanceof Error ? error.message : String(error) });
      }
      if (Date.now() >= deadline) break;
      await sleep(this.config.pollIntervalMs);
    }

    this.feed.stop();
    if (this.persist) this.save();
    log("info", "engine stopped", { equity: money(this.equityUsd()), trades: this.risk.state.tradesToday });
  }

  stop(): void {
    this.stopped = true;
  }

  /** A config save leaves a marker; pick up new thresholds without a restart. */
  private reloadIfConfigChanged(): void {
    if (!this.store || !existsSync(this.store.configMarkerPath)) return;
    try {
      rmSync(this.store.configMarkerPath, { force: true });
    } catch {
      // best effort: the next tick will try again
    }
    this.config = loadConfig({ live: this.config.live });
    this.risk = new RiskManager(this.state.risk, this.config.risk);
    if (this.risk.recheckHalt(this.equityUsd())) {
      log("risk", "halt cleared: allowed under new risk limits", {
        equity: money(this.equityUsd()),
        dailyLossLimitPct: this.config.risk.dailyLossLimitPct,
      });
    }
    this.lastSignature.clear();
    log("info", "configuration reloaded", {
      minEdge: this.config.entry.minEdge,
      maxTradesPerDay: this.config.risk.maxTradesPerDay,
      dailyLossLimitPct: this.config.risk.dailyLossLimitPct,
      intervals: this.config.intervals.join(","),
    });
  }

  /** A dashboard resume clears halts and unpauses entries. */
  private reloadIfResume(): void {
    if (!this.store || !existsSync(this.store.resumeMarkerPath)) return;
    try {
      rmSync(this.store.resumeMarkerPath, { force: true });
    } catch {
      // best effort
    }
    this.risk.resume();
    log("risk", "halt cleared via manual resume", {
      equity: money(this.equityUsd()),
    });
  }

  /** A dashboard reset leaves a marker; reload it so a running bot wipes itself too. */
  private reloadIfReset(): void {
    if (!this.store || !existsSync(this.store.resetMarkerPath)) return;
    try {
      rmSync(this.store.resetMarkerPath, { force: true });
    } catch {
      // best effort: the next tick will try again
    }
    this.state = this.store.load(this.config.bankrollUsd, this.config.risk.dailyLossLimitPct);
    this.risk = new RiskManager(this.state.risk, this.config.risk);
    this.verdicts.clear();
    this.lastSignature.clear();
    this.lastLogAt.clear();
    log("risk", "reset loaded: positions, trades and counters cleared", {
      bankroll: money(this.config.bankrollUsd),
    });
  }

  async tick(nowMs: number = Date.now()): Promise<void> {
    this.reloadIfConfigChanged();
    this.reloadIfResume();
    this.reloadIfReset();
    const equity = this.equityUsd();
    if (this.risk.rollDay(nowMs, equity)) {
      log("info", "new UTC day: daily counters reset", { equity: money(equity) });
    }
    this.risk.updateHighWater(equity);
    if (equity > this.state.highWaterBankrollUsd) {
      this.state.highWaterBankrollUsd = equity;
    }

    await this.syncMarkets(nowMs);
    await this.captureAnchors(nowMs);
    await this.refreshActiveQuotes(nowMs);
    await this.managePositions(nowMs);
    await this.considerEntries(nowMs);

    if (this.persist) this.save();
    if (this.journal) this.journal.snapshot(this.buildSnapshot(nowMs));
  }

  // ---------------------------------------------------------------- discovery

  private async syncMarkets(nowMs: number): Promise<void> {
    for (const interval of this.config.intervals) {
      const current = windowStartSec(interval, nowMs);
      const next = current + intervalSeconds(interval);

      for (const startSec of [current, next]) {
        const slug = `${this.config.asset}-updown-${interval}-${startSec}`;
        const cached = this.markets.get(slug);
        if (cached && nowMs - cached.fetchedAtMs < this.config.marketRefreshMs) continue;
        try {
          const market = await discoverMarket(this.config.asset, interval, startSec);
          if (!market) continue;
          this.markets.set(slug, market);
        } catch (error) {
          this.throttledLog(`discover:${slug}`, nowMs, 60_000, "error", "discovery failed", {
            slug,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Drop windows that are well past resolution.
    for (const [slug, market] of this.markets) {
      if (nowMs - market.endMs > 30 * 60 * 1000) this.markets.delete(slug);
    }
  }

  /** Windows that are open right now (one per configured interval). */
  private activeMarkets(nowMs: number): MarketRef[] {
    const active: MarketRef[] = [];
    for (const interval of this.config.intervals) {
      const startSec = windowStartSec(interval, nowMs);
      const market = this.markets.get(`${this.config.asset}-updown-${interval}-${startSec}`);
      if (market) active.push(market);
    }
    return active;
  }

  private async captureAnchors(nowMs: number): Promise<void> {
    for (const market of this.markets.values()) {
      if (this.state.anchors[market.slug]) continue;
      if (nowMs < market.startMs) continue;

      // Prefer our own feed sampled at the window open: it keeps the model on a
      // single price source instead of mixing venues.
      const sample = this.feed.sampleNear(market.startMs, 15_000);
      if (sample) {
        this.state.anchors[market.slug] = { value: sample.value, source: "live", capturedAtMs: sample.ts };
        this.journalEvent(`anchor:${market.slug}`, "live", nowMs, "anchor", "anchor captured at window open", {
          market,
          detail: { price: sample.value, source: "live" },
        });
        continue;
      }

      // Started mid-window: recover the open from 1-minute candles so the window
      // is still tradeable instead of being skipped entirely.
      const recovered = await this.feed.priceAt(market.startMs);
      if (recovered) {
        this.state.anchors[market.slug] = { value: recovered, source: "history", capturedAtMs: nowMs };
        this.throttledLog(`anchor-hist:${market.slug}`, nowMs, 300_000, "info", "anchor recovered from candles", {
          slug: market.slug,
          price: recovered,
        });
        this.journalEvent(`anchor:${market.slug}`, "history", nowMs, "anchor", "anchor recovered from candles", {
          market,
          detail: { price: recovered, source: "history" },
        });
        continue;
      }

      if (market.publishedPriceToBeat) {
        this.state.anchors[market.slug] = {
          value: market.publishedPriceToBeat,
          source: "published",
          capturedAtMs: nowMs,
        };
        this.throttledLog(`anchor:${market.slug}`, nowMs, 300_000, "info", "using published priceToBeat (venue basis)", {
          slug: market.slug,
          beat: market.publishedPriceToBeat,
        });
        this.journalEvent(`anchor:${market.slug}`, "published", nowMs, "anchor", "using published priceToBeat", {
          market,
          detail: { price: market.publishedPriceToBeat, source: "published" },
        });
      }
    }
  }

  private async refreshActiveQuotes(nowMs: number): Promise<void> {
    const needed = new Map<string, MarketRef>();
    for (const market of this.activeMarkets(nowMs)) needed.set(market.slug, market);
    for (const position of this.state.positions) {
      const market = this.markets.get(position.slug);
      if (market) needed.set(market.slug, market);
    }
    await Promise.all(
      [...needed.values()].map(async (market) => {
        try {
          await refreshQuotes(market);
        } catch (error) {
          this.throttledLog(`quotes:${market.slug}`, nowMs, 30_000, "error", "quote refresh failed", {
            slug: market.slug,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }

  // ------------------------------------------------------------------- exits

  private async managePositions(nowMs: number): Promise<void> {
    for (const position of [...this.state.positions]) {
      const market = this.markets.get(position.slug);
      if (!market) continue;

      if (market.resolved || nowMs >= market.endMs) {
        await this.settle(position, market, nowMs);
        continue;
      }

      const bid = market.quotes[position.side].bid;
      const news = newsStatus(this.config.news, nowMs);
      const decision = evaluateExit({
        nowMs,
        position,
        bid,
        newsBlocked: news.blocked,
        config: this.config,
      });
      position.stallSinceMs = decision.stallSinceMs;
      position.stallLeftBandSinceMs = decision.stallLeftBandSinceMs;

      if (decision.action !== "sell") {
        this.throttledLog(
          `hold:${position.id}`,
          nowMs,
          45_000,
          "info",
          "holding position",
          { slug: position.slug, side: position.side, bid, why: decision.reason },
        );
        this.journalEvent(`hold:${position.id}`, `${decision.reason}:${bid ?? "none"}`, nowMs, "hold", decision.reason, {
          market,
          side: position.side,
          detail: { bid, stalledSec: position.stallSinceMs === null ? null : Math.round((nowMs - position.stallSinceMs) / 1000) },
        });
        continue;
      }

      const fill = await this.exchange.sell({
        tokenId: position.tokenId,
        shares: position.shares,
        minPrice: decision.minPrice,
        quote: market.quotes[position.side],
      });

      if (!fill.ok) {
        this.throttledLog(`sellfail:${position.id}`, nowMs, 30_000, "risk", "exit sell did not fill", {
          slug: position.slug,
          reason: decision.reason,
          error: fill.message,
        });
        continue;
      }

      const proceeds = fill.shares * fill.price - fill.feeUsd;
      const pnl = proceeds - position.costUsd;
      this.closePosition(position);
      this.risk.recordClose(pnl, nowMs, this.equityUsd() + pnl);
      log("exit", "closed position", {
        slug: position.slug,
        side: position.side,
        at: fill.price,
        pnl: money(pnl),
        why: decision.reason,
      });
      this.record({
        ts: new Date(nowMs).toISOString(),
        kind: "exit",
        slug: position.slug,
        interval: position.interval,
        side: position.side,
        shares: fill.shares,
        price: fill.price,
        usd: proceeds,
        pnlUsd: pnl,
        reason: decision.reason,
        mode: this.exchange.mode,
      });
      this.journalEvent(`trade:${position.id}`, "exit", nowMs, "exit", decision.reason, {
        market,
        side: position.side,
        detail: { price: fill.price, shares: fill.shares, pnlUsd: Math.round(pnl * 100) / 100, bid },
      });
    }
  }

  private async settle(position: Position, market: MarketRef, nowMs: number): Promise<void> {
    let outcome: OutcomeSide | null = market.resolved;
    if (!outcome) {
      try {
        const fresh = await discoverMarket(this.config.asset, market.interval, market.startMs / 1000);
        if (fresh) {
          market.resolved = fresh.resolved;
          market.finalPrice = fresh.finalPrice;
          market.closed = fresh.closed;
          outcome = fresh.resolved;
        }
      } catch {
        // stay unresolved and retry on the next tick
      }
    }

    const overdueMs = nowMs - market.endMs;
    if (!outcome && overdueMs > 30 * 60 * 1000) {
      // Give up gracefully rather than drift forever, at last known bid.
      const bid = market.quotes[position.side].bid ?? 0;
      const proceeds = position.shares * bid;
      const pnl = proceeds - position.costUsd;
      this.closePosition(position);
      this.risk.recordClose(pnl, nowMs, this.equityUsd() + pnl);
      log("risk", "settled without official resolution (marked at last bid)", {
        slug: position.slug,
        bid,
        pnl: money(pnl),
      });
      this.record({
        ts: new Date(nowMs).toISOString(),
        kind: "settle",
        slug: position.slug,
        interval: position.interval,
        side: position.side,
        shares: position.shares,
        price: bid,
        pnlUsd: pnl,
        reason: "unresolved-fallback",
        mode: this.exchange.mode,
      });
      this.journalEvent(`trade:${position.id}`, "settle", nowMs, "settle", "unresolved-fallback", {
        market,
        side: position.side,
        detail: { price: bid, pnlUsd: Math.round(pnl * 100) / 100 },
      });
      return;
    }

    if (!outcome) {
      this.throttledLog(`settle:${position.id}`, nowMs, 60_000, "info", "waiting for resolution", {
        slug: position.slug,
        overdueSec: Math.round(overdueMs / 1000),
      });
      return;
    }

    const won = outcome === position.side;
    const payout = won ? position.shares : 0;
    const pnl = payout - position.costUsd;
    this.closePosition(position);
    this.risk.recordClose(pnl, nowMs, this.equityUsd() + pnl);
    log(won ? "settle" : "risk", "position resolved", {
      slug: position.slug,
      side: position.side,
      outcome,
      pnl: money(pnl),
    });
    this.record({
      ts: new Date(nowMs).toISOString(),
      kind: "settle",
      slug: position.slug,
      interval: position.interval,
      side: position.side,
      shares: position.shares,
      pnlUsd: pnl,
      reason: won ? "won" : "lost",
      mode: this.exchange.mode,
    });
    this.journalEvent(`trade:${position.id}`, "settle", nowMs, "settle", won ? "won" : "lost", {
      market,
      side: position.side,
      detail: { outcome, pnlUsd: Math.round(pnl * 100) / 100 },
    });
  }

  // ------------------------------------------------------------------ entries

  private async considerEntries(nowMs: number): Promise<void> {
    const active = this.activeMarkets(nowMs);
    const news = newsStatus(this.config.news, nowMs);
    const samples = this.feed.history();
    const volatility = volatilityPerSqrtSecond(samples, this.config.volatilityLookbackMs);
    const price = this.feed.latest()?.value ?? null;
    const equity = this.equityUsd();
    const cash = equity - this.exposureUsd();
    const hourlyRange = rangePct(samples, 60 * 60 * 1000);

    for (const market of active) {
      const context = {
        nowMs,
        market,
        anchor: this.state.anchors[market.slug] ?? null,
        price,
        samples,
        volatilityPerSqrtSec: volatility,
        newsBlocked: news.blocked,
        bankrollUsd: equity,
        cashUsd: cash,
        config: this.config,
      };
      // Always compute the numbers, even when a gate stops us early: the
      // dashboard shows what the bot was looking at, not just the verdict.
      const metrics = inspectMarket(context);

      if (this.state.positions.some((position) => position.slug === market.slug)) {
        this.note(market, metrics, { action: "blocked", reason: "position-open", detail: {} }, nowMs);
        continue;
      }

      const check = this.risk.canOpen({
        nowMs,
        equityUsd: equity,
        openPositions: this.state.positions.length,
        interval: market.interval,
        killSwitch: this.store?.killSwitchActive() ?? false,
      });
      if (!check.ok) {
        const reason = check.reason ?? "blocked";
        this.throttledLog(`risk:${reason}`, nowMs, 60_000, "risk", `entry blocked: ${reason}`, {
          ...check.detail,
          interval: market.interval,
        });
        this.note(market, metrics, { action: "blocked", reason, detail: check.detail ?? {} }, nowMs);
        continue;
      }

      const decision = evaluateEntry(context);

      if (decision.action === "skip") {
        this.throttledLog(
          `skip:${market.slug}:${decision.reason}`,
          nowMs,
          60_000,
          "skip",
          `no trade: ${decision.reason}`,
          {
            slug: market.slug,
            elapsedSec: Math.round((nowMs - market.startMs) / 1000),
            ...decision.detail,
          },
        );
        this.note(market, metrics, { action: "skip", reason: decision.reason, detail: decision.detail ?? {} }, nowMs);
        continue;
      }

      const fill = await this.exchange.buy({
        tokenId: decision.side === "Up" ? market.upTokenId : market.downTokenId,
        usd: decision.sizeUsd,
        maxPrice: decision.price,
        quote: market.quotes[decision.side],
      });

      if (!fill.ok) {
        this.throttledLog(`buyfail:${market.slug}`, nowMs, 30_000, "risk", "entry order did not fill", {
          slug: market.slug,
          side: decision.side,
          error: fill.message,
        });
        this.note(market, metrics, { action: "blocked", reason: "entry-did-not-fill", detail: { error: fill.message } }, nowMs);
        continue;
      }

      const cost = fill.shares * fill.price + fill.feeUsd;
      const position: Position = {
        id: `${market.slug}:${decision.side}:${nowMs}`,
        slug: market.slug,
        interval: market.interval,
        side: decision.side,
        tokenId: decision.side === "Up" ? market.upTokenId : market.downTokenId,
        shares: fill.shares,
        entryPrice: fill.price,
        entryFeeUsd: fill.feeUsd,
        entryAtMs: nowMs,
        costUsd: cost,
        modelProb: decision.modelProb,
        edge: decision.edge,
        endMs: market.endMs,
        stallSinceMs: null,
        orderId: fill.orderId,
      };
      this.state.positions.push(position);
      this.risk.recordOpen(market.interval);

      this.note(
        market,
        metrics,
        {
          action: "enter",
          reason: decision.reason,
          detail: {
            side: decision.side,
            shares: fill.shares,
            price: fill.price,
            usd: Math.round(cost * 100) / 100,
          },
        },
        nowMs,
      );
      this.journalEvent(`trade:${position.id}`, "entry", nowMs, "entry", decision.reason, {
        market,
        side: decision.side,
        detail: {
          price: fill.price,
          shares: fill.shares,
          usd: Math.round(cost * 100) / 100,
          modelProb: Math.round(decision.modelProb * 1000) / 1000,
          edge: Math.round(decision.edge * 1000) / 1000,
        },
      });

      log("entry", "entered position", {
        slug: market.slug,
        side: decision.side,
        price: fill.price,
        shares: fill.shares,
        usd: cost,
        p: decision.modelProb.toFixed(3),
        edge: decision.edge.toFixed(3),
        movePct: decision.movePct.toFixed(3),
      });
      this.record({
        ts: new Date(nowMs).toISOString(),
        kind: "entry",
        slug: market.slug,
        interval: market.interval,
        side: decision.side,
        shares: fill.shares,
        price: fill.price,
        usd: cost,
        reason: decision.reason,
        mode: this.exchange.mode,
        detail: {
          modelProb: decision.modelProb,
          edge: decision.edge,
          movePct: decision.movePct,
          hourlyRangePct: hourlyRange,
          anchorSource: this.state.anchors[market.slug]?.source,
        },
      });
    }
  }

  // ------------------------------------------------------------------- money

  equityUsd(): number {
    const realized = this.risk.state.realizedPnlUsd;
    let open = 0;
    for (const position of this.state.positions) {
      const market = this.markets.get(position.slug);
      const bid = market?.quotes[position.side].bid ?? null;
      open += bid === null ? position.costUsd : position.shares * bid;
    }
    return this.config.bankrollUsd + realized + open - this.state.positions.reduce((sum, p) => sum + p.costUsd, 0);
  }

  private exposureUsd(): number {
    return this.state.positions.reduce((sum, position) => sum + position.costUsd, 0);
  }

  private closePosition(position: Position): void {
    this.state.positions = this.state.positions.filter((candidate) => candidate.id !== position.id);
  }

  // ------------------------------------------------------------------ output

  private record(record_: TradeRecord): void {
    this.store?.appendTrade(record_);
  }

  private save(): void {
    if (!this.store) return;
    this.store.save(this.state);
  }

  private throttledLog(
    key: string,
    nowMs: number,
    windowMs: number,
    kind: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    const last = this.lastLogAt.get(key) ?? 0;
    if (nowMs - last < windowMs) return;
    this.lastLogAt.set(key, nowMs);
    log(kind, message, fields);
  }

  /**
   * Publishes what the bot sees right now: current windows with their gate
   * verdict, plus the risk state a dashboard needs to explain a quiet period.
   */
  private buildSnapshot(nowMs: number): BotSnapshot {
    const equity = this.equityUsd();
    const exposure = this.exposureUsd();
    const latest = this.feed.latest();
    const history = this.feed.history().filter((sample) => sample.ts >= nowMs - 15 * 60_000);
    const step = Math.max(1, Math.ceil(history.length / 120));
    const { config } = this;

    return {
      version: 1,
      mode: this.exchange.mode,
      asset: config.asset,
      updatedAt: new Date(nowMs).toISOString(),
      equityUsd: round2(equity),
      bankrollUsd: config.bankrollUsd,
      exposureUsd: round2(exposure),
      cashUsd: round2(equity - exposure),
      realizedPnlUsd: round2(this.risk.state.realizedPnlUsd),
      risk: this.risk.state,
      limits: {
        maxTradesPerDay: config.risk.maxTradesPerDay,
        maxConsecutiveLosses: config.risk.maxConsecutiveLosses,
        dailyLossLimitPct: config.risk.dailyLossLimitPct,
        maxDrawdownPct: config.risk.maxDrawdownPct,
        maxConcurrentPositions: config.risk.maxConcurrentPositions,
        minEdge: config.entry.minEdge,
        feeRate: config.entry.feeRate,
        profitTargetCents: config.exit.profitTargetCents,
      },
      killSwitch: this.store?.killSwitchActive() ?? false,
      newsBlocked: newsStatus(config.news, nowMs).blocked,
      feed: {
        price: latest?.value ?? null,
        updatedAtMs: latest?.ts ?? null,
        history: history
          .filter((_, index) => index % step === 0)
          .map((sample) => ({ ts: sample.ts, value: sample.value })),
      },
      markets: [...this.verdicts.values()]
        // Keep a closing window visible for a few seconds, then drop it so the
        // dashboard does not show dead markets next to live ones.
        .filter((view) => nowMs < view.endMs + 5_000)
        .sort((a, b) => (a.interval === b.interval ? a.startMs - b.startMs : a.interval.localeCompare(b.interval))),
      positions: this.state.positions.map((position) => {
        const market = this.markets.get(position.slug);
        const bid = market?.quotes[position.side].bid ?? null;
        const markValueUsd = bid === null ? position.shares : position.shares * bid;
        return {
          ...position,
          bid,
          markValueUsd: round2(markValueUsd),
          unrealizedPnlUsd: round2(markValueUsd - position.costUsd),
          secondsLeft: Math.max(0, Math.round((position.endMs - nowMs) / 1000)),
          stalledSec: position.stallSinceMs === null ? null : Math.round((nowMs - position.stallSinceMs) / 1000),
        };
      }),
    };
  }

  /** Stores the latest market view and journals the verdict when it changes. */
  private note(market: MarketRef, metrics: MarketMetrics, verdict: MarketView["verdict"], nowMs: number): void {
    const anchor = this.state.anchors[market.slug] ?? null;
    this.verdicts.set(market.slug, {
      slug: market.slug,
      interval: market.interval,
      startMs: market.startMs,
      endMs: market.endMs,
      price: this.feed.latest()?.value ?? null,
      anchor: anchor ? { value: anchor.value, source: anchor.source } : null,
      movePct: metrics.movePct,
      requiredMovePct: metrics.requiredMovePct,
      side: metrics.side,
      quotes: {
        Up: { bid: market.quotes.Up.bid, ask: market.quotes.Up.ask },
        Down: { bid: market.quotes.Down.bid, ask: market.quotes.Down.ask },
      },
      modelProb: metrics.modelProb,
      edge: metrics.edge,
      spreadCents: metrics.spreadCents,
      secondsRemaining: metrics.secondsRemaining,
      verdict,
    });

    if (verdict.action === "enter") return; // entries are journalled with the fill
    this.journalEvent(
      `verdict:${market.slug}`,
      `${verdict.action}:${verdict.reason}`,
      nowMs,
      verdict.action === "blocked" ? "blocked" : "skip",
      verdict.reason,
      {
        market,
        side: metrics.side ?? undefined,
        detail: {
          ...verdict.detail,
          movePct: metrics.movePct === null ? null : round3(metrics.movePct),
          modelProb: metrics.modelProb === null ? null : round3(metrics.modelProb),
          edge: metrics.edge === null ? null : round3(metrics.edge),
          spreadCents: metrics.spreadCents,
          anchorSource: anchor?.source,
        },
      },
    );
  }

  /**
   * Appends one line to the bot journal, de-duplicated by key + signature so a
   * 2-second loop records decisions that changed rather than every tick.
   */
  private journalEvent(
    key: string,
    signature: string,
    nowMs: number,
    kind: BotEvent["kind"],
    reason: string,
    fields: { market?: MarketRef; side?: OutcomeSide; detail?: Record<string, unknown> } = {},
  ): void {
    if (!this.journal) return;
    if (this.lastSignature.get(key) === signature) return;
    this.lastSignature.set(key, signature);
    this.journal.event({
      ts: new Date(nowMs).toISOString(),
      kind,
      slug: fields.market?.slug,
      interval: fields.market?.interval,
      side: fields.side,
      reason,
      detail: fields.detail,
      mode: this.exchange.mode,
    });
  }

  /** One-line status used by `scan` and the heartbeat. */
  describe(nowMs: number): void {
    for (const market of this.activeMarkets(nowMs)) {
      const anchor: Anchor | null = this.state.anchors[market.slug] ?? null;
      const price = this.feed.latest()?.value ?? 0;
      const movePct = anchor ? ((price - anchor.value) / anchor.value) * 100 : null;
      const up = market.quotes.Up;
      const down = market.quotes.Down;
      log("info", `${market.interval} ${market.slug}`, {
        elapsed: `${Math.round((nowMs - market.startMs) / 1000)}s`,
        left: `${Math.max(0, Math.round((market.endMs - nowMs) / 1000))}s`,
        price: price ? price.toFixed(2) : "n/a",
        anchor: anchor ? `${anchor.value.toFixed(2)}(${anchor.source})` : "pending",
        move: movePct === null ? "n/a" : `${movePct.toFixed(3)}%`,
        up: `${up.bid ?? "-"}/${up.ask ?? "-"}`,
        down: `${down.bid ?? "-"}/${down.ask ?? "-"}`,
      });
    }
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export { LiveExchange };
