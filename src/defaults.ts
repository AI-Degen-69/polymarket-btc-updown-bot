import type { Interval } from "./types.ts";

/**
 * Every field the dashboard may change, with hard bounds. A typo in a form must
 * never be able to disable a risk limit, so values are clamped, not trusted.
 * Shared with the web UI, which uses the same table to validate before save.
 */
export const EDITABLE: Record<string, [number, number]> = {
  bankrollUsd: [1, Number.POSITIVE_INFINITY],
  "entry.minEdge": [0, 0.9],
  "entry.minModelProb": [0.01, 0.99],
  "entry.maxModelProb": [0.01, 0.999],
  "entry.maxEntryPriceCents": [0.01, 0.99],
  "entry.minMovePct": [0, 5],
  "entry.maxMovePct": [0.01, 20],
  "entry.minHourlyRangePct": [0, 20],
  "entry.tightChopRangeUsd": [0, 10_000],
  "entry.maxSpreadCents": [0.1, 20],
  "entry.kellyCut": [0, 1],
  "entry.maxPositionPct": [0.001, 0.5],
  "entry.feeRate": [0, 0.3],
  "entry.nonLiveAnchorExtraMovePct": [0, 5],
  "entry.minPositionUsd": [1, 10_000],
  "exit.profitTargetCents": [0.2, 0.99],
  "exit.stallBandLow": [0.05, 0.95],
  "exit.stallBandHigh": [0.05, 0.99],
  "exit.acceptLossBelowCents": [0.01, 0.5],
  "exit.stopLossBelowCents": [0.01, 0.5],
  "exit.stallGraceSeconds": [0, 300],
  "risk.maxTradesPerDay": [1, 100],
  "risk.maxConsecutiveLosses": [1, 20],
  "risk.dailyLossLimitPct": [0.1, 100],
  "risk.maxDrawdownPct": [0.1, 100],
  "risk.maxConcurrentPositions": [1, 10],
  "risk.cooldownAfterLossSec": [0, 86_400],
  "news.blackoutMinutes": [0, 240],
  "intervalParams.15m.observationSeconds": [0, 840],
  "intervalParams.15m.minDirectionHoldSeconds": [0, 840],
  "intervalParams.15m.minRemainingSeconds": [30, 840],
  "intervalParams.15m.stallSeconds": [10, 840],
  "intervalParams.5m.observationSeconds": [0, 270],
  "intervalParams.5m.minDirectionHoldSeconds": [0, 270],
  "intervalParams.5m.minRemainingSeconds": [20, 280],
  "intervalParams.5m.stallSeconds": [5, 280],
};

/**
 * Single source of truth for factory defaults. Imported by the bot (config
 * loading) and by the dashboard web app (per-field reset buttons) — keep this
 * module dependency-free so the web bundle can import it directly.
 */
export const DEFAULT_CONFIG = {
  asset: "btc",
  intervals: ["15m", "5m"] as Interval[],
  bankrollUsd: 1_000,
  live: false,
  pollIntervalMs: 2_000,
  marketRefreshMs: 20_000,
  historyMs: 3 * 60 * 60 * 1000,
  volatilityLookbackMs: 10 * 60 * 1000,
  minCycleLogMs: 30_000,
  intervalParams: {
    // The guide: no entry in the first 5 minutes of a 15-minute market,
    // direction must hold 60s, and you need time left to manage the exit.
    "15m": {
      observationSeconds: 300,
      minDirectionHoldSeconds: 60,
      minRemainingSeconds: 240,
      stallSeconds: 180,
    },
    // Same rules scaled to the shorter window (the guide: same principles,
    // higher intensity, thinner edge, smaller size).
    "5m": {
      observationSeconds: 100,
      minDirectionHoldSeconds: 20,
      minRemainingSeconds: 90,
      stallSeconds: 60,
    },
  },
  entry: {
    minEdge: 0.06,
    minModelProb: 0.52,
    maxModelProb: 0.72,
    maxEntryPriceCents: 0.65,
    minMovePct: 0.05,
    maxMovePct: 0.5,
    minHourlyRangePct: 0.3,
    tightChopRangeUsd: 50,
    maxSpreadCents: 2,
    noisePct: 0.01,
    nonLiveAnchorExtraMovePct: 0.05,
    kellyCut: 0.25,
    maxPositionPct: 0.08,
    minPositionUsd: 5,
    feeRate: 0.07,
  },
  exit: {
    profitTargetCents: 0.85,
    stallBandLow: 0.6,
    stallBandHigh: 0.7,
    acceptLossBelowCents: 0.2,
    stopLossBelowCents: 0.15,
    stallGraceSeconds: 15,
  },
  risk: {
    maxConcurrentPositions: 1,
    maxTradesPerDay: 6,
    maxConsecutiveLosses: 2,
    dailyLossLimitPct: 3,
    maxDrawdownPct: 15,
    cooldownAfterLossSec: 300,
  },
  news: {
    blackoutMinutes: 15,
    events: [] as string[],
  },
  dataDir: ".state",
};
