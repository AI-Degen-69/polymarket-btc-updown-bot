import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Interval } from "./types.ts";
import { DEFAULT_CONFIG as DEFAULT_CONFIG_RAW, EDITABLE } from "./defaults.ts";

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

export const DEFAULT_CONFIG: BotConfig = DEFAULT_CONFIG_RAW;

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
