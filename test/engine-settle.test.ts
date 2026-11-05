import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import { PaperExchange } from "../src/exchange.ts";
import { PriceFeed } from "../src/priceFeed.ts";
import { Store } from "../src/state.ts";
import { Journal } from "../src/telemetry.ts";
import type { Position } from "../src/types.ts";

const NOW = Date.parse("2026-11-05T19:00:00Z");
const WINDOW_START_SEC = Date.parse("2026-11-05T18:00:00Z") / 1000;
const SLUG = `btc-updown-15m-${WINDOW_START_SEC}`;

function orphan(): Position {
  return {
    id: `${SLUG}:Up:1`,
    slug: SLUG,
    interval: "15m",
    side: "Up",
    tokenId: "up-token",
    shares: 60,
    entryPrice: 0.54,
    entryFeeUsd: 0,
    entryAtMs: WINDOW_START_SEC * 1000 + 300_000,
    costUsd: 32.4,
    modelProb: 0.619,
    edge: 0.062,
    endMs: WINDOW_START_SEC * 1000 + 15 * 60_000,
    stallSinceMs: null,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("settlement", () => {
  // A market drops out of the cache 30 minutes after close, and a restart never
  // reloads old windows. Such a position must still settle, not sit "open" forever.
  test("settles an open position whose market is no longer cached", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/events/slug/${SLUG}`)) {
        return new Response(
          JSON.stringify({
            id: "e1",
            markets: [
              {
                id: "m1",
                conditionId: "0xabc",
                clobTokenIds: '["up-token","down-token"]',
                outcomes: '["Up","Down"]',
                outcomePrices: '["1","0"]',
                closed: true,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const dir = mkdtempSync(join(tmpdir(), "bot-settle-"));
    const store = new Store(dir);
    const state = store.load(1_000);
    state.positions.push(orphan());
    store.save(state);

    const engine = new Engine({
      config: { ...structuredClone(DEFAULT_CONFIG), dataDir: dir },
      feed: new PriceFeed(),
      exchange: new PaperExchange(0.07),
      store,
      persist: true,
    });
    await engine.tick(NOW);

    expect(engine.snapshot.state.positions).toHaveLength(0);
    const settled = store.readTrades().filter((trade) => trade.kind === "settle");
    expect(settled).toHaveLength(1);
    expect(settled[0]!.reason).toBe("won");
    expect(settled[0]!.pnlUsd).toBeCloseTo(60 - 32.4, 5);
  });

  // While a window resolves the book is pulled and the snapshot must not pretend
  // the shares pay $1 each — the lie that showed a losing position as +$1.7k.
  test("marks a resolving position unknown instead of assuming a full payout", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/events/slug/${SLUG}`)) {
        return new Response(
          JSON.stringify({
            id: "e1",
            markets: [
              {
                id: "m1",
                conditionId: "0xabc",
                clobTokenIds: '["up-token","down-token"]',
                outcomes: '["Up","Down"]',
                outcomePrices: '["0.5","0.5"]',
                closed: true,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/book")) return new Response(JSON.stringify({}), { status: 200 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const dir = mkdtempSync(join(tmpdir(), "bot-mark-"));
    const store = new Store(dir);
    const state = store.load(1_000);
    state.positions.push(orphan());
    store.save(state);

    // One minute past the window end: still "waiting for resolution", not the
    // 30-minute unresolved fallback, so the position stays open in the snapshot.
    const journalDir = join(dir, "journal");
    const engine = new Engine({
      config: { ...structuredClone(DEFAULT_CONFIG), dataDir: dir },
      feed: new PriceFeed(),
      exchange: new PaperExchange(0.07),
      store,
      journal: new Journal(journalDir),
      persist: true,
    });
    await engine.tick(Date.parse("2026-11-05T18:16:00Z"));

    const snapshot = JSON.parse(readFileSync(join(journalDir, "snapshot.json"), "utf8")) as {
      positions: { mark: number | null; unrealizedPnlUsd: number | null }[];
    };
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0]!.mark).toBeNull();
    expect(snapshot.positions[0]!.unrealizedPnlUsd).toBeNull();
  });
});
