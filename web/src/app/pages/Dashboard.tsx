import { Activity, ArrowDownRight, ArrowUpRight, Pause, Play, RotateCcw, Target, TrendingUp } from 'lucide-react'
import { Link } from 'react-router'
import { useState } from 'react'

import { AreaChart } from '../components/charts'
import { Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, Skeleton, useToast } from '../components/ui'
import { useBotControl, useBotKpis, useBotSnapshot, useResetBot, useStartBot, useStopBot } from '../lib/bot'
import { cx } from '../lib/cx'
import { money, relativeTime } from '../lib/format'

const clock = (ts: string | number) =>
  new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })

export function Dashboard() {
  const kpis = useBotKpis()
  const control = useBotControl()
  const snapshot = useBotSnapshot()
  const start = useStartBot()
  const stop = useStopBot()
  const reset = useResetBot()
  const toast = useToast()
  const [confirmReset, setConfirmReset] = useState(false)

  const running = control.data?.running ?? false
  const data = snapshot.data?.snapshot ?? null
  const stats = kpis.data?.kpis ?? null
  const mode = control.data?.mode ?? data?.mode ?? 'paper'
  const lastSeenMs = control.data?.snapshotAgeMs != null && control.dataUpdatedAt > 0 ? control.dataUpdatedAt - control.data.snapshotAgeMs : null

  return (
    <div className="mx-auto max-w-[1200px] p-5 sm:p-8">
      <PageHeader
        title="Bot dashboard"
        subtitle="Polymarket BTC Up/Down — the 5- and 15-minute strategy, end to end."
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={running ? 'success' : 'neutral'} dot>
              {running ? 'Running' : 'Stopped'}
            </Badge>
            <Badge tone={mode === 'live' ? 'danger' : 'warning'}>{mode === 'live' ? 'LIVE money' : 'Paper'}</Badge>
            <Button
              variant={running ? 'secondary' : 'primary'}
              size="sm"
              loading={start.isPending || stop.isPending}
              onClick={() =>
                running
                  ? stop.mutate(undefined, { onSuccess: () => toast('Bot stopped') })
                  : start.mutate(undefined, {
                      onSuccess: (result) =>
                        toast(result.reason === 'already-running' ? 'Bot already running' : 'Paper bot started'),
                    })
              }
            >
              {running ? <Pause /> : <Play />}
              {running ? 'Stop bot' : 'Start bot'}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Reset bot" onClick={() => setConfirmReset(true)}>
              <RotateCcw />
            </Button>
          </div>
        }
      />

      {!running && (
        <Card className="mt-4 flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-tile bg-warning-soft text-warning">
              <Activity className="size-4.5" />
            </span>
            <div>
              <p className="text-[13.5px] font-medium">The bot is not running</p>
              <p className="text-[12.5px] text-muted">
                Start it to begin scanning the 5- and 15-minute windows. It starts in paper mode — live trading stays a
                deliberate CLI command.
                {lastSeenMs !== null && <> Last heartbeat {relativeTime(lastSeenMs)}.</>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => start.mutate(undefined, { onSuccess: () => toast('Paper bot started') })} loading={start.isPending}>
              <Play /> Start paper bot
            </Button>
            <Link to="/config" className="text-[12.5px] text-muted hover:text-fg">
              Check settings
            </Link>
          </div>
        </Card>
      )}

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.isLoading || !stats ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-card" />)
        ) : (
          <>
            <Stat label="Equity" value={money(stats.equityUsd)} hint={`from ${money(stats.bankrollUsd)}`} tone={stats.equityUsd >= stats.bankrollUsd ? 'success' : 'danger'} />
            <Stat label="Net PnL" value={money(stats.netPnlUsd)} hint={`${stats.closedTrades} closed trades`} tone={stats.netPnlUsd >= 0 ? 'success' : 'danger'} />
            <Stat label="Win rate" value={`${Math.round(stats.winRate * 100)}%`} hint={`${stats.wins}W · ${stats.losses}L`} />
            <Stat label="Open positions" value={String(stats.openPositions)} hint={data ? `${money(data.exposureUsd)} exposure` : 'no live snapshot'} />
          </>
        )}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[14px] font-semibold">Equity curve</h2>
              <p className="text-[12.5px] text-muted">Closed-trade equity, starting from the bankroll.</p>
            </div>
            <span className="text-[12.5px] text-faint">{stats?.closedTrades ?? 0} trades</span>
          </div>
          <div className="mt-4">
            {stats && stats.equitySeries.length > 1 ? (
              <AreaChart data={stats.equitySeries.map((point) => ({ label: clock(point.ts), value: point.equity }))} />
            ) : (
              <div className="grid h-[220px] place-items-center text-[13px] text-muted">
                The curve starts after the first closed trade.
              </div>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Edge</h2>
            <TrendingUp className="size-4 text-faint" />
          </div>
          {stats ? (
            <ul className="mt-4 space-y-3 text-[13px]">
              <Row label="Profit factor" value={Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'} />
              <Row label="Average win" value={money(stats.avgWinUsd)} tone="success" />
              <Row label="Average loss" value={money(stats.avgLossUsd)} tone="danger" />
              <Row label="Largest win" value={money(stats.largestWinUsd)} tone="success" />
              <Row label="Largest loss" value={money(stats.largestLossUsd)} tone="danger" />
            </ul>
          ) : (
            <Skeleton className="mt-4 h-[150px]" />
          )}
          <p className="mt-4 text-[12px] text-faint">
            The guide expects a 55–65% win rate with wins about 2–3x losses. Anything far outside that means execution
            drifted from the rules.
          </p>
        </Card>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold">Recent closed trades</h2>
            <Link to="/live" className="text-[12.5px] text-muted hover:text-fg">
              Live view
            </Link>
          </div>
          {stats && stats.recentClosed.length > 0 ? (
            <div className="scrollbar-thin mt-3 overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-[13px]">
                <thead className="text-[11.5px] uppercase tracking-wide text-faint">
                  <tr className="border-b border-line">
                    <th className="py-2 font-medium">When</th>
                    <th className="py-2 font-medium">Window</th>
                    <th className="py-2 font-medium">Side</th>
                    <th className="py-2 font-medium">Result</th>
                    <th className="py-2 text-right font-medium">PnL</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {stats.recentClosed.map((trade, index) => (
                    <tr key={`${trade.ts}-${index}`}>
                      <td className="py-2.5 tabular-nums text-muted">{relativeTime(Date.parse(trade.ts))}</td>
                      <td className="py-2.5 text-muted">{trade.interval ?? '—'}</td>
                      <td className="py-2.5">{trade.side ?? '—'}</td>
                      <td className="py-2.5 text-muted">{trade.reason === 'won' ? 'Won' : trade.reason === 'lost' ? 'Lost' : (trade.reason ?? '—').replace(/-/g, ' ')}</td>
                      <td className={cx('py-2.5 text-right font-medium tabular-nums', (trade.pnlUsd ?? 0) >= 0 ? 'text-success' : 'text-danger')}>
                        {money(trade.pnlUsd ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={<Target />} title="No closed trades yet" description="The strategy trades 3–6 times a day, so quiet stretches are normal." />
          )}
        </Card>

        <Card className="p-5">
          <h2 className="text-[14px] font-semibold">By window</h2>
          {stats ? (
            <ul className="mt-4 space-y-4">
              {(['15m', '5m'] as const).map((interval) => {
                const bucket = stats.byInterval.find((entry) => entry.interval === interval)
                const trades = bucket?.trades ?? 0
                const wins = bucket?.wins ?? 0
                return (
                  <li key={interval}>
                    <div className="flex items-center justify-between text-[13px]">
                      <span className="font-medium">{interval} windows</span>
                      <span className={cx('tabular-nums', (bucket?.pnlUsd ?? 0) >= 0 ? 'text-success' : 'text-danger')}>
                        {money(bucket?.pnlUsd ?? 0)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[12px] text-faint">
                      {trades === 0 ? 'No trades yet' : `${trades} trades · ${wins} wins · ${Math.round((wins / trades) * 100)}%`}
                    </p>
                  </li>
                )
              })}
            </ul>
          ) : (
            <Skeleton className="mt-4 h-[110px]" />
          )}
          <div className="mt-5 border-t border-line pt-4">
            <p className="text-[12px] text-muted">
              Rules, timing and thresholds live in <Link to="/strategy" className="font-medium text-fg hover:underline">Strategy</Link> and{' '}
              <Link to="/config" className="font-medium text-fg hover:underline">Configuration</Link>.
            </p>
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        loading={reset.isPending}
        title="Reset the bot?"
        description={`This wipes every open position, trade and risk counter and restarts at ${money(stats?.bankrollUsd ?? 1000)}. It cannot be undone.`}
        confirmLabel="Reset to clean state"
        onConfirm={() =>
          reset.mutate(undefined, {
            onSuccess: (result) => {
              setConfirmReset(false)
              toast(`Bot reset to ${money(result.bankrollUsd)} — trades and positions wiped`)
            },
          })
        }
      />
    </div>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: 'success' | 'danger' }) {
  return (
    <Card className="flex h-[104px] flex-col justify-between p-4">
      <p className="text-[13px] text-muted">{label}</p>
      <div>
        <p className={cx('text-[22px] font-semibold tracking-[-0.02em] tabular-nums', tone === 'danger' && 'text-danger')}>{value}</p>
        <p className="mt-0.5 truncate text-[12px] text-faint">{hint}</p>
      </div>
    </Card>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'danger' }) {
  return (
    <li className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      <span className={cx('font-medium tabular-nums', tone === 'success' && 'text-success', tone === 'danger' && 'text-danger')}>
        {tone === 'success' ? <ArrowUpRight className="mr-0.5 inline size-3.5" /> : null}
        {tone === 'danger' ? <ArrowDownRight className="mr-0.5 inline size-3.5" /> : null}
        {value}
      </span>
    </li>
  )
}
