#!/usr/bin/env bun
import { existsSync, rmSync } from "node:fs";
import { BOT_ROOT, loadConfig, type BotConfig } from "./config.ts";
import { Engine } from "./engine.ts";
import { PaperExchange } from "./exchange.ts";
import { LiveExchange } from "./exchangeLive.ts";
import { log, money } from "./log.ts";
import { PriceFeed } from "./priceFeed.ts";
import { Store } from "./state.ts";
import { Journal } from "./telemetry.ts";

const argv = process.argv.slice(2);
const command = argv.find((arg) => !arg.startsWith("-")) ?? "scan";
const hasFlag = (name: string): boolean => argv.includes(`--${name}`);
const flagValue = (name: string, fallback: string): string => {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
};

function printRules(config: BotConfig): void {
  const { entry, risk, exit } = config;
  log("info", "strategy", {
    asset: config.asset,
    intervals: config.intervals.join("+"),
    observe15m: `${config.intervalParams["15m"].observationSeconds}s`,
    observe5m: `${config.intervalParams["5m"].observationSeconds}s`,
    holdDirection: `${config.intervalParams["15m"].minDirectionHoldSeconds}s / ${config.intervalParams["5m"].minDirectionHoldSeconds}s`,
    minEdge: entry.minEdge,
    minMovePct: entry.minMovePct,
    maxSpreadCents: entry.maxSpreadCents,
    kelly: entry.kellyCut,
    maxPositionPct: entry.maxPositionPct,
    profitTarget: exit.profitTargetCents,
    maxTradesPerDay: risk.maxTradesPerDay,
    maxConsecutiveLosses: risk.maxConsecutiveLosses,
    dailyLossLimitPct: risk.dailyLossLimitPct,
    bankroll: money(config.bankrollUsd),
  });
}

async function main(): Promise<void> {
  if (command === "status") {
    const config = loadConfig();
    const store = new Store(config.dataDir);
    const state = store.load(config.bankrollUsd, config.risk.dailyLossLimitPct);
    const equity = state.bankrollUsd + state.risk.realizedPnlUsd;
    log("info", "status", {
      mode: config.live ? "live" : "paper",
      equity: money(equity),
      realized: money(state.risk.realizedPnlUsd),
      tradesToday: state.risk.tradesToday,
      consecutiveLosses: state.risk.consecutiveLosses,
      halted: state.risk.halted,
      haltReason: state.risk.haltReason ?? "-",
      openPositions: state.positions.length,
      killSwitch: store.killSwitchActive(),
    });
    for (const position of state.positions) {
      log("info", "open position", {
        slug: position.slug,
        side: position.side,
        shares: position.shares,
        entry: position.entryPrice,
        cost: money(position.costUsd),
      });
    }
    for (const trade of store.readTrades(10)) {
      log(trade.kind, `${trade.slug ?? "-"} ${trade.side ?? ""}`.trim(), {
        price: trade.price,
        shares: trade.shares,
        pnl: trade.pnlUsd === undefined ? undefined : money(trade.pnlUsd),
        reason: trade.reason,
      });
    }
    return;
  }

  if (command === "reset") {
    const config = loadConfig();
    const store = new Store(config.dataDir);
    store.ensure();
    if (existsSync(store.statePath)) rmSync(store.statePath);
    if (existsSync(store.tradesPath)) rmSync(store.tradesPath);
    log("info", "state cleared", { dir: config.dataDir });
    return;
  }

  if (command !== "scan" && command !== "run") {
    process.stderr.write(`Unknown command "${command}". Use: scan | run | status | reset\n`);
    process.exit(1);
  }

  const live = command === "run" && (hasFlag("live") || process.env.LIVE === "true");
  const config = loadConfig({ live });
  // `scan` is a bounded dry run by default; `run` keeps going until stopped.
  const minutes = Number(flagValue("minutes", hasFlag("once") ? "0.05" : command === "scan" ? "60" : "0"));
  const durationMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined;

  printRules(config);
  if (live) {
    log("risk", "LIVE TRADING ENABLED — real funds", {
      wallet: process.env.POLYMARKET_WALLET_ADDRESS ?? "signer-default",
      bankroll: money(config.bankrollUsd),
    });
  } else {
    log("info", "paper mode (no orders are sent to Polymarket)");
  }

  const exchange = live
    ? await LiveExchange.create({
        privateKey: process.env.POLYMARKET_PRIVATE_KEY,
        walletAddress: process.env.POLYMARKET_WALLET_ADDRESS,
        feeRate: config.entry.feeRate,
      })
    : new PaperExchange(config.entry.feeRate);

  const feed = new PriceFeed({ pollMs: config.pollIntervalMs, historyMs: config.historyMs });
  const store = new Store(config.dataDir);
  // `scan` stays a dry run; `run` publishes the snapshot and decision journal
  // that the dashboard reads.
  const journal = command === "run" ? new Journal(config.dataDir) : undefined;

  const engine = new Engine({
    config,
    feed,
    exchange,
    store,
    journal,
    persist: command === "run",
  });

  const heartbeat = setInterval(() => engine.describe(Date.now()), 30_000);
  process.on("SIGINT", () => {
    log("info", "stopping…");
    engine.stop();
    clearInterval(heartbeat);
  });

  await engine.run({ durationMs });
  clearInterval(heartbeat);
  engine.describe(Date.now());
}

await main().catch((error: unknown) => {
  log("error", "fatal", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});

if (!existsSync(`${BOT_ROOT}src`)) {
  log("error", "unexpected layout", { botRoot: BOT_ROOT });
}
