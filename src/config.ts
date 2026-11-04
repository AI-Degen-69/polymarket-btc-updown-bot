import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Interval } from "./types.ts";

export const BOT_ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface IntervalParams {
  /** Guided observation window before any entry is allowed. */
  observationSeconds: number;
  /** How long the post-shakeout direction must hold. */
  minDirectionHoldSeconds: number;
  /** Do not enter with less time than this left before resolution. */
  minRemainingSeconds: number;
  /** "Odds stall" window in width, then seconds before exiting. */
  stallSeconds: number;
}

export interface EntryConfig {
  /** Model probability minus (price + fee). The guide's "odds are still mispriced". */
  minEdge: number;
  minModelProb: number;
  maxModelProb: number;
  /** Never pay more than this for a side (guide enters around 28-40c). */
  maxEntryPriceCents: number;
  /** Net move vs the anchor needed to call the shakeout resolved. */
  minMovePct: number;
  /** Chasing filter: if it already moved this much, odds have corrected. */
  maxMovePct: number;
  /** Low-volatility grind filter: skip when BTC moved less than this in the hour. */
  minHourlyRangePct: number;
  /** Minimum range in USD during the observation period to rule out tight chop (guide: $50 corridor). */
  tightChopRangeUsd: number;
  /** Only trade when the bid/ask is at most this wide. */
  maxSpreadCents: number;
  /** Dead-band around the anchor so flapping inside noise is not "held direction". */
  noisePct: number;
  /** Extra move required when the anchor is not from our own live sample. */
  nonLiveAnchorExtraMovePct: number;
  /** Quarter Kelly, per the guide. */
  kellyCut: number;
  /** Hard cap on a single position as a fraction of bankroll (guide: $30-80 per $1,000). */
  maxPositionPct: number;
  minPositionUsd: number;
  /** Crypto category taker fee: fee = C * rate * p * (1 - p). */
  feeRate: number;
}

export interface ExitConfig {
  /** Lock profit at 85-90c. */
  profitTargetCents: number;
  /** "Odds stall at 60-70c" band. */
  stallBandLow: number;
  stallBandHigh: number;
  /** Below this the guide holds to resolution rather than locking the loss. */
  acceptLossBelowCents: number;
  /** Hysteresis/grace window in seconds tolerated when bid briefly flickers outside stall band. */
  stallGraceSeconds: number;
}

export interface RiskConfig {
  maxConcurrentPositions: number;
  /** Guide: 3-6 markets per day out of 96. */
  maxTradesPerDay: number;
  /** Two losses in a row in chop means stop for the day. */
  maxConsecutiveLosses: number;
  dailyLossLimitPct: number;
  maxDrawdownPct: number;
  cooldownAfterLossSec: number;
}

export interface NewsConfig {
  /** Block entries this many minutes either side of a scheduled event. */
  blackoutMinutes: number;
  /** ISO timestamps, e.g. "2026-11-03T18:00:00Z". */
  events: string[];
}

export interface BotConfig {
  asset: string;
  intervals: Interval[];
  bankrollUsd: number;
  live: boolean;
  /** Main loop cadence. */
  pollIntervalMs: number;
  /** Gamma event metadata refresh (books refresh every tick). */
  marketRefreshMs: number;
  /** How much price history to keep in memory. */
  historyMs: number;
  /** Volatility lookback used for the probability model. */
  volatilityLookbackMs: number;
  /** Entry won't be attempted twice on the same market after a skip like this. */
  minCycleLogMs: number;
  intervalParams: Record<Interval, IntervalParams>;
  entry: EntryConfig;
  exit: ExitConfig;
  risk: RiskConfig;
  news: NewsConfig;
  dataDir: string;
}

export const DEFAULT_CONFIG: BotConfig = {
  asset: "btc",
  intervals: ["15m", "5m"],
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
    events: [],
  },
  dataDir: ".state",
};

export type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Json, override: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isObject(value) && isObject(current) ? deepMerge(current, value) : value;
  }
  return out;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Defaults, then `bot/config.json` (if present), then environment overrides.
 * Secrets are only read for live trading and never written to state.
 */
export function loadConfig(overrides: { live?: boolean } = {}): BotConfig {
  let config: BotConfig = structuredClone(DEFAULT_CONFIG);

  const configPath = `${BOT_ROOT}config.json`;
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (isObject(parsed)) {
      config = deepMerge(config as unknown as Json, parsed) as unknown as BotConfig;
      // Record maps need real defaults if the file replaced them partially.
      config.intervalParams = {
        "15m": { ...DEFAULT_CONFIG.intervalParams["15m"], ...(config.intervalParams?.["15m"] ?? {}) },
        "5m": { ...DEFAULT_CONFIG.intervalParams["5m"], ...(config.intervalParams?.["5m"] ?? {}) },
      };
      config.entry = { ...DEFAULT_CONFIG.entry, ...config.entry };
      config.exit = { ...DEFAULT_CONFIG.exit, ...config.exit };
      config.risk = { ...DEFAULT_CONFIG.risk, ...config.risk };
      config.news = { ...DEFAULT_CONFIG.news, ...config.news };
    }
  }

  const env = process.env;
  config.bankrollUsd = num(env.BANKROLL_USD, config.bankrollUsd);
  config.live = overrides.live ?? bool(env.LIVE, config.live);
  config.intervals = config.intervals.filter((i): i is Interval => i === "5m" || i === "15m");
  if (config.intervals.length === 0) config.intervals = ["15m"];

  if (config.dataDir === DEFAULT_CONFIG.dataDir) {
    config.dataDir = `${BOT_ROOT}.state`;
  } else if (!config.dataDir.match(/^([A-Za-z]:|\\\\|\/)/)) {
    config.dataDir = `${BOT_ROOT}${config.dataDir}`;
  }

  return config;
}

export function intervalSeconds(interval: Interval): number {
  return interval === "5m" ? 300 : 900;
}

/** The user-editable config file, kept next to the bot. */
export const CONFIG_FILE = `${BOT_ROOT}config.json`;

/**
 * Every field the dashboard may change, with hard bounds. A typo in a form must
 * never be able to disable a risk limit, so values are clamped, not trusted.
 */
const EDITABLE: Record<string, [number, number]> = {
  bankrollUsd: [10, 10_000_000],
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

function setPath(target: Json, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!isObject(next)) cursor[part] = {};
    cursor = cursor[part] as Json;
  }
  cursor[parts[parts.length - 1]!] = value;
}

/**
 * Filters a dashboard patch to editable paths and clamps every number. Unknown
 * keys are dropped rather than written, so the UI cannot reach config we did not
 * intend to expose.
 */
export function normalizeConfigPatch(patch: Json): { changes: Json; warnings: string[] } {
  const changes: Json = {};
  const warnings: string[] = [];

  for (const [path, [min, max]] of Object.entries(EDITABLE)) {
    if (!(path in patch)) continue;
    const raw = patch[path];
    const parsed = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(parsed)) {
      warnings.push(`${path}: not a number, ignored`);
      continue;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    if (clamped !== parsed) warnings.push(`${path}: clamped to ${clamped}`);
    setPath(changes, path, clamped);
  }

  if (Array.isArray(patch.intervals)) {
    const intervals = patch.intervals.filter((value): value is Interval => value === "5m" || value === "15m");
    if (intervals.length > 0) changes.intervals = intervals;
    else warnings.push("intervals: keep at least one of 5m/15m");
  }

  if (Array.isArray(patch["news.events"])) {
    const events = patch["news.events"].filter(
      (value): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)),
    );
    setPath(changes, "news.events", events);
  }

  return { changes, warnings };
}

/** Deep-merges validated changes into bot/config.json. */
export function writeConfigChanges(changes: Json): void {
  const existing = existsSync(CONFIG_FILE) ? (JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Json) : {};
  const merged = deepMerge(existing, changes);
  writeFileSync(CONFIG_FILE, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

/** The config shape the dashboard is allowed to see and edit. */
export function publicConfig(config: BotConfig) {
  return {
    asset: config.asset,
    intervals: config.intervals,
    mode: config.live ? ("live" as const) : ("paper" as const),
    bankrollUsd: config.bankrollUsd,
    entry: config.entry,
    exit: config.exit,
    risk: config.risk,
    news: config.news,
    intervalParams: config.intervalParams,
  };
}
