import { intervalSeconds } from "./config.ts";
import type { BookQuote, Interval, MarketRef, OutcomeSide } from "./types.ts";

export const GAMMA_BASE = "https://gamma-api.polymarket.com";
export const CLOB_BASE = "https://clob.polymarket.com";

async function getJson<T>(url: string, timeoutMs = 8_000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "polymarket-updown-bot/0.1" },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && /HTTP 404/.test(error.message)) return null;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Aligned epoch second that starts the window containing `nowMs`. */
export function windowStartSec(interval: Interval, nowMs: number): number {
  const size = intervalSeconds(interval);
  return Math.floor(nowMs / 1000 / size) * size;
}

/**
 * Polymarket's recurring crypto up/down markets are slug-addressed:
 *   btc-updown-15m-<window start, unix seconds>
 *   btc-updown-5m-<window start, unix seconds>
 */
export function marketSlug(asset: string, interval: Interval, startSec: number): string {
  return `${asset}-updown-${interval}-${startSec}`;
}

interface RawMarket {
  id?: string;
  slug?: string;
  question?: string;
  conditionId?: string;
  clobTokenIds?: string | null;
  outcomes?: string | null;
  outcomePrices?: string | null;
  orderPriceMinTickSize?: number | string | null;
  orderMinSize?: number | string | null;
  acceptingOrders?: boolean | null;
  closed?: boolean | null;
  endDate?: string | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  negRisk?: boolean | null;
  eventMetadata?: { priceToBeat?: number; finalPrice?: number } | null;
}

interface RawEvent {
  id?: string;
  slug?: string;
  title?: string;
  closed?: boolean | null;
  endDate?: string | null;
  eventMetadata?: { priceToBeat?: number; finalPrice?: number } | null;
  markets?: RawMarket[];
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bookSide(levels: { price?: string; size?: string }[] | undefined): BookQuote {
  const parsed = (levels ?? [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && level.price < 1);

  if (parsed.length === 0) return { bid: null, ask: null, bidSize: 0, askSize: 0 };
  const bestBid = parsed.reduce((best, level) => (level.price > best.price ? level : best), parsed[0]!);
  const bestAsk = parsed.reduce((best, level) => (level.price < best.price ? level : best), parsed[0]!);
  return { bid: bestBid.price, ask: bestAsk.price, bidSize: bestBid.size, askSize: bestAsk.size };
}

/** Best bid/ask for a single outcome token, straight from the CLOB book. */
export async function fetchBookQuote(tokenId: string): Promise<BookQuote> {
  const book = await getJson<{ bids?: { price?: string; size?: string }[]; asks?: { price?: string; size?: string }[] }>(
    `${CLOB_BASE}/book?token_id=${tokenId}`,
  );
  if (!book) return { bid: null, ask: null, bidSize: 0, askSize: 0 };
  const bids = bookSide(book.bids);
  const asks = bookSide(book.asks);
  return { bid: bids.bid, ask: asks.ask, bidSize: bids.bidSize, askSize: asks.askSize };
}

/**
 * Discover one up/down window. Returns null when the window does not exist
 * (Polymarket sometimes skips or retires a slot).
 */
export async function discoverMarket(asset: string, interval: Interval, startSec: number): Promise<MarketRef | null> {
  const slug = marketSlug(asset, interval, startSec);
  const event = await getJson<RawEvent>(`${GAMMA_BASE}/events/slug/${slug}`);
  if (!event || !event.markets || event.markets.length === 0) return null;

  const market = event.markets[0]!;
  const tokens = parseJsonArray(market.clobTokenIds);
  const outcomes = parseJsonArray(market.outcomes);
  if (tokens.length < 2) return null;

  const upIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "up");
  const resolvedUpIndex = upIndex >= 0 ? upIndex : 0;
  const upTokenId = tokens[resolvedUpIndex]!;
  const downTokenId = tokens[resolvedUpIndex === 0 ? 1 : 0] ?? tokens[1]!;

  const startMs = startSec * 1000;
  const endMs = startMs + intervalSeconds(interval) * 1000;

  const prices = parseJsonArray(market.outcomePrices).map((p) => Number(p));
  let resolved: OutcomeSide | null = null;
  if (market.closed === true && prices.length >= 2 && prices.some((p) => p >= 0.99)) {
    const upPrice = prices[resolvedUpIndex] ?? 0;
    resolved = upPrice >= 0.99 ? "Up" : "Down";
  } else if (market.closed === true) {
    const metadata = event.eventMetadata ?? market.eventMetadata;
    if (typeof metadata?.finalPrice === "number" && typeof metadata.priceToBeat === "number") {
      resolved = metadata.finalPrice >= metadata.priceToBeat ? "Up" : "Down";
    }
  }

  return {
    asset,
    interval,
    slug,
    eventId: String(event.id ?? ""),
    marketId: String(market.id ?? ""),
    conditionId: String(market.conditionId ?? ""),
    upTokenId,
    downTokenId,
    startMs,
    endMs,
    publishedPriceToBeat:
      toNumber(event.eventMetadata?.priceToBeat ?? market.eventMetadata?.priceToBeat, Number.NaN) || null,
    finalPrice: toNumber(event.eventMetadata?.finalPrice ?? market.eventMetadata?.finalPrice, Number.NaN) || null,
    tickSize: toNumber(market.orderPriceMinTickSize, 0.01),
    minOrderSize: toNumber(market.orderMinSize, 5),
    acceptingOrders: market.acceptingOrders !== false,
    closed: market.closed === true,
    quotes: {
      Up: { bid: null, ask: null, bidSize: 0, askSize: 0 },
      Down: { bid: null, ask: null, bidSize: 0, askSize: 0 },
    },
    resolved,
    fetchedAtMs: Date.now(),
  };
}

/** Refresh both outcome books in parallel; mutates and returns the market. */
export async function refreshQuotes(market: MarketRef): Promise<MarketRef> {
  const [up, down] = await Promise.all([fetchBookQuote(market.upTokenId), fetchBookQuote(market.downTokenId)]);
  market.quotes = { Up: up, Down: down };
  return market;
}

export function tokenFor(market: MarketRef, side: OutcomeSide): string {
  return side === "Up" ? market.upTokenId : market.downTokenId;
}
