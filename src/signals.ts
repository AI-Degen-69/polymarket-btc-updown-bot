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

/**
 * An edge this large is a model defect, not a mispricing. Live evidence: the
 * drift term priced 8c contracts at 61%, an "edge" of 53c. Real edges top out
 * near 15c. Reject instead of sizing up.
 */
const MAX_PLAUSIBLE_EDGE = 0.3;

export interface DirectionResult {
  ok: boolean;
  side: OutcomeSide;
  /** Signed distance to the win condition: negative means still the wrong side of the anchor. */
  movePct: number;
  reason?: string;
  detail?: Record<string, string | number | null>;
}

/**
 * Detects post-shakeout direction and verifies it has held for the window.
 * Supports:
 * 1. Continuation: price sustained beyond anchor on the same side.
 * 2. Reversal (guide edge): price dumped/pumped in early shakeout, stabilized,
 *    and sustained a clear counter-recovery during the hold window.
 */
export function detectDirection(params: {
  samples: PriceSample[];
  anchor: Anchor;
  price: number;
  nowMs: number;
  startMs: number;
  holdSeconds: number;
  noisePct: number;
  requiredMovePct: number;
}): DirectionResult {
  const { samples, anchor, price, nowMs, startMs, holdSeconds, noisePct, requiredMovePct } = params;
  const holdMs = holdSeconds * 1000;
  const held = samples.filter((sample) => sample.ts >= nowMs - holdMs && sample.ts <= nowMs);
  if (held.length < 3) {
    return {
      ok: false,
      side: price >= anchor.value ? "Up" : "Down",
      movePct: (Math.abs(price - anchor.value) / anchor.value) * 100,
      reason: "insufficient-samples",
      detail: { samples: held.length, needsSamples: 3 },
    };
  }

  const tolerance = Math.max(1e-9, anchor.value * (noisePct / 100));
  const allAboveAnchor = held.every((s) => s.value > anchor.value + tolerance);
  const allBelowAnchor = held.every((s) => s.value < anchor.value - tolerance);

  const shakeoutSamples = samples.filter((s) => s.ts >= startMs && s.ts < nowMs - holdMs);

  let side: OutcomeSide = price >= anchor.value ? "Up" : "Down";

  if (allAboveAnchor) {
    let maxShakeout = 0;
    for (const s of shakeoutSamples) {
      if (s.value > maxShakeout) maxShakeout = s.value;
    }
    const priorPumpPct = maxShakeout > 0 ? ((maxShakeout - anchor.value) / anchor.value) * 100 : 0;
    const isRollingDown =
      priorPumpPct >= requiredMovePct &&
      held[held.length - 1]!.value < held[0]!.value - tolerance &&
      held.every((s, i) => i === 0 || s.value <= held[0]!.value + tolerance);

    side = isRollingDown ? "Down" : "Up";
  } else if (allBelowAnchor) {
    let minShakeout = Number.POSITIVE_INFINITY;
    for (const s of shakeoutSamples) {
      if (s.value < minShakeout) minShakeout = s.value;
    }
    const priorDumpPct = Number.isFinite(minShakeout) ? ((anchor.value - minShakeout) / anchor.value) * 100 : 0;
    const isRecoveringUp =
      priorDumpPct >= requiredMovePct &&
      held[held.length - 1]!.value > held[0]!.value + tolerance &&
      held.every((s, i) => i === 0 || s.value >= held[0]!.value - tolerance);

    side = isRecoveringUp ? "Up" : "Down";
  } else {
    return {
      ok: false,
      side,
      movePct: (Math.abs(price - anchor.value) / anchor.value) * 100,
      reason: "direction-not-held",
      detail: { samples: held.length },
    };
  }

  // Distance to the win condition, not rally size off the shakeout extreme: a
  // reversal entry still on the far side of the anchor is a negative move and
  // must fail the min-move gate. shortcut: needs an EV model to trade the
  // pre-cross reversal the guide describes.
  const movePct =
    side === "Up" ? ((price - anchor.value) / anchor.value) * 100 : ((anchor.value - price) / anchor.value) * 100;

  return { ok: true, side, movePct };
}

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
    return {
      action: "skip",
      reason: "too-late-in-window",
      detail: { remainingSec: Math.floor(remainingSec), needsSec: params.minRemainingSeconds },
    };
  }
  if (!anchor) return { action: "skip", reason: "no-anchor" };
  if (price === null || price <= 0) return { action: "skip", reason: "no-price", detail: { price } };

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
    return {
      action: "skip",
      reason: "low-volatility-grind",
      detail: { hourlyRangePct: round(hourly), needsPct: config.entry.minHourlyRangePct },
    };
  }

  // Tight chop filter (guide rule 3): if price oscillates in a tight $50 corridor
  // with no trend across the observation period, false signals dominate.
  // Gated by enoughHistory so a freshly started bot doesn't skip immediately.
  if (enoughHistory) {
    const obsCutoff = Math.max(market.startMs, ctx.nowMs - params.observationSeconds * 1000);
    const obsSamples = ctx.samples.filter((s) => s.ts >= obsCutoff && s.ts <= ctx.nowMs);
    if (obsSamples.length >= 3) {
      let minPrice = Number.POSITIVE_INFINITY;
      let maxPrice = 0;
      for (const s of obsSamples) {
        if (s.value < minPrice) minPrice = s.value;
        if (s.value > maxPrice) maxPrice = s.value;
      }
      const obsRangeUsd = maxPrice - minPrice;
      if (obsRangeUsd < config.entry.tightChopRangeUsd) {
        return {
          action: "skip",
          reason: "tight-chop-no-trend",
          detail: { obsRangeUsd: round(obsRangeUsd), minRangeUsd: config.entry.tightChopRangeUsd },
        };
      }
    }
  }

  const requiredMove =
    config.entry.minMovePct + (anchor.source === "live" ? 0 : config.entry.nonLiveAnchorExtraMovePct);

  // Rule 2a: detect post-shakeout direction (continuation or reversal) and ensure it held for the window.
  const dir = detectDirection({
    samples: ctx.samples,
    anchor,
    price,
    nowMs: ctx.nowMs,
    startMs: market.startMs,
    holdSeconds: params.minDirectionHoldSeconds,
    noisePct: config.entry.noisePct,
    requiredMovePct: requiredMove,
  });

  if (!dir.ok) {
    return { action: "skip", reason: dir.reason ?? "direction-not-held", detail: dir.detail };
  }

  const { side, movePct } = dir;

  if (movePct < requiredMove) {
    return { action: "skip", reason: "move-too-small", detail: { movePct: round4(movePct), needsPct: requiredMove } };
  }
  // Don't chase: by the time it moved this far the odds have corrected.
  if (movePct > config.entry.maxMovePct) {
    return {
      action: "skip",
      reason: "chasing-move",
      detail: { movePct: round4(movePct), maxPct: config.entry.maxMovePct },
    };
  }

  const quote = market.quotes[side];
  if (quote.ask === null || quote.bid === null) {
    return { action: "skip", reason: "no-liquidity", detail: { side } };
  }
  // Compare in cents and round away float noise: 0.62 - 0.60 is
  // 0.020000000000000018, which would otherwise reject a legitimate 2c spread.
  const spreadCents = Number(((quote.ask - quote.bid) * 100).toFixed(4));
  if (spreadCents > config.entry.maxSpreadCents) {
    return {
      action: "skip",
      reason: "spread-too-wide",
      detail: { spreadCents, maxCents: config.entry.maxSpreadCents },
    };
  }
  if (quote.ask > config.entry.maxEntryPriceCents) {
    return {
      action: "skip",
      reason: "odds-too-expensive",
      detail: { ask: quote.ask, maxAsk: config.entry.maxEntryPriceCents },
    };
  }

  // Rule 2b: the odds must still lag the move.
  if (!ctx.volatilityPerSqrtSec) return { action: "skip", reason: "no-volatility" };
  // No drift term: a 60s slope projected over the remaining minutes swamped the
  // real distance-to-anchor and priced 8c underdogs at 61%.
  const pUp = upProbability({
    price,
    anchor: anchor.value,
    volatilityPerSqrtSec: ctx.volatilityPerSqrtSec,
    secondsRemaining: remainingSec,
  });
  const modelProb = side === "Up" ? pUp : 1 - pUp;

  if (modelProb < config.entry.minModelProb) {
    return {
      action: "skip",
      reason: "model-prob-too-low",
      detail: { modelProb: round(modelProb, 3), minProb: config.entry.minModelProb },
    };
  }
  if (modelProb > config.entry.maxModelProb) {
    return {
      action: "skip",
      reason: "model-prob-too-high",
      detail: { modelProb: round(modelProb, 3), maxProb: config.entry.maxModelProb },
    };
  }

  const edge = modelProb - quote.ask - takerFeePerShare(quote.ask, config.entry.feeRate);
  if (edge > MAX_PLAUSIBLE_EDGE) {
    return {
      action: "skip",
      reason: "model-edge-outlier",
      detail: { edge: round(edge, 3), ask: quote.ask, maxEdge: MAX_PLAUSIBLE_EDGE },
    };
  }
  if (edge < config.entry.minEdge) {
    return {
      action: "skip",
      reason: "no-mispricing-edge",
      detail: { edge: round(edge, 3), ask: quote.ask, minEdge: config.entry.minEdge },
    };
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
  | { action: "sell"; reason: string; minPrice: number; stallSinceMs: number | null; stallLeftBandSinceMs?: number | null }
  | { action: "hold"; reason: string; stallSinceMs: number | null; stallLeftBandSinceMs?: number | null };

/**
 * The guide's mechanical exit table: lock profit at 85-90c, sell if odds stall
 * at 60-70c for 3+ minutes, hold small reversals, hold at <=20c and take the
 * loss at resolution, and leave immediately on news.
 *
 * Includes a grace window (default 15s) so single-tick CLOB bid flickers
 * outside 60-70c do not instantly wipe the stall counter.
 */
export function evaluateExit(ctx: ExitContext): ExitDecision {
  const { position, bid, config } = ctx;
  const params = paramsFor(config, position.interval);
  let stallSinceMs = position.stallSinceMs;
  let stallLeftBandSinceMs = position.stallLeftBandSinceMs ?? null;

  if (ctx.newsBlocked) {
    return { action: "sell", reason: "news-invalidated-thesis", minPrice: bid ?? 0.01, stallSinceMs, stallLeftBandSinceMs };
  }
  if (bid === null) return { action: "hold", reason: "no-bid", stallSinceMs, stallLeftBandSinceMs };

  if (bid >= config.exit.profitTargetCents) {
    return { action: "sell", reason: "profit-target-hit", minPrice: round4(bid), stallSinceMs, stallLeftBandSinceMs };
  }

  if (bid <= config.exit.acceptLossBelowCents) {
    // Selling here would lock the loss; the guide holds for resolution.
    return { action: "hold", reason: "accept-loss-at-resolution", stallSinceMs, stallLeftBandSinceMs };
  }

  const inStallBand = bid >= config.exit.stallBandLow && bid <= config.exit.stallBandHigh;
  if (!inStallBand) {
    if (stallSinceMs !== null) {
      // We were previously stalling. Apply grace period before wiping stallSinceMs.
      stallLeftBandSinceMs = stallLeftBandSinceMs ?? ctx.nowMs;
      const graceMs = (config.exit.stallGraceSeconds ?? 15) * 1000;
      if (ctx.nowMs - stallLeftBandSinceMs < graceMs) {
        // Within grace window: keep stallSinceMs active
        return { action: "hold", reason: "stalled-but-waiting", stallSinceMs, stallLeftBandSinceMs };
      }
    }
    // Grace expired or never stalled
    stallSinceMs = null;
    stallLeftBandSinceMs = null;
    return { action: "hold", reason: "thesis-intact", stallSinceMs, stallLeftBandSinceMs };
  }

  // Inside stall band: clear any left-band timestamp
  stallLeftBandSinceMs = null;
  stallSinceMs = stallSinceMs ?? ctx.nowMs;
  const stalledMs = ctx.nowMs - stallSinceMs;
  if (stalledMs >= params.stallSeconds * 1000) {
    return { action: "sell", reason: "odds-stalled", minPrice: round4(bid), stallSinceMs, stallLeftBandSinceMs };
  }
  return { action: "hold", reason: "stalled-but-waiting", stallSinceMs, stallLeftBandSinceMs };
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

  if (!anchor || price === null || !ctx.volatilityPerSqrtSec) {
    const side = anchor && price !== null ? (price >= anchor.value ? "Up" : "Down") : null;
    const movePct = anchor && price !== null ? (Math.abs(price - anchor.value) / anchor.value) * 100 : null;
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

  const dir = detectDirection({
    samples: ctx.samples,
    anchor,
    price,
    nowMs: ctx.nowMs,
    startMs: market.startMs,
    holdSeconds: config.intervalParams[market.interval].minDirectionHoldSeconds,
    noisePct: config.entry.noisePct,
    requiredMovePct,
  });

  const side = dir.side;
  const movePct = dir.movePct;
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
