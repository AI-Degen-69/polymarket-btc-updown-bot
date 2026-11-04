#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BOT_ROOT, loadConfig, normalizeConfigPatch, publicConfig, writeConfigChanges, type Json } from "./config.ts";
import { log } from "./log.ts";
import { Store } from "./state.ts";
import { Journal, type BotEvent, type BotSnapshot } from "./telemetry.ts";
import type { Interval, TradeRecord } from "./types.ts";

/**
 * Local API for the bot console. It listens on loopback only, only touches files
 * the bot already uses, and never holds a trading key. It can start the paper
 * loop, but live trading stays a deliberate `--live` CLI decision.
 */
let config = loadConfig();
const store = new Store(config.dataDir);
const journal = new Journal(config.dataDir);
const port = Number(process.env.DASHBOARD_PORT ?? 8788);
const hostname = "127.0.0.1";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** How old a snapshot may be before the bot counts as stopped. */
const STALE_AFTER_MS = 30_000;

// ------------------------------------------------------------------ file reads

function readSnapshot(): BotSnapshot | null {
  if (!existsSync(journal.snapshotPath)) return null;
  try {
    return JSON.parse(readFileSync(journal.snapshotPath, "utf8")) as BotSnapshot;
  } catch {
    return null;
  }
}

function readLines<T>(path: string, limit: number): T[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * Read-only view of the engine's state: this must never call Store.load(), which
 * would create and save a fresh state and could reset a live bot.
 */
function summarizeState() {
  if (!existsSync(store.statePath)) return { available: false as const };
  try {
    const state = JSON.parse(readFileSync(store.statePath, "utf8")) as {
      updatedAt?: string;
      bankrollUsd?: number;
      positions?: unknown[];
      risk?: {
        realizedPnlUsd?: number;
        tradesToday?: number;
        consecutiveLosses?: number;
        halted?: boolean;
        haltReason?: string | null;
      };
    };
    return {
      available: true as const,
      updatedAt: state.updatedAt,
      bankrollUsd: state.bankrollUsd ?? config.bankrollUsd,
      openPositions: state.positions?.length ?? 0,
      realizedPnlUsd: state.risk?.realizedPnlUsd ?? 0,
      tradesToday: state.risk?.tradesToday ?? 0,
      consecutiveLosses: state.risk?.consecutiveLosses ?? 0,
      halted: state.risk?.halted ?? false,
      haltReason: state.risk?.haltReason ?? null,
    };
  } catch {
    return { available: false as const };
  }
}

// ------------------------------------------------------------------------ KPIs

function buildKpis() {
  const state = summarizeState();
  const snapshot = readSnapshot();
  const bankroll =
    snapshot?.bankrollUsd ?? (state.available ? (state.bankrollUsd ?? config.bankrollUsd) : config.bankrollUsd);
  const trades = readLines<TradeRecord>(store.tradesPath, 5_000);
  const closed = trades
    .filter((trade) => typeof trade.pnlUsd === "number")
    .slice()
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const tradePnlSum = closed.reduce((sum, trade) => sum + (trade.pnlUsd ?? 0), 0);
  const engineRealizedPnl = snapshot?.realizedPnlUsd ?? (state.available ? state.realizedPnlUsd ?? 0 : 0);
  const realizedPnlUsd = engineRealizedPnl !== 0 ? engineRealizedPnl : tradePnlSum;
  const equityUsd =
    snapshot && Math.abs(snapshot.equityUsd - (bankroll + realizedPnlUsd)) < 1
      ? snapshot.equityUsd
      : bankroll + realizedPnlUsd;

  let curveEquity = bankroll;
  const equitySeries: { ts: number; equity: number }[] = [];
  if (closed.length > 0 && closed[0]) {
    const firstTradeTs = Date.parse(closed[0].ts) - 60_000;
    equitySeries.push({ ts: firstTradeTs, equity: Math.round(curveEquity * 100) / 100 });
  } else {
    equitySeries.push({ ts: Date.now(), equity: Math.round(curveEquity * 100) / 100 });
  }
  const byInterval = new Map<Interval, { trades: number; wins: number; pnlUsd: number }>();
  let wins = 0;
  let losses = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let largestWin = 0;
  let largestLoss = 0;

  for (const trade of closed) {
    const pnl = trade.pnlUsd ?? 0;
    curveEquity += pnl;
    equitySeries.push({ ts: Date.parse(trade.ts), equity: Math.round(curveEquity * 100) / 100 });

    if (pnl > 0) {
      wins += 1;
      grossWin += pnl;
      largestWin = Math.max(largestWin, pnl);
    } else if (pnl < 0) {
      losses += 1;
      grossLoss += Math.abs(pnl);
      largestLoss = Math.min(largestLoss, pnl);
    }

    if (trade.interval) {
      const bucket = byInterval.get(trade.interval) ?? { trades: 0, wins: 0, pnlUsd: 0 };
      bucket.trades += 1;
      bucket.wins += pnl > 0 ? 1 : 0;
      bucket.pnlUsd += pnl;
      byInterval.set(trade.interval, bucket);
    }
  }

  const closedTrades = closed.length;
  const tradesToday = state.available ? state.tradesToday ?? 0 : 0;
  // The engine counted fills that this directory's log cannot show: the classic
  // symptom of a dashboard pointed at a different `.state` than the bot.
  const tradeLogMissing = closedTrades === 0 && tradesToday > 0;
  return {
    bankrollUsd: bankroll,
    equityUsd: Math.round(equityUsd * 100) / 100,
    netPnlUsd: Math.round((equityUsd - bankroll) * 100) / 100,
    realizedPnlUsd: Math.round(realizedPnlUsd * 100) / 100,
    tradesToday,
    tradeLogMissing,
    dataDir: config.dataDir,
    closedTrades,
    wins,
    losses,
    winRate: closedTrades > 0 ? wins / closedTrades : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Number.POSITIVE_INFINITY : 0,
    avgWinUsd: wins > 0 ? grossWin / wins : 0,
    avgLossUsd: losses > 0 ? -grossLoss / losses : 0,
    largestWinUsd: largestWin,
    largestLossUsd: largestLoss,
    openPositions: state.available ? (state.openPositions ?? 0) : 0,
    byInterval: [...byInterval.entries()].map(([interval, value]) => ({ interval, ...value })),
    equitySeries: [...equitySeries, { ts: Date.now(), equity: Math.round(equityUsd * 100) / 100 }].slice(-200),
    recentClosed: closed.slice(-12).reverse(),
  };
}

// -------------------------------------------------------------------- control

function readPid(): number | null {
  if (!existsSync(store.pidPath)) return null;
  const pid = Number(readFileSync(store.pidPath, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function controlState() {
  const pid = readPid();
  const alive = pid !== null && isAlive(pid);
  if (pid !== null && !alive) {
    rmSync(store.pidPath, { force: true });
  }
  const snapshot = readSnapshot();
  const ageMs = snapshot ? Date.now() - Date.parse(snapshot.updatedAt) : null;
  return {
    running: alive && ageMs !== null && ageMs < STALE_AFTER_MS,
    pid: alive ? pid : null,
    snapshotAgeMs: ageMs,
    mode: snapshot?.mode ?? (config.live ? "live" : "paper"),
    logPath: store.botLogPath,
  };
}

function startBot(): { started: boolean; pid: number | null; reason?: string } {
  const current = controlState();
  if (current.running) return { started: false, pid: current.pid, reason: "already-running" };

  store.ensure();
  const fd = openSync(store.botLogPath, "a");
  // Paper loop only: going live stays a manual `bun run run --live`.
  const child = Bun.spawn({
    cmd: [process.execPath, join(BOT_ROOT, "src", "index.ts"), "run"],
    cwd: BOT_ROOT,
    env: process.env,
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
  });
  child.unref();
  writeFileSync(store.pidPath, String(child.pid), "utf8");
  return { started: true, pid: child.pid };
}

function stopBot(): { stopped: boolean; pid: number | null } {
  const pid = readPid();
  if (pid === null) return { stopped: false, pid: null };
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  rmSync(store.pidPath, { force: true });
  return { stopped: true, pid };
}

// ---------------------------------------------------------------------- server

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && isLoopbackOrigin(origin) ? origin : "http://localhost:5173";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function json(body: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

function mutationAllowed(origin: string | null): boolean {
  return !origin || isLoopbackOrigin(origin);
}

const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (url.pathname === "/" && request.method === "GET") {
      return Response.redirect("http://localhost:5173/", 302);
    }

    if (url.pathname === "/api/bot/health") {
      const snapshot = readSnapshot();
      return json(
        {
          ok: true,
          dataDir: config.dataDir,
          tradeLog: { path: store.tradesPath, exists: existsSync(store.tradesPath) },
          killSwitch: store.killSwitchActive(),
          snapshotAgeMs: snapshot ? Date.now() - Date.parse(snapshot.updatedAt) : null,
        },
        200,
        origin,
      );
    }

    if (url.pathname === "/api/bot/snapshot" && request.method === "GET") {
      const snapshot = readSnapshot();
      const ageMs = snapshot ? Date.now() - Date.parse(snapshot.updatedAt) : null;
      const online = snapshot !== null && ageMs !== null && ageMs < STALE_AFTER_MS;
      return json({ online, snapshot, ageMs, state: summarizeState() }, 200, origin);
    }

    if (url.pathname === "/api/bot/events" && request.method === "GET") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 120) || 120));
      return json({ items: readLines<BotEvent>(journal.eventsPath, limit) }, 200, origin);
    }

    if (url.pathname === "/api/bot/trades" && request.method === "GET") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 80) || 80));
      return json({ items: readLines<TradeRecord>(store.tradesPath, limit) }, 200, origin);
    }

    if (url.pathname === "/api/bot/kpis" && request.method === "GET") {
      return json({ kpis: buildKpis() }, 200, origin);
    }

    if (url.pathname === "/api/bot/control" && request.method === "GET") {
      return json(controlState(), 200, origin);
    }

    if (url.pathname === "/api/bot/config" && request.method === "GET") {
      config = loadConfig({ live: config.live });
      return json({ config: publicConfig(config), configFile: "config.json" }, 200, origin);
    }

    if (url.pathname === "/api/bot/config" && request.method === "PUT") {
      if (!mutationAllowed(origin)) return json({ error: "Cross-origin request refused." }, 403, origin);
      const body = (await request.json().catch(() => null)) as Json | null;
      if (!body) return json({ error: "Expected a JSON object." }, 400, origin);
      const { changes, warnings } = normalizeConfigPatch(body);
      if (Object.keys(changes).length === 0) return json({ error: "No editable fields in that payload.", warnings }, 400, origin);
      writeConfigChanges(changes);
      config = loadConfig({ live: config.live });
      // A running engine reloads on its next tick instead of needing a restart.
      store.ensure();
      writeFileSync(store.configMarkerPath, `${new Date().toISOString()}\n`, "utf8");
      log("info", "configuration saved via dashboard", { fields: Object.keys(changes).length, warnings: warnings.length });
      return json({ config: publicConfig(config), warnings }, 200, origin);
    }

    if (url.pathname === "/api/bot/resume" && request.method === "POST") {
      if (!mutationAllowed(origin)) return json({ error: "Cross-origin request refused." }, 403, origin);
      store.ensure();
      writeFileSync(store.resumeMarkerPath, `${new Date().toISOString()}\n`, "utf8");
      if (existsSync(store.killSwitchPath)) rmSync(store.killSwitchPath);
      log("risk", "resume requested via dashboard: clearing halts and release pause");
      return json({ ok: true, killSwitch: false }, 200, origin);
    }

    if (url.pathname === "/api/bot/kill-switch" && request.method === "POST") {
      if (!mutationAllowed(origin)) return json({ error: "Cross-origin request refused." }, 403, origin);
      const body = (await request.json().catch(() => ({}))) as { active?: unknown };
      if (typeof body.active !== "boolean") return json({ error: "active must be a boolean." }, 400, origin);
      store.ensure();
      if (body.active) writeFileSync(store.killSwitchPath, `stopped at ${new Date().toISOString()}\n`, "utf8");
      else if (existsSync(store.killSwitchPath)) rmSync(store.killSwitchPath);
      log("risk", body.active ? "kill switch engaged via dashboard" : "kill switch released via dashboard");
      return json({ killSwitch: store.killSwitchActive() }, 200, origin);
    }

    if (url.pathname === "/api/bot/reset" && request.method === "POST") {
      if (!mutationAllowed(origin)) return json({ error: "Cross-origin request refused." }, 403, origin);
      const state = store.reset(config.bankrollUsd);
      journal.clear();
      log("risk", "state reset via dashboard", { bankroll: config.bankrollUsd });
      return json({ bankrollUsd: state.bankrollUsd, resetAt: state.updatedAt }, 200, origin);
    }

    if (url.pathname === "/api/bot/start" && request.method === "POST") {
      if (!mutationAllowed(origin)) return json({ error: "Cross-origin request refused." }, 403, origin);
      const result = startBot();
      log("info", result.started ? "bot started from dashboard" : "start ignored", { pid: result.pid, reason: result.reason });
      return json({ ...controlState(), ...result }, 200, origin);
    }

    if (url.pathname === "/api/bot/stop" && request.method === "POST") {
      if (!mutationAllowed(origin)) return json({ error: "Cross-origin request refused." }, 403, origin);
      const result = stopBot();
      log("info", "bot stopped from dashboard", { pid: result.pid });
      return json({ ...controlState(), ...result }, 200, origin);
    }

    return json({ error: "Not found." }, 404, origin);
  },
});

log("info", "dashboard API listening", { url: `http://${hostname}:${server.port}`, dataDir: config.dataDir });
