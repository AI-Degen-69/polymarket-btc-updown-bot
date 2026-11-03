import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../src/state.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { newsStatus } from "../src/news.ts";
import { kellyFraction, normalCdf, positionSizeUsd, upProbability } from "../src/probability.ts";
import { freshRiskState, RiskManager } from "../src/risk.ts";
import { evaluateEntry, evaluateExit, inspectMarket } from "../src/signals.ts";
import type { MarketRef, Position, PriceSample } from "../src/types.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const config = () => structuredClone(DEFAULT_CONFIG);

function market(overrides: Partial<MarketRef> = {}): MarketRef {
  return {
    asset: "btc",
    interval: "15m",
    slug: "btc-updown-15m-1",
    eventId: "e1",
    marketId: "m1",
    conditionId: "0xabc",
    upTokenId: "up-token",
    downTokenId: "down-token",
    startMs: NOW - 360_000,
    endMs: NOW + 540_000,
    publishedPriceToBeat: 100_000,
    finalPrice: null,
    tickSize: 0.01,
    minOrderSize: 5,
    acceptingOrders: true,
    closed: false,
    quotes: {
      Up: { bid: 0.39, ask: 0.4, bidSize: 500, askSize: 500 },
      Down: { bid: 0.59, ask: 0.6, bidSize: 500, askSize: 500 },
    },
    resolved: null,
    fetchedAtMs: NOW,
    ...overrides,
  };
}

/** Drifted history: quiet at ~99,600 for a while, then a steady climb to 100,060. */
function samples(price = 100_060): PriceSample[] {
  const out: PriceSample[] = [];
  const count = 300;
  for (let i = 0; i < count; i += 1) {
    const ts = NOW - (count - i) * 2_000;
    const value = i < 180 ? 99_600 + i * 2 : price;
    out.push({ ts, value });
  }
  return out;
}

/** A dead-flat tape: enough to judge chop only once it spans 15+ minutes. */
function flatSamples(spanMs: number, stepMs = 2_000): PriceSample[] {
  const count = Math.floor(spanMs / stepMs);
  return Array.from({ length: count }, (_, index) => ({ ts: NOW - spanMs + index * stepMs, value: 100_060 }));
}

function entryContext(overrides: Record<string, unknown> = {}) {
  return {
    nowMs: NOW,
    market: market(),
    anchor: { value: 100_000, source: "live" as const, capturedAtMs: NOW - 360_000 },
    price: 100_060,
    samples: samples(),
    volatilityPerSqrtSec: 5e-5,
    newsBlocked: false,
    bankrollUsd: 1_000,
    cashUsd: 1_000,
    config: config(),
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: "p1",
    slug: "btc-updown-15m-1",
    interval: "15m",
    side: "Up",
    tokenId: "up-token",
    shares: 100,
    entryPrice: 0.4,
    entryFeeUsd: 1.68,
    entryAtMs: NOW - 60_000,
    costUsd: 41.68,
    modelProb: 0.7,
    edge: 0.28,
    endMs: NOW + 540_000,
    stallSinceMs: null,
    ...overrides,
  };
}

describe("probability model", () => {
  test("normal cdf matches known quantiles", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  test("zero distance is a coin flip, positive distance favours Up", () => {
    expect(upProbability({ price: 100, anchor: 100, volatilityPerSqrtSec: 1e-4, secondsRemaining: 300 })).toBeCloseTo(
      0.5,
      6,
    );
    const p = upProbability({ price: 100.1, anchor: 100, volatilityPerSqrtSec: 1e-4, secondsRemaining: 300 });
    expect(p).toBeGreaterThan(0.5);
    expect(p).toBeLessThanOrEqual(1);
  });

  test("kelly is zero without edge and positive with it", () => {
    expect(kellyFraction(0.3, 0.5)).toBe(0);
    expect(kellyFraction(0.7, 0.4)).toBeGreaterThan(0);
    expect(kellyFraction(0.99, 0.01)).toBeLessThanOrEqual(1);
  });

  test("position size respects the bankroll cap and available cash", () => {
    const base = {
      bankrollUsd: 1_000,
      p: 0.7,
      price: 0.4,
      feeRate: 0.07,
      kellyCut: 0.25,
      maxPositionPct: 0.08,
      cashUsd: 1_000,
    };
    expect(positionSizeUsd(base)).toBeLessThanOrEqual(80);
    expect(positionSizeUsd({ ...base, cashUsd: 12 })).toBeLessThanOrEqual(12);
  });
});

describe("entry rules", () => {
  test("enters when the shakeout resolved into a confirmed edge", () => {
    const decision = evaluateEntry(entryContext());
    expect(decision.action).toBe("enter");
    if (decision.action !== "enter") throw new Error("expected entry");
    expect(decision.side).toBe("Up");
    expect(decision.edge).toBeGreaterThan(0.06);
    expect(decision.shares).toBeGreaterThanOrEqual(5);
  });

  test("inspectMarket reports the same probability the gate used", () => {
    const ctx = entryContext();
    const metrics = inspectMarket(ctx);
    const decision = evaluateEntry(ctx);
    expect(metrics.side).toBe("Up");
    expect(metrics.modelProb).toBeGreaterThan(0.5);
    expect(metrics.edge).toBeGreaterThan(0.06);
    if (decision.action !== "enter") throw new Error("expected entry");
    expect(decision.modelProb).toBeCloseTo(metrics.modelProb!, 6);
    expect(decision.edge).toBeCloseTo(metrics.edge!, 6);
  });

  test("no entry inside the first five minutes", () => {
    const decision = evaluateEntry(entryContext({ market: market({ startMs: NOW - 120_000 }) }));
    expect(decision).toEqual(expect.objectContaining({ action: "skip", reason: "observation-window" }));
  });

  test("refuses a direction that has not held for 60 seconds", () => {
    const unstable = samples().map((sample, index, all) =>
      index === all.length - 5 ? { ts: sample.ts, value: 99_990 } : sample,
    );
    const decision = evaluateEntry(entryContext({ samples: unstable }));
    expect(decision).toEqual(expect.objectContaining({ action: "skip", reason: "direction-not-held" }));
  });

  test("refuses to chase a 1% move", () => {
    const decision = evaluateEntry(entryContext({ price: 101_000, samples: samples(101_000) }));
    expect(decision).toEqual(expect.objectContaining({ action: "skip", reason: "chasing-move" }));
  });

  test("sits out a low volatility grind", () => {
    const decision = evaluateEntry(entryContext({ samples: flatSamples(20 * 60_000) }));
    expect(decision).toEqual(expect.objectContaining({ action: "skip", reason: "low-volatility-grind" }));
  });

  test("does not mistake a freshly started feed for a dead market", () => {
    const decision = evaluateEntry(entryContext({ samples: flatSamples(5 * 60_000) }));
    expect(decision.action).toBe("enter");
  });

  test("demands more move when the anchor was not captured live", () => {
    const decision = evaluateEntry(
      entryContext({ anchor: { value: 100_000, source: "history" as const, capturedAtMs: NOW } }),
    );
    expect(decision).toEqual(expect.objectContaining({ action: "skip", reason: "move-too-small" }));
  });

  test("refuses a wide spread", () => {
    const wide = market({ quotes: { Up: { bid: 0.34, ask: 0.4, bidSize: 500, askSize: 500 }, Down: market().quotes.Down } });
    const decision = evaluateEntry(entryContext({ market: wide }));
    expect(decision).toEqual(expect.objectContaining({ action: "skip", reason: "spread-too-wide" }));
  });

  test("does not reject a 2-cent spread over float noise", () => {
    const tight = market({
      quotes: { Up: { bid: 0.6, ask: 0.62, bidSize: 500, askSize: 500 }, Down: market().quotes.Down },
    });
    const decision = evaluateEntry(entryContext({ market: tight }));
    expect(decision.action === "skip" && decision.reason === "spread-too-wide").toBe(false);
  });

  test("refuses when the odds already corrected", () => {
    const corrected = market({
      quotes: { Up: { bid: 0.65, ask: 0.66, bidSize: 500, askSize: 500 }, Down: market().quotes.Down },
    });
    const cfg = config();
    cfg.entry.maxEntryPriceCents = 0.9;
    const decision = evaluateEntry(entryContext({ market: corrected, config: cfg }));
    expect(decision).toEqual(expect.objectContaining({ action: "skip", reason: "no-mispricing-edge" }));
  });

  test("stays out around scheduled news", () => {
    const decision = evaluateEntry(entryContext({ newsBlocked: true }));
    expect(decision).toEqual(expect.objectContaining({ action: "skip", reason: "news-blackout" }));
  });
});

describe("exit rules", () => {
  const ctx = (bid: number | null, overrides: Partial<Position> = {}, newsBlocked = false) => ({
    nowMs: NOW,
    position: position(overrides),
    bid,
    newsBlocked,
    config: config(),
  });

  test("locks profit at 85c", () => {
    expect(evaluateExit(ctx(0.86))).toEqual(expect.objectContaining({ action: "sell", reason: "profit-target-hit" }));
  });

  test("holds small reversals", () => {
    expect(evaluateExit(ctx(0.55))).toEqual(expect.objectContaining({ action: "hold", reason: "thesis-intact" }));
  });

  test("holds at 20c and accepts the loss at resolution", () => {
    expect(evaluateExit(ctx(0.15))).toEqual(
      expect.objectContaining({ action: "hold", reason: "accept-loss-at-resolution" }),
    );
  });

  test("sells a trade stalled at 60-70c for three minutes", () => {
    expect(evaluateExit(ctx(0.65, { stallSinceMs: NOW - 200_000 }))).toEqual(
      expect.objectContaining({ action: "sell", reason: "odds-stalled" }),
    );
    const fresh = evaluateExit(ctx(0.65, { stallSinceMs: null }));
    expect(fresh.action).toBe("hold");
    if (fresh.action === "hold") expect(fresh.stallSinceMs).toBe(NOW);
  });

  test("leaves immediately on news", () => {
    expect(evaluateExit(ctx(0.5, {}, true))).toEqual(
      expect.objectContaining({ action: "sell", reason: "news-invalidated-thesis" }),
    );
  });
});

describe("risk manager", () => {
  const manager = () => new RiskManager(freshRiskState("2026-11-03", 1_000), config().risk);

  test("caps trades per day", () => {
    const risk = manager();
    risk.state.tradesToday = 6;
    const check = risk.canOpen({ nowMs: NOW, equityUsd: 1_000, openPositions: 0, interval: "15m" });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("max-trades-per-day");
  });

  test("halts after two consecutive losses and honours the cooldown", () => {
    const risk = manager();
    risk.recordClose(-10, NOW, 990);
    const afterFirst = risk.canOpen({ nowMs: NOW + 1_000, equityUsd: 990, openPositions: 0, interval: "15m" });
    expect(afterFirst.reason).toBe("cooldown");

    risk.recordClose(-10, NOW + 400_000, 980);
    expect(risk.state.halted).toBe(true);
    expect(risk.state.haltReason).toContain("consecutive-losses");
  });

  test("halts on the daily loss limit", () => {
    const risk = manager();
    const check = risk.canOpen({ nowMs: NOW, equityUsd: 960, openPositions: 0, interval: "15m" });
    expect(check.ok).toBe(false);
    expect(risk.state.halted).toBe(true);
  });

  test("resets counters on a new UTC day", () => {
    const risk = manager();
    risk.state.tradesToday = 5;
    risk.recordClose(-10, NOW, 990);
    const rolled = risk.rollDay(NOW + 86_400_000, 990);
    expect(rolled).toBe(true);
    expect(risk.state.tradesToday).toBe(0);
    expect(risk.state.halted).toBe(false);
  });
});

describe("reset", () => {
  test("wipes positions, trades and counters back to the starting bankroll", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "bot-reset-")));
    const state = store.load(1_000);
    state.risk.tradesToday = 4;
    state.risk.realizedPnlUsd = -37;
    state.positions.push(position());
    store.save(state);
    store.appendTrade({ ts: new Date().toISOString(), kind: "entry", slug: "btc-updown-15m-1", shares: 10, price: 0.4 });

    store.reset(1_000);
    const fresh = store.load(1_000);

    expect(fresh.positions).toHaveLength(0);
    expect(fresh.risk.tradesToday).toBe(0);
    expect(fresh.risk.realizedPnlUsd).toBe(0);
    expect(fresh.bankrollUsd).toBe(1_000);
    expect(existsSync(store.tradesPath)).toBe(false);
    // The marker tells a running engine to reload its in-memory state.
    expect(existsSync(store.resetMarkerPath)).toBe(true);
  });
});

describe("news blackout", () => {
  test("blocks 15 minutes either side of an event", () => {
    const events = { blackoutMinutes: 15, events: ["2026-11-03T12:05:00Z"] };
    expect(newsStatus(events, NOW).blocked).toBe(true);
    expect(newsStatus(events, NOW + 60 * 60_000).blocked).toBe(false);
  });
});
