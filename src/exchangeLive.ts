import { createSecureClient, OrderSide, OrderType } from "@polymarket/client";
import { privateKey } from "@polymarket/client/viem";
import { takerFeePerShare } from "./probability.ts";
import type { BuyRequest, Exchange, FillResult, SellRequest } from "./exchange.ts";

interface OrderResponseLike {
  ok?: boolean;
  success?: boolean;
  orderId?: string;
  orderID?: string;
  status?: string;
  makingAmount?: string | number;
  takingAmount?: string | number;
  errorMsg?: string;
  message?: string;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * The CLOB reports matched amounts in base units (6 decimals) on some responses
 * and as plain decimals on others, so parse defensively and never let a
 * mis-read amount silently become a huge position.
 */
function parseBaseAmount(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed > 1_000 ? parsed / 1_000_000 : parsed;
}

/**
 * Live desk built on the official `@polymarket/client` SDK, which owns order
 * signing, the L2 HMAC headers and wallet approvals.
 *
 * Entry and exit use marketable FAK orders with an explicit price bound, so a
 * fast book can only make the fill worse up to the strategy's own limit — never
 * past it.
 */
export class LiveExchange implements Exchange {
  readonly mode = "live" as const;

  private constructor(
    private readonly client: Awaited<ReturnType<typeof createSecureClient>>,
    private readonly feeRate: number,
  ) {}

  static async create(env: { privateKey?: string; walletAddress?: string; feeRate: number }): Promise<LiveExchange> {
    if (!env.privateKey) {
      throw new Error(
        "live trading needs POLYMARKET_PRIVATE_KEY (the signer key). See bot/README.md; nothing was traded.",
      );
    }
    const client = await createSecureClient({
      signer: privateKey(env.privateKey),
      ...(env.walletAddress ? { wallet: env.walletAddress } : {}),
    });
    return new LiveExchange(client, env.feeRate);
  }

  get account(): { signer: string; wallet: string; walletType: number } {
    return this.client.account;
  }

  async buy(request: BuyRequest): Promise<FillResult> {
    const usd = round(request.usd, 2);
    try {
      // Estimate first: if the book already moved past our limit, do nothing.
      const estimate = await this.client.estimateMarketPrice({
        assetId: request.tokenId,
        side: OrderSide.BUY,
        amount: usd,
        orderType: OrderType.FAK,
      });
      if (estimate > request.maxPrice + 1e-9) {
        return {
          ok: false,
          shares: 0,
          price: estimate,
          feeUsd: 0,
          message: `estimate ${estimate.toFixed(3)} above limit ${request.maxPrice.toFixed(3)}`,
        };
      }

      const response = (await this.client.placeMarketOrder({
        assetId: request.tokenId,
        side: OrderSide.BUY,
        amount: usd,
        maxPrice: round(request.maxPrice, 4),
        orderType: OrderType.FAK,
      })) as unknown as OrderResponseLike;

      return this.toFill(response, {
        fallbackShares: round(Math.floor((usd / request.maxPrice) * 100) / 100, 2),
        fallbackPrice: request.maxPrice,
        side: "BUY",
      });
    } catch (error) {
      return { ok: false, shares: 0, price: 0, feeUsd: 0, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async sell(request: SellRequest): Promise<FillResult> {
    const shares = round(request.shares, 2);
    try {
      const estimate = await this.client.estimateMarketPrice({
        assetId: request.tokenId,
        side: OrderSide.SELL,
        shares,
        orderType: OrderType.FAK,
      });
      if (estimate < request.minPrice - 1e-9) {
        return {
          ok: false,
          shares: 0,
          price: estimate,
          feeUsd: 0,
          message: `estimate ${estimate.toFixed(3)} below floor ${request.minPrice.toFixed(3)}`,
        };
      }

      const response = (await this.client.placeMarketOrder({
        assetId: request.tokenId,
        side: OrderSide.SELL,
        shares,
        minPrice: round(request.minPrice, 4),
        orderType: OrderType.FAK,
      })) as unknown as OrderResponseLike;

      return this.toFill(response, { fallbackShares: shares, fallbackPrice: request.minPrice, side: "SELL" });
    } catch (error) {
      return { ok: false, shares: 0, price: 0, feeUsd: 0, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private toFill(
    response: OrderResponseLike,
    fallback: { fallbackShares: number; fallbackPrice: number; side: "BUY" | "SELL" },
  ): FillResult {
    const accepted = response.ok ?? response.success ?? false;
    const orderId = response.orderId ?? response.orderID;
    if (!accepted) {
      return {
        ok: false,
        shares: 0,
        price: 0,
        feeUsd: 0,
        orderId,
        status: response.status,
        message: response.errorMsg ?? response.message ?? "order rejected",
      };
    }

    const status = response.status ?? "unknown";
    if (status === "delayed" || status === "unmatched") {
      // Accepted but not matched: nothing to book yet.
      return { ok: false, shares: 0, price: 0, feeUsd: 0, orderId, status, message: `not matched (${status})` };
    }

    const making = parseBaseAmount(response.makingAmount);
    const taking = parseBaseAmount(response.takingAmount);
    let shares = fallback.fallbackShares;
    let price = fallback.fallbackPrice;
    if (making !== null && taking !== null && taking > 0) {
      if (fallback.side === "BUY") {
        shares = taking; // shares received
        price = making / taking;
      } else {
        shares = making; // shares sold
        price = taking / making;
      }
    }

    return {
      ok: true,
      shares,
      price,
      feeUsd: round(shares * takerFeePerShare(price, this.feeRate), 5),
      orderId,
      status,
    };
  }
}
