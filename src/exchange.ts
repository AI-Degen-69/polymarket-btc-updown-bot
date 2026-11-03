import { takerFeePerShare } from "./probability.ts";
import type { BookQuote } from "./types.ts";

export interface BuyRequest {
  tokenId: string;
  /** USD notional to spend, before fees. */
  usd: number;
  /** Highest acceptable price per share (the strategy's limit). */
  maxPrice: number;
  quote: BookQuote;
}

export interface SellRequest {
  tokenId: string;
  shares: number;
  /** Lowest acceptable price per share. */
  minPrice: number;
  quote: BookQuote;
}

export interface FillResult {
  ok: boolean;
  shares: number;
  price: number;
  feeUsd: number;
  orderId?: string;
  status?: string;
  message?: string;
}

export interface Exchange {
  readonly mode: "paper" | "live";
  buy(request: BuyRequest): Promise<FillResult>;
  sell(request: SellRequest): Promise<FillResult>;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Paper desk: fills at the touch when it is inside the limit, otherwise it does
 * not fill. Fees use the Crypto taker schedule so paper PnL stays honest.
 */
export class PaperExchange implements Exchange {
  readonly mode = "paper" as const;

  constructor(private readonly feeRate: number) {}

  async buy(request: BuyRequest): Promise<FillResult> {
    const ask = request.quote.ask;
    if (ask === null) {
      return { ok: false, shares: 0, price: 0, feeUsd: 0, message: "no ask on the book" };
    }
    if (ask > request.maxPrice + 1e-9) {
      return { ok: false, shares: 0, price: ask, feeUsd: 0, message: `ask ${ask} above limit ${request.maxPrice}` };
    }
    const fillPrice = Math.min(ask, request.maxPrice);
    const shares = round(Math.floor((request.usd / fillPrice) * 100) / 100, 2);
    if (shares <= 0) {
      return { ok: false, shares: 0, price: fillPrice, feeUsd: 0, message: "notional rounds to zero shares" };
    }
    const feeUsd = round(shares * takerFeePerShare(fillPrice, this.feeRate), 5);
    return { ok: true, shares, price: fillPrice, feeUsd, status: "paper-filled" };
  }

  async sell(request: SellRequest): Promise<FillResult> {
    const bid = request.quote.bid;
    if (bid === null) {
      return { ok: false, shares: 0, price: 0, feeUsd: 0, message: "no bid on the book" };
    }
    if (bid < request.minPrice - 1e-9) {
      return { ok: false, shares: 0, price: bid, feeUsd: 0, message: `bid ${bid} below floor ${request.minPrice}` };
    }
    const fillPrice = Math.max(bid, request.minPrice);
    const feeUsd = round(request.shares * takerFeePerShare(fillPrice, this.feeRate), 5);
    return { ok: true, shares: request.shares, price: fillPrice, feeUsd, status: "paper-filled" };
  }
}
