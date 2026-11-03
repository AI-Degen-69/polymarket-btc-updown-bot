import { log } from "./log.ts";
import type { PriceSample } from "./types.ts";

interface Venue {
  name: string;
  url: string;
  parse: (body: unknown) => number | null;
}

/**
 * Venues are only used to derive *direction and relative move*, and the anchor
 * is captured from this same feed so the model never mixes sources. The market
 * resolves on Chainlink BTC/USD; a median across major spot venues tracks it
 * closely at the seconds scale that matters here.
 */
function toNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

const VENUES: Venue[] = [
  {
    name: "coinbase",
    url: "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
    parse: (body) => toNumber((body as { price?: unknown })?.price),
  },
  {
    name: "kraken",
    url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
    parse: (body) => {
      const result = (body as { result?: Record<string, { c?: unknown[] }> })?.result;
      if (!result) return null;
      const first = Object.values(result)[0];
      const last = first?.c?.[0];
      return toNumber(last);
    },
  },
  {
    name: "binance",
    url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
    parse: (body) => toNumber((body as { price?: unknown })?.price),
  },
];

async function fetchVenue(venue: Venue, timeoutMs: number): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(venue.url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "polymarket-updown-bot/0.1" },
    });
    if (!response.ok) return null;
    return venue.parse(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Polls several spot venues and keeps a rolling history of median prices.
 * A median (not a single venue) keeps one bad print from faking a shakeout.
 */
export class PriceFeed {
  private samples: PriceSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  lastQuorum: number = 0;

  constructor(
    private readonly options: { pollMs: number; historyMs: number; timeoutMs?: number } = {
      pollMs: 2_000,
      historyMs: 3 * 60 * 60 * 1000,
    },
  ) {}

  async start(): Promise<PriceSample | null> {
    const first = await this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.options.pollMs);
    return first;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<PriceSample | null> {
    if (this.polling) return this.latest();
    this.polling = true;
    try {
      const prices = (await Promise.all(VENUES.map((venue) => fetchVenue(venue, this.options.timeoutMs ?? 4_000))))
        .filter((price): price is number => price !== null)
        .sort((a, b) => a - b);

      this.lastQuorum = prices.length;
      if (prices.length === 0) return this.latest();
      const mid = Math.floor(prices.length / 2);
      const median = prices.length % 2 === 0 ? ((prices[mid - 1]! + prices[mid]!) / 2) : prices[mid]!;

      const sample: PriceSample = { ts: Date.now(), value: median };
      this.push(sample);
      return sample;
    } finally {
      this.polling = false;
    }
  }

  private push(sample: PriceSample): void {
    this.samples.push(sample);
    const cutoff = sample.ts - this.options.historyMs;
    if (this.samples.length > 32 && this.samples[0]!.ts < cutoff) {
      this.samples = this.samples.filter((entry) => entry.ts >= cutoff);
    }
  }

  /** Seed history (used when resuming after a restart). */
  seed(samples: PriceSample[]): void {
    const merged = [...samples, ...this.samples].sort((a, b) => a.ts - b.ts);
    this.samples = merged;
  }

  latest(): PriceSample | null {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1]! : null;
  }

  history(): PriceSample[] {
    return this.samples;
  }

  /** Closest sample at or after `tsMs`, within `toleranceMs`. */
  sampleNear(tsMs: number, toleranceMs: number): PriceSample | null {
    let best: PriceSample | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const sample of this.samples) {
      const delta = Math.abs(sample.ts - tsMs);
      if (delta < bestDelta) {
        best = sample;
        bestDelta = delta;
      }
    }
    return best && bestDelta <= toleranceMs ? best : null;
  }

  /**
 * Recover the reference price at a past instant from 1-minute candles, used
   * when the bot starts (or restarts) mid-window and missed the open.
   * Returns the median across venues that answered for that minute.
   */
  async priceAt(tsMs: number): Promise<number | null> {
    const minuteStart = Math.floor(tsMs / 60_000) * 60_000;
    const startIso = new Date(minuteStart).toISOString();
    const endIso = new Date(minuteStart + 60_000).toISOString();

    const requests: Promise<number | null>[] = [
      this.fromCoinbaseCandles(startIso, endIso, minuteStart),
      this.fromBinanceCandles(minuteStart),
    ];
    const found = (await Promise.all(requests)).filter((value): value is number => value !== null).sort((a, b) => a - b);
    if (found.length === 0) return null;
    const mid = Math.floor(found.length / 2);
    return found.length % 2 === 0 ? (found[mid - 1]! + found[mid]!) / 2 : found[mid]!;
  }

  private async fromCoinbaseCandles(startIso: string, endIso: string, minuteStart: number): Promise<number | null> {
    try {
      const response = await fetch(
        `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`,
        { headers: { accept: "application/json", "user-agent": "polymarket-updown-bot/0.1" } },
      );
      if (!response.ok) return null;
      const rows = (await response.json()) as number[][];
      // Row layout: [ time, low, high, open, close, volume ] with time in seconds.
      const row = rows.find((entry) => Number(entry[0]) * 1000 === minuteStart);
      return row ? toNumber(row[3]) : null;
    } catch {
      return null;
    }
  }

  private async fromBinanceCandles(minuteStart: number): Promise<number | null> {
    try {
      const response = await fetch(
        `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${minuteStart}&endTime=${minuteStart + 59_999}&limit=1`,
        { headers: { accept: "application/json", "user-agent": "polymarket-updown-bot/0.1" } },
      );
      if (!response.ok) return null;
      const rows = (await response.json()) as unknown[][];
      const row = rows[0];
      return row ? toNumber(row[1]) : null;
    } catch {
      return null;
    }
  }

  warnIfDegraded(): void {
    if (this.lastQuorum < 2) {
      log("risk", "price feed degraded: fewer than two venues responding", { venues: this.lastQuorum });
    }
  }
}
