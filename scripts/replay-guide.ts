/**
 * Offline audit of the Crypticorn guide's entry edge, replayed against the bot's
 * own tick log. Read-only: it never starts the engine, never orders, never writes.
 *
 * The guide's claim is that the crowd panics after a 60s dump and sells the
 * dumped side too cheap — "UP at 30c when the true probability is 50-55%". So
 * the question this answers is: across every recorded window, does the side
 * that is BEHIND the window anchor win more often than its price implies?
 *
 * Steps:
 *   1. Parse `.state/bot.log*` for the 30s snapshot lines (price, anchor, book).
 *   2. Resolve each window from the Gamma API (final outcome).
 *   3. Emit every tick where buying the behind-side was possible under the
 *      guide's price/spread limits, labelled reversal or continuation, and
 *      whether the guide's 60s "direction held" test passed.
 *   4. Compare realised hit rate against the price actually paid. A calibrated
 *      market scores hit% == ask; a guide-style edge shows hit% above ask.
 *
 * Usage: bun run scripts/replay-guide.ts [log ...]
 */
import { readFileSync } from "node:fs";

const LOGS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [".state/bot.log.1", ".state/bot.log"];
const WINDOW_SEC: Record<string, number> = { "15m": 900, "5m": 300 };
const OBSERVE_SEC: Record<string, number> = { "15m": 300, "5m": 100 };
/** The bot's own noise band, reused so "direction held" means the same thing here. */
const NOISE_PCT = 0.01;
const MAX_MOVE_PCT = 0.5;
const MAX_SPREAD_CENTS = 2;
const MAX_ENTRY_PRICE = 0.65;
const HOLD_SEC = 60;
const FEE_RATE = 0.07;

interface Tick {
  slug: string;
  interval: string;
  t: number;
  elapsed: number;
  price: number;
  anchor: number;
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
}

const LINE =
  /(15m|5m) (btc-updown-(?:15m|5m)-(\d+)) elapsed=(\d+)s .*?price=([\d.]+) anchor=([\d.]+)\((\w+)\) .*?up=([\d.-]+)\/([\d.-]+) down=([\d.-]+)\/([\d.-]+)/;

const num = (s: string) => (s === "-" || s === "" ? NaN : Number(s));

function parse(): Map<string, Tick[]> {
  const bySlug = new Map<string, Tick[]>();
  for (const path of LOGS) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
      const m = LINE.exec(line);
      if (!m) continue;
      const tick: Tick = {
        slug: m[2]!,
        interval: m[1]!,
        t: (Number(m[3]!) + Number(m[4]!)) * 1000,
        elapsed: Number(m[4]!),
        price: Number(m[5]!),
        anchor: Number(m[6]!),
        upBid: num(m[8]!),
        upAsk: num(m[9]!),
        downBid: num(m[10]!),
        downAsk: num(m[11]!),
      };
      if (!Number.isFinite(tick.price) || !Number.isFinite(tick.anchor) || tick.price <= 0) continue;
      const list = bySlug.get(tick.slug) ?? [];
      list.push(tick);
      bySlug.set(tick.slug, list);
    }
  }
  for (const list of bySlug.values()) list.sort((a, b) => a.t - b.t);
  return bySlug;
}

async function resolve(slug: string): Promise<"Up" | "Down" | null> {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/events/slug/${slug}`);
    if (!res.ok) return null;
    const j = (await res.json()) as { markets?: Array<Record<string, unknown>> };
    const m = (j.markets ?? [])[0];
    if (!m || m["closed"] !== true) return null;
    const outcomes = JSON.parse(String(m["outcomes"] ?? "[]")) as string[];
    const prices = JSON.parse(String(m["outcomePrices"] ?? "[]")) as string[];
    const idx = prices.findIndex((p) => Number(p) === 1);
    if (idx < 0) return null;
    const label = outcomes[idx];
    return label === "Up" || label === "Down" ? label : null;
  } catch {
    return null;
  }
}

/** Guide rule 2: the direction sustained across the trailing 60s, no oscillation. */
function heldDirection(series: Tick[], i: number, tol: number): "Up" | "Down" | null {
  const t = series[i]!.t;
  const w = series.filter((s) => s.t >= t - HOLD_SEC * 1000 && s.t <= t);
  if (w.length < 2) return null;
  if (w[w.length - 1]!.t - w[0]!.t < HOLD_SEC * 1000 * 0.5) return null;
  const first = w[0]!.price;
  const up = w.every((s) => s.price >= first - tol) && w[w.length - 1]!.price > first + tol;
  const down = w.every((s) => s.price <= first + tol) && w[w.length - 1]!.price < first - tol;
  if (up && !down) return "Up";
  if (down && !up) return "Down";
  return null;
}

interface Sample {
  slug: string;
  interval: string;
  side: "Up" | "Down";
  ask: number;
  distancePct: number;
  setup: "reversal" | "continuation";
  held: boolean;
  won: boolean;
}

const fee = (ask: number) => FEE_RATE * ask * (1 - ask);

function summarise(label: string, rows: Sample[]) {
  if (rows.length === 0) {
    console.log(`${label.padEnd(34)} n=0`);
    return;
  }
  const wins = rows.filter((r) => r.won).length;
  const hit = wins / rows.length;
  const avgAsk = rows.reduce((a, r) => a + r.ask, 0) / rows.length;
  const avgFee = rows.reduce((a, r) => a + fee(r.ask), 0) / rows.length;
  const ev = hit - avgAsk - avgFee;
  console.log(
    `${label.padEnd(34)} n=${String(rows.length).padStart(3)} hit=${(hit * 100).toFixed(0).padStart(3)}% ` +
      `ask=${(avgAsk * 100).toFixed(0).padStart(2)}c fee=${(avgFee * 100).toFixed(1)}c ` +
      `EV/share=${ev >= 0 ? "+" : ""}${ev.toFixed(3)} ROI=${((ev / avgAsk) * 100).toFixed(0).padStart(4)}%`,
  );
}

/** Collapse many ticks of one window/side into one observation: mean ask, one outcome. */
function perWindow(rows: Sample[]): Sample[] {
  const byKey = new Map<string, Sample[]>();
  for (const r of rows) {
    const k = `${r.slug}|${r.side}|${r.setup}`;
    const list = byKey.get(k) ?? [];
    list.push(r);
    byKey.set(k, list);
  }
  return [...byKey.values()].map((list) => ({
    ...list[0]!,
    ask: list.reduce((a, r) => a + r.ask, 0) / list.length,
  }));
}

async function main() {
  const bySlug = parse();
  const slugs = [...bySlug.keys()].sort();
  const tickCount = [...bySlug.values()].reduce((a, b) => a + b.length, 0);
  console.log(`parsed ${slugs.length} windows / ${tickCount} tick snapshots`);

  const winners = new Map<string, "Up" | "Down" | null>();
  const queue = [...slugs];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (;;) {
        const slug = queue.shift();
        if (!slug) return;
        winners.set(slug, await resolve(slug));
      }
    }),
  );
  const resolved = slugs.filter((s) => winners.get(s));
  const counts = resolved.map((s) => (bySlug.get(s) ?? []).length).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] ?? 0;
  console.log(
    `resolved ${resolved.length} of ${slugs.length} · ticks per window: min=${counts[0]} ` +
      `median=${median} max=${counts[counts.length - 1]}\n`,
  );

  const all: Sample[] = [];
  for (const slug of resolved) {
    const series = bySlug.get(slug) ?? [];
    if (series.length < 2) continue;
    const interval = series[0]!.interval;
    const win = WINDOW_SEC[interval]!;
    const obs = OBSERVE_SEC[interval]!;
    for (let i = 0; i < series.length; i += 1) {
      const s = series[i]!;
      if (s.elapsed < obs) continue;
      if (s.elapsed > win - 120) continue;
      const distanceUp = ((s.price - s.anchor) / s.anchor) * 100;
      if (Math.abs(distanceUp) > MAX_MOVE_PCT) continue;
      const tol = (s.anchor * NOISE_PCT) / 100;
      const held = heldDirection(series, i, tol);

      for (const side of ["Up", "Down"] as const) {
        const q = side === "Up" ? { bid: s.upBid, ask: s.upAsk } : { bid: s.downBid, ask: s.downAsk };
        if (!Number.isFinite(q.ask) || !Number.isFinite(q.bid)) continue;
        if (q.ask <= 0 || q.ask > MAX_ENTRY_PRICE) continue;
        if (Number(((q.ask - q.bid) * 100).toFixed(4)) > MAX_SPREAD_CENTS) continue;
        const distancePct = side === "Up" ? distanceUp : -distanceUp;
        all.push({
          slug,
          interval,
          side,
          ask: q.ask,
          distancePct,
          setup: distancePct < 0 ? "reversal" : "continuation",
          held: held === side,
          won: winners.get(slug) === side,
        });
      }
    }
  }

  const ups = resolved.filter((s) => winners.get(s) === "Up").length;
  console.log(
    `tape outcome: ${ups} Up / ${resolved.length - ups} Down across ${resolved.length} resolved windows ` +
      `(${((ups / resolved.length) * 100).toFixed(0)}% Up)\n`,
  );

  const base = all.filter((r) => r.distancePct < 0);
  const baseWin = perWindow(base);

  console.log("=== every tick, buying the side that is BEHIND the anchor ===");
  for (const interval of ["15m", "5m"]) summarise(`${interval} per-tick`, base.filter((r) => r.interval === interval));
  summarise("all per-tick", base);
  console.log("");
  for (const interval of ["15m", "5m"]) {
    summarise(`${interval} one per window`, perWindow(base.filter((r) => r.interval === interval)));
  }
  summarise("ALL one per window", baseWin);

  console.log("\n=== with the guide's 60s direction-hold filter (one per window) ===");
  summarise("reversal + direction held", perWindow(base.filter((r) => r.held)));
  summarise("continuation + direction held", perWindow(all.filter((r) => r.distancePct > 0 && r.held)));

  console.log("\n=== behind-side entries bucketed by how far behind (one per window) ===");
  const distEdges = [0, 0.05, 0.15, 0.3, 0.5];
  for (let i = 0; i < distEdges.length - 1; i += 1) {
    const lo = distEdges[i]!;
    const hi = distEdges[i + 1]!;
    const rows = baseWin.filter((r) => Math.abs(r.distancePct) >= lo && Math.abs(r.distancePct) < hi);
    if (rows.length === 0) continue;
    const hit = rows.filter((r) => r.won).length / rows.length;
    const avg = rows.reduce((a, r) => a + r.ask, 0) / rows.length;
    console.log(
      `behind ${lo.toFixed(2)}-${hi.toFixed(2)}%: n=${String(rows.length).padStart(2)} ` +
        `hit=${(hit * 100).toFixed(0).padStart(3)}% marketSaid=${(avg * 100).toFixed(0).padStart(2)}c ` +
        `gap=${((hit - avg) * 100 >= 0 ? "+" : "")}${((hit - avg) * 100).toFixed(0)}c`,
    );
  }

  console.log("\n=== entries bucketed by price paid (one per window) ===");
  const buckets = [0, 0.1, 0.2, 0.3, 0.45, 0.65];
  for (let i = 0; i < buckets.length - 1; i += 1) {
    const lo = buckets[i]!;
    const hi = buckets[i + 1]!;
    const rows = baseWin.filter((r) => r.ask >= lo && r.ask < hi);
    if (rows.length === 0) continue;
    const hit = rows.filter((r) => r.won).length / rows.length;
    const avg = rows.reduce((a, r) => a + r.ask, 0) / rows.length;
    console.log(
      `ask ${String((lo * 100).toFixed(0)).padStart(2)}-${(hi * 100).toFixed(0)}c: n=${String(rows.length).padStart(2)} ` +
        `hit=${(hit * 100).toFixed(0).padStart(3)}% marketSaid=${(avg * 100).toFixed(0).padStart(2)}c ` +
        `gap=${((hit - avg) * 100 >= 0 ? "+" : "")}${((hit - avg) * 100).toFixed(0)}c`,
    );
  }

  console.log("\n=== per window: behind-side entry (one per window) ===");
  for (const r of baseWin.sort((a, b) => a.slug.localeCompare(b.slug))) {
    console.log(
      `${r.slug} ${r.interval} ${r.side.padEnd(4)} ask=${(r.ask * 100).toFixed(0).padStart(2)}c ` +
        `dist=${r.distancePct.toFixed(2).padStart(6)}% ${r.held ? "held " : "     "} ${r.won ? "WIN " : "LOSS"}`,
    );
  }
}

await main();
