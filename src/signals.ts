import { intervalSeconds } from "./config.ts";
import type { BotConfig, IntervalParams } from "./config.ts";
import { positionSizeUsd, rangePct, takerFeePerShare, upProbability } from "./probability.ts";
import { floorShares } from "./probability.ts";
import type { Anchor, Interval, MarketRef, OutcomeSide, Position, PriceSample } from "./types.ts";

export interface EntryContext {
  nowMs: number;
  market: MarketRef;
  anchor: Anchor | null;
  price: number | null;
  samples: PriceSample[];
  volatilityPerSqrtSec: number | null;
  newsBlocked: boolean;
  bankrollUsd: number;
  cashUsd: number;
  config: BotConfig;
}

export type EntryDecision =
  | {
      action: "enter";
      side: OutcomeSide;
      price: number;
      shares: number;
      sizeUsd: number;
      modelProb: number;
      edge: number;
      movePct: number;
      reason: string;
    }
  | { action: "skip"; reason: string; detail?: Record<string, number | string | null> };

function paramsFor(config: BotConfig, interval: Interval): IntervalParams {
  return config.intervalParams[interval];
}

/** The 1-hour range filter needs at least this much sampled history to be meaningful. */
const CHOP_FILTER_MIN_COVERAGE_MS = 15 * 60 * 1000;

/** Chapter 2 of the guide, in code: observation, held direction, mispricing. */
export function evaluateEntry(ctx: EntryContext): EntryDecision {
  const { market, anchor, price, config } = ctx;
  const params = paramsFor(config, market.interval);

  if (!market.acceptingOrders || market.closed) return { action: "skip", reason: "market-not-open" };

  const elapsedSec = (ctx.nowMs - market.startMs) / 1000;
  const remainingSec = (market.endMs - ctx.nowMs) / 1000;

  // Rule 1: no entry in the first 5 minutes of a 15-minute market.
  if (elapsedSec < params.observationSeconds) {
    return {
      action: "skip",
      reason: "observation-window",
      detail: { elapsedSec: Math.round(elapsedSec), needsSec: params.observationSeconds },
    };
  }
  if (remainingSec < params.minRemainingSeconds) {
    return { action: "skip", reason: "too-late-in-window", detail: { remainingSec: Math.round(remainingSec) } };
  }
  if (!anchor) return { action: "skip", reason: "no-anchor" };
  if (price === null || price <= 0) return { action: "skip", reason: "no-price" };

  // Rule 3: no scheduled news inside the blackout window.
  if (ctx.newsBlocked) return { action: "skip", reason: "news-blackout" };

  // Sit out low-volatility grind sessions: no shakeout, no trapped money.
  // Only judge this once we actually hold enough history — otherwise a freshly
  // started bot would read a zero range and skip every window.
  const hourly = rangePct(ctx.samples, 60 * 60 * 1000);
  const coverageMs =
    ctx.samples.length >= 2 ? ctx.samples[ctx.samples.length - 1]!.ts - ctx.samples[0]!.ts : 0;
  const enoughHistory = coverageMs >= CHOP_FILTER_MIN_COVERAGE_MS;
  if (hourly !== null && enoughHistory && hourly < config.entry.minHourlyRangePct) {
    return { action: "skip", reason: "low-volatility-grind", detail: { hourlyRangePct: round(hourly) } };
  }

  const side: OutcomeSide = price >= anchor.value ? "Up" : "Down";

  // Rule 2a: the post-shakeout direction has to hold for the whole window.
  const holdMs = params.minDirectionHoldSeconds * 1000;
  const held = ctx.samples.filter((sample) => sample.ts >= ctx.nowMs - holdMs);
  if (held.length < 3) return { action: "skip", reason: "insufficient-samples" };

  const tolerance = Math.max(1e-9, anchor.value * (config.entry.noisePct / 100));
  for (const sample of held) {
    const stillUp = sample.value > anchor.value + tolerance;
    const stillDown = sample.value < anchor.value - tolerance;
    if (side === "Up" ? !stillUp : !stillDown) {
      return { action: "skip", reason: "direction-not-held", detail: { samples: held.length } };
    }
  }

  const movePct = (Math.abs(price - anchor.value) / anchor.value) * 100;
  // A recovered or published anchor is less precise than our own live sample,
  // so demand more move before calling the direction real.
  const requiredMove =
    config.entry.minMovePct + (anchor.source === "live" ? 0 : config.entry.nonLiveAnchorExtraMovePct);
  if (movePct < requiredMove) {
    return { action: "skip", reason: "move-too-small", detail: { movePct: round(movePct), needsPct: requiredMove } };
  }
  // Don't chase: by the time it moved this far the odds have corrected.
  if (movePct > config.entry.maxMovePct) {
    return { action: "skip", reason: "chasing-move", detail: { movePct: round(movePct) } };
  }

  const quote = market.quotes[side];
  if (quote.ask === null || quote.bid === null) return { action: "skip", reason: "no-liquidity" };
  // Compare in cents and round away float noise: 0.62 - 0.60 is
  // 0.020000000000000018, which would otherwise reject a legitimate 2c spread.
  const spreadCents = Number(((quote.ask - quote.bid) * 100).toFixed(4));
  if (spreadCents > config.entry.maxSpreadCents) {
    return { action: "skip", reason: "spread-too-wide", detail: { spreadCents } };
  }
  if (quote.ask > config.entry.maxEntryPriceCents) {
    return { action: "skip", reason: "odds-too-expensive", detail: { ask: quote.ask } };
  }

  // Rule 2b: the odds must still lag the move.
  if (!ctx.volatilityPerSqrtSec) return { action: "skip", reason: "no-volatility" };
  const pUp = upProbability({
    price,
    anchor: anchor.value,
    volatilityPerSqrtSec: ctx.volatilityPerSqrtSec,
    secondsRemaining: remainingSec,
  });
  const modelProb = side === "Up" ? pUp : 1 - pUp;

  if (modelProb < config.entry.minModelProb) {
    return { action: "skip", reason: "model-prob-too-low", detail: { modelProb: round(modelProb, 3) } };
  }
  if (modelProb > config.entry.maxModelProb) {
    return { action: "skip", reason: "model-prob-too-high", detail: { modelProb: round(modelProb, 3) } };
  }

  const edge = modelProb - quote.ask - takerFeePerShare(quote.ask, config.entry.feeRate);
  if (edge < config.entry.minEdge) {
    return { action: "skip", reason: "no-mispricing-edge", detail: { edge: round(edge, 3), ask: quote.ask } };
  }

  const sizeUsd = positionSizeUsd({
    bankrollUsd: ctx.bankrollUsd,
    p: modelProb,
    price: quote.ask,
    feeRate: config.entry.feeRate,
    kellyCut: config.entry.kellyCut,
    maxPositionPct: config.entry.maxPositionPct,
    cashUsd: ctx.cashUsd,
  });
  const shares = floorShares(sizeUsd / quote.ask);
  if (sizeUsd < config.entry.minPositionUsd || shares < market.minOrderSize) {
    return {
      action: "skip",
      reason: "below-min-order-size",
      detail: { shares, minShares: market.minOrderSize, sizeUsd: round(sizeUsd) },
    };
  }

  return {
    action: "enter",
    side,
    price: quote.ask,
    shares,
    sizeUsd: round(shares * quote.ask),
    modelProb,
    edge,
    movePct,
    reason: "confirmed-mispricing",
  };
}

export interface ExitContext {
  nowMs: number;
  position: Position;
  bid: number | null;
  newsBlocked: boolean;
  config: BotConfig;
}

export type ExitDecision =
  | { action: "sell"; reason: string; minPrice: number; stallSinceMs: number | null }
  | { action: "hold"; reason: string; stallSinceMs: number | null };

/**
 * The guide's mechanical exit table: lock profit at 85-90c, sell if odds stall
 * at 60-70c for 3+ minutes, hold small reversals, hold at <=20c and take the
 * loss at resolution, and leave immediately on news.
 */
export function evaluateExit(ctx: ExitContext): ExitDecision {
  const { position, bid, config } = ctx;
  const params = paramsFor(config, position.interval);
  let stallSinceMs = position.stallSinceMs;

  if (ctx.newsBlocked) {
    return { action: "sell", reason: "news-invalidated-thesis", minPrice: bid ?? 0.01, stallSinceMs };
  }
  if (bid === null) return { action: "hold", reason: "no-bid", stallSinceMs };

  if (bid >= config.exit.profitTargetCents) {
    return { action: "sell", reason: "profit-target-hit", minPrice: round4(bid), stallSinceMs };
  }

  if (bid <= config.exit.acceptLossBelowCents) {
    // Selling here would lock the loss; the guide holds for resolution.
    return { action: "hold", reason: "accept-loss-at-resolution", stallSinceMs };
  }

  const inStallBand = bid >= config.exit.stallBandLow && bid <= config.exit.stallBandHigh;
  if (!inStallBand) {
    stallSinceMs = null;
    return { action: "hold", reason: "thesis-intact", stallSinceMs };
  }

  stallSinceMs = stallSinceMs ?? ctx.nowMs;
  const stalledMs = ctx.nowMs - stallSinceMs;
  if (stalledMs >= params.stallSeconds * 1000) {
    return { action: "sell", reason: "odds-stalled", minPrice: round4(bid), stallSinceMs };
  }
  return { action: "hold", reason: "stalled-but-waiting", stallSinceMs };
}

export function secondsLeft(market: MarketRef, nowMs: number): number {
  return (market.endMs - nowMs) / 1000;
}

export function windowProgress(market: MarketRef, nowMs: number): number {
  const total = intervalSeconds(market.interval) * 1000;
  return Math.min(1, Math.max(0, (nowMs - market.startMs) / total));
}

/**
 * The numbers behind an entry decision, computed even when the gate stops
 * earlier so the dashboard can show what the bot was looking at.
 */
export interface MarketMetrics {
  side: OutcomeSide | null;
  movePct: number | null;
  requiredMovePct: number;
  modelProb: number | null;
  edge: number | null;
  spreadCents: number | null;
  secondsRemaining: number;
}

export function inspectMarket(ctx: EntryContext): MarketMetrics {
  const { market, anchor, price, config } = ctx;
  const secondsRemaining = (market.endMs - ctx.nowMs) / 1000;
  const requiredMovePct =
    config.entry.minMovePct + (anchor && anchor.source !== "live" ? config.entry.nonLiveAnchorExtraMovePct : 0);

  const side: OutcomeSide | null = anchor && price !== null ? (price >= anchor.value ? "Up" : "Down") : null;
  const movePct = anchor && price !== null ? (Math.abs(price - anchor.value) / anchor.value) * 100 : null;

  if (!side || !anchor || price === null || !ctx.volatilityPerSqrtSec) {
    return {
      side,
      movePct,
      requiredMovePct,
      modelProb: null,
      edge: null,
      spreadCents: null,
      secondsRemaining,
    };
  }

  const quote = market.quotes[side];
  const spreadCents =
    quote.ask !== null && quote.bid !== null ? Number(((quote.ask - quote.bid) * 100).toFixed(4)) : null;
  const pUp = upProbability({
    price,
    anchor: anchor.value,
    volatilityPerSqrtSec: ctx.volatilityPerSqrtSec,
    secondsRemaining,
  });
  const modelProb = side === "Up" ? pUp : 1 - pUp;
  const edge = quote.ask === null ? null : modelProb - quote.ask - takerFeePerShare(quote.ask, config.entry.feeRate);

  return { side, movePct, requiredMovePct, modelProb, edge, spreadCents, secondsRemaining };
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function round4(value: number): number {
  return round(value, 4);
}
