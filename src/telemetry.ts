import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RiskState } from "./risk.ts";
import type { Anchor, Interval, OutcomeSide, Position } from "./types.ts";

/** What the bot currently sees in one market, independent of any UI. */
export interface MarketView {
  slug: string;
  interval: Interval;
  startMs: number;
  endMs: number;
  price: number | null;
  anchor: { value: number; source: Anchor["source"] } | null;
  movePct: number | null;
  requiredMovePct: number;
  side: OutcomeSide | null;
  quotes: Record<OutcomeSide, { bid: number | null; ask: number | null }>;
  modelProb: number | null;
  edge: number | null;
  spreadCents: number | null;
  secondsRemaining: number;
  /** The gate that decided this market this tick, with the numbers behind it. */
  verdict: { action: "enter" | "skip" | "blocked"; reason: string; detail: Record<string, unknown> };
}

export interface PositionView extends Position {
  bid: number | null;
  markValueUsd: number;
  unrealizedPnlUsd: number;
  secondsLeft: number;
  stalledSec: number | null;
}

export interface BotSnapshot {
  version: 1;
  mode: "paper" | "live";
  asset: string;
  updatedAt: string;
  equityUsd: number;
  bankrollUsd: number;
  exposureUsd: number;
  cashUsd: number;
  realizedPnlUsd: number;
  risk: RiskState;
  limits: {
    maxTradesPerDay: number;
    maxConsecutiveLosses: number;
    dailyLossLimitPct: number;
    maxDrawdownPct: number;
    maxConcurrentPositions: number;
    minEdge: number;
    feeRate: number;
    profitTargetCents: number;
  };
  killSwitch: boolean;
  newsBlocked: boolean;
  feed: { price: number | null; updatedAtMs: number | null; history: { ts: number; value: number }[] };
  markets: MarketView[];
  positions: PositionView[];
}

export type JournalKind =
  | "entry"
  | "exit"
  | "settle"
  | "hold"
  | "skip"
  | "blocked"
  | "anchor"
  | "risk"
  | "info"
  | "error";

/** One line of the bot's reasoning, kept so a UI can show the thought process. */
export interface BotEvent {
  ts: string;
  kind: JournalKind;
  slug?: string;
  interval?: Interval;
  side?: OutcomeSide;
  reason: string;
  detail?: Record<string, unknown>;
  mode?: "paper" | "live";
}

const MAX_EVENTS_BYTES = 2_000_000;
const KEEP_EVENTS = 2_000;

/**
 * Append-only decision journal plus a per-tick snapshot, both plain files in the
 * bot's state directory. Nothing here touches the network: any local UI (or a
 * small local API) can read the bot's mind without giving it new attack surface.
 */
export class Journal {
  readonly eventsPath: string;
  readonly snapshotPath: string;

  constructor(readonly dir: string) {
    this.eventsPath = join(dir, "events.ndjson");
    this.snapshotPath = join(dir, "snapshot.json");
  }

  ensure(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  event(event: BotEvent): void {
    this.ensure();
    appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    this.compact();
  }

  /** Called every tick; the UI polls this file instead of querying the engine. */
  snapshot(snapshot: BotSnapshot): void {
    this.ensure();
    writeFileSync(this.snapshotPath, JSON.stringify(snapshot), "utf8");
  }

  /** Drops the journal and snapshot, used by a full reset. */
  clear(): void {
    this.ensure();
    for (const path of [this.eventsPath, this.snapshotPath]) {
      if (existsSync(path)) rmSync(path, { force: true });
    }
  }

  private compact(): void {
    try {
      if (!existsSync(this.eventsPath)) return;
      if (statSync(this.eventsPath).size < MAX_EVENTS_BYTES) return;
      const kept = readFileSync(this.eventsPath, "utf8").trim().split("\n").filter(Boolean).slice(-KEEP_EVENTS);
      writeFileSync(this.eventsPath, `${kept.join("\n")}\n`, "utf8");
    } catch {
      // A rotating journal is not worth crashing a trading loop over.
    }
  }
}
