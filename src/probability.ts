import type { PriceSample } from "./types.ts";

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 logistic-free erf approximation). */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * Realised volatility per sqrt(second) from the price series, using
 * variance-time scaling: sigma^2 = sum(r^2) / sum(dt).
 */
export function volatilityPerSqrtSecond(samples: PriceSample[], lookbackMs: number): number | null {
  if (samples.length < 20) return null;
  const cutoff = samples[samples.length - 1]!.ts - lookbackMs;
  const window = samples.filter((s) => s.ts >= cutoff);
  if (window.length < 20) return null;

  let sumSquares = 0;
  let sumDt = 0;
  for (let i = 1; i < window.length; i += 1) {
    const prev = window[i - 1]!;
    const curr = window[i]!;
    if (prev.value <= 0 || curr.value <= 0) continue;
    const dt = (curr.ts - prev.ts) / 1000;
    if (dt <= 0 || dt > 60) continue;
    const r = Math.log(curr.value / prev.value);
    sumSquares += r * r;
    sumDt += dt;
  }
  if (sumDt < 60) return null;
  return Math.sqrt(sumSquares / sumDt);
}

/** High/low range in percent over the lookback window. */
export function rangePct(samples: PriceSample[], lookbackMs: number): number | null {
  if (samples.length < 2) return null;
  const cutoff = samples[samples.length - 1]!.ts - lookbackMs;
  const window = samples.filter((s) => s.ts >= cutoff);
  if (window.length < 2) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const sample of window) {
    if (sample.value < min) min = sample.value;
    if (sample.value > max) max = sample.value;
  }
  if (!Number.isFinite(min) || min <= 0) return null;
  return ((max - min) / min) * 100;
}

/**
 * Probability that the window closes Up, modelled as driftless Brownian motion
 * in log space from the anchor: p = Phi(ln(price/anchor) / (sigma * sqrt(tau))).
 *
 * This is the "true probability" side of the guide's mispricing test: it is
 * deliberately simple and conservative (zero drift), so it only claims an edge
 * when the spot move is large relative to recent volatility and remaining time.
 */
export function upProbability(params: {
  price: number;
  anchor: number;
  volatilityPerSqrtSec: number;
  secondsRemaining: number;
  driftPerSec?: number;
}): number {
  const { price, anchor, volatilityPerSqrtSec, secondsRemaining, driftPerSec = 0 } = params;
  if (price <= 0 || anchor <= 0) return 0.5;
  const distance = Math.log(price / anchor) + driftPerSec * secondsRemaining;
  const sigma = volatilityPerSqrtSec * Math.sqrt(Math.max(secondsRemaining, 1));
  if (sigma <= 0) return distance > 0 ? 1 : 0;
  return normalCdf(distance / sigma);
}

/** Crypto category taker fee in USDC per share (fee = C * rate * p * (1 - p)). */
export function takerFeePerShare(price: number, feeRate: number): number {
  if (price <= 0 || price >= 1) return 0;
  return feeRate * price * (1 - price);
}

/** Full Kelly fraction for a binary payoff bought at `price` (payout 1 per share). */
export function kellyFraction(p: number, price: number): number {
  if (price <= 0 || price >= 1) return 0;
  const b = (1 - price) / price;
  const q = 1 - p;
  const f = (b * p - q) / b;
  return Math.min(1, Math.max(0, f));
}

/**
 * Fractional Kelly stake, capped so one trade is never a large slice of
 * bankroll and never more than the cash actually available.
 */
export function positionSizeUsd(params: {
  bankrollUsd: number;
  p: number;
  price: number;
  feeRate: number;
  kellyCut: number;
  maxPositionPct: number;
  cashUsd: number;
}): number {
  const effectivePrice = params.price + takerFeePerShare(params.price, params.feeRate);
  const fraction = kellyFraction(params.p, effectivePrice) * params.kellyCut;
  const cap = params.bankrollUsd * params.maxPositionPct;
  const raw = Math.min(params.bankrollUsd * fraction, cap, params.cashUsd);
  return Math.max(0, Math.floor(raw * 100) / 100);
}

/** Floor share counts to the 2 decimals the CLOB accepts. */
export function floorShares(shares: number): number {
  return Math.floor(shares * 100) / 100;
}
