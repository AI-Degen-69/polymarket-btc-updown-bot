export type Interval = "5m" | "15m";
export type OutcomeSide = "Up" | "Down";

export interface PriceSample {
  /** Unix ms when the sample was taken. */
  ts: number;
  /** Reference price in USD. */
  value: number;
}

export interface BookQuote {
  bid: number | null;
  ask: number | null;
  bidSize: number;
  askSize: number;
}

/** A concrete Polymarket "Bitcoin Up or Down" window. */
export interface MarketRef {
  asset: string;
  interval: Interval;
  slug: string;
  eventId: string;
  marketId: string;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  /** Window open, derived from the slug timestamp (aligned epoch seconds). */
  startMs: number;
  /** Window close / resolution time. */
  endMs: number;
  /** Chainlink price published by the market, when available. */
  publishedPriceToBeat: number | null;
  finalPrice: number | null;
  tickSize: number;
  minOrderSize: number;
  acceptingOrders: boolean;
  closed: boolean;
  quotes: Record<OutcomeSide, BookQuote>;
  resolved: OutcomeSide | null;
  fetchedAtMs: number;
}

/**
 * The price the market is measured against.
 * `live` means we captured our own feed at window open (unbiased for our model);
 * `history` means we recovered it from 1-minute candles when the bot started
 * mid-window; `published` means Gamma's Chainlink priceToBeat, which carries a
 * venue basis. Non-live anchors demand a larger move before entry.
 */
export interface Anchor {
  value: number;
  source: "live" | "history" | "published";
  capturedAtMs: number;
}

export interface Position {
  id: string;
  slug: string;
  interval: Interval;
  side: OutcomeSide;
  tokenId: string;
  shares: number;
  entryPrice: number;
  entryFeeUsd: number;
  entryAtMs: number;
  costUsd: number;
  modelProb: number;
  edge: number;
  endMs: number;
  /** First time the odds sat inside the stall band, used for the 3-minute stall rule. */
  stallSinceMs: number | null;
  /** When odds temporarily drifted outside stall band, used for the grace window before resetting stall timer. */
  stallLeftBandSinceMs?: number | null;
  orderId?: string;
}

export interface TradeRecord {
  ts: string;
  kind: "entry" | "exit" | "settle" | "skip" | "risk" | "info" | "error";
  slug?: string;
  interval?: Interval;
  side?: OutcomeSide;
  shares?: number;
  price?: number;
  usd?: number;
  pnlUsd?: number;
  reason?: string;
  mode?: "paper" | "live";
  detail?: Record<string, unknown>;
}
