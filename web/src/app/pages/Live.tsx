import { Activity, Clock, Play, ShieldAlert, Target, Zap } from 'lucide-react'

import { PolymarketLiveChart } from '../components/PolymarketEmbed'
import { eventMetrics, KIND_TONE, reasonLabel as label } from '../lib/labels'
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton, useToast } from '../components/ui'
import {
  useBotEvents,
  useBotSnapshot,
  useBotTrades,
  useSetKillSwitch,
  useResumeBot,
  type BotEvent,
  type BotSnapshot,
  type BotTrade,
  type PositionView,
} from '../lib/bot'
import { cx } from '../lib/cx'

const money = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(2)}`
const cents = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `${Math.round(value * 100)}¢`
const clock = (ts: number | string) =>
  new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

function windowLabel(slug: string): string {
  const parts = slug.split('-')
  const epoch = Number(parts[parts.length - 1])
  const interval = parts[parts.length - 2]
  return Number.isFinite(epoch) ? `${interval} ${clock(epoch * 1000)}` : slug
}

function MetricChip({ text, limit }: { text: string; limit?: string }) {
  return (
    <span className="flex items-baseline gap-1 rounded-[7px] bg-surface-2 px-1.5 py-0.5 tabular-nums">
      <span className="text-[11px] font-medium text-fg">{text}</span>
      {limit && <span className="text-[10.5px] text-faint">{limit}</span>}
    </span>
  )
}

export function Live() {
  const snapshot = useBotSnapshot()
  const events = useBotEvents()
  const trades = useBotTrades()
  const killSwitch = useSetKillSwitch()

  const data = snapshot.data?.snapshot ?? null
  const online = Boolean(snapshot.data?.online && data)
  const stopped = data?.killSwitch ?? false

  return (
    <div className="mx-auto max-w-[1200px] p-5 sm:p-8">
      <PageHeader
        title="Live bot"
        subtitle="What it sees right now, why it decides, and every fill it made."
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={online ? 'success' : 'neutral'} dot>
              {online ? 'Streaming' : 'No signal'}
            </Badge>
            {data && <Badge tone={data.mode === 'live' ? 'danger' : 'warning'}>{data.mode === 'live' ? 'LIVE money' : 'Paper'}</Badge>}
            {data && (
              <Button
                variant={stopped ? 'primary' : 'danger'}
                size="sm"
                loading={killSwitch.isPending}
                onClick={() => killSwitch.mutate(!stopped)}
              >
                {stopped ? <Play /> : <ShieldAlert />}
                {stopped ? 'Resume entries' : 'Pause entries'}
              </Button>
            )}
          </div>
        }
      />

      {snapshot.isLoading ? (
        <Skeleton className="mt-6 h-[260px] rounded-card" />
      ) : !online ? (
        <Card className="mt-6 p-6">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-card bg-warning-soft text-warning">
              <Activity className="size-5" />
            </span>
            <div>
              <h2 className="text-[15px] font-semibold">Waiting for the bot</h2>
              <p className="mt-1 text-[13.5px] text-muted">
                Start the bot from the dashboard. This page fills in on its own within a couple of seconds.
              </p>
            </div>
          </div>
        </Card>
      ) : (
        data && (
          <>
            <Card className="mt-3 flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <p className="text-[11.5px] uppercase tracking-wide text-faint">BTC reference price</p>
                <p className="text-[24px] font-semibold tracking-[-0.02em] tabular-nums">
                  {data.feed.price === null ? '—' : data.feed.price.toFixed(2)}
                </p>
              </div>
              <div className="h-14 w-full max-w-[440px]">
                <Spark points={data.feed.history} />
              </div>
              <p className="text-[12px] text-faint">
                <Clock className="mr-1 inline size-3.5" />
                updated {data.feed.updatedAtMs ? clock(data.feed.updatedAtMs) : '—'}
              </p>
            </Card>

            <PolymarketLiveChart markets={data.markets} positions={data.positions} />

            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              <Card className="p-5 lg:col-span-2">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-[14px] font-semibold">Decision journal</h2>
                    <p className="text-[12.5px] text-muted">Every gate it passed or failed, newest first.</p>
                  </div>
                  <Badge tone="neutral">{events.data?.items.length ?? 0} events</Badge>
                </div>
                <div className="scrollbar-thin mt-2 max-h-[440px] overflow-y-auto">
                  {events.data && events.data.items.length > 0 ? (
                    <ul className="divide-y divide-line">
                      {[...events.data.items].reverse().map((event, index) => (
                        <EventRow key={`${event.ts}-${index}`} event={event} />
                      ))}
                    </ul>
                  ) : events.isError ? (
                    <EmptyState
                      icon={<Activity />}
                      title="Bot API not reachable"
                      description="Nothing came back from 127.0.0.1:8788. Start it with `bun run dashboard`; this list refills as soon as it answers."
                    />
                  ) : (
                    <EmptyState icon={<Activity />} title="No decisions logged yet" description="Entries, exits, holds and skips appear here as the bot ticks." />
                  )}
                </div>
              </Card>

              <div className="flex flex-col gap-3">
                <Positions data={data} />
                <RiskPanel data={data} />
              </div>
            </div>

            <Trades items={trades.data?.items ?? []} />
          </>
        )
      )}
    </div>
  )
}

function EventRow({ event }: { event: BotEvent }) {
  const metrics = eventMetrics(event.reason, event.detail)

  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="mt-0.5 w-[58px] shrink-0 text-[11.5px] tabular-nums text-faint">{clock(event.ts)}</span>
      <Badge tone={KIND_TONE[event.kind] ?? 'neutral'} className="shrink-0 capitalize">
        {event.kind}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px]">{label(event.reason)}</p>
        <p className="truncate text-[11.5px] text-faint">
          {event.slug ? windowLabel(event.slug) : 'bot'}
          {event.side ? ` · ${event.side}` : ''}
        </p>
      </div>
      {metrics.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {metrics.map((metric) => (
            <MetricChip key={metric.text} text={metric.text} limit={metric.limit} />
          ))}
        </div>
      )}
    </li>
  )
}

function Positions({ data }: { data: BotSnapshot }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold">Open positions</h2>
        <Badge tone={data.positions.length > 0 ? 'accent' : 'neutral'}>{data.positions.length}</Badge>
      </div>
      {data.positions.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted">Flat. The bot only holds a position when every entry gate passes.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {data.positions.map((position) => (
            <PositionRow key={position.id} position={position} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function PositionRow({ position }: { position: PositionView }) {
  const pnl = position.unrealizedPnlUsd
  const resolving = pnl == null
  return (
    <li className="py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={position.side === 'Up' ? 'success' : 'danger'}>{position.side}</Badge>
          <span className="text-[12.5px] text-muted">{windowLabel(position.slug)}</span>
        </div>
        <span className={cx('text-[13px] font-semibold tabular-nums', resolving ? 'text-faint' : pnl! >= 0 ? 'text-success' : 'text-danger')}>
          {resolving ? 'resolving…' : money(pnl)}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-2 text-[12px] text-muted">
        <span>
          {position.shares} @ {cents(position.entryPrice)}
        </span>
        <span>mark {position.mark == null ? '—' : cents(position.mark)}</span>
        <span className="text-right">{Math.max(0, Math.round(position.secondsLeft))}s left</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11.5px] text-faint">
        <span>p {position.modelProb.toFixed(3)}</span>
        <span>edge {(position.edge * 100).toFixed(1)}¢</span>
        {position.stalledSec !== null && <span className="text-warning">stalled {Math.round(position.stalledSec)}s</span>}
      </div>
    </li>
  )
}

function RiskPanel({ data }: { data: BotSnapshot }) {
  const { risk, limits } = data
  const resume = useResumeBot()
  const toast = useToast()
  const dayLoss = Math.max(0, risk.dayStartEquityUsd - data.equityUsd)
  const dayLimit = (risk.dayStartEquityUsd * limits.dailyLossLimitPct) / 100
  const drawdown = Math.max(0, risk.highWaterEquityUsd - data.equityUsd)
  const drawdownLimit = (risk.highWaterEquityUsd * limits.maxDrawdownPct) / 100
  const cooldownLeft = Math.max(0, Math.round((risk.cooldownUntilMs - Date.now()) / 1000))

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold">Risk limits</h2>
        <Zap className="size-4 text-faint" />
      </div>
      <ul className="mt-3 space-y-3">
        <Limit label="Trades today" value={`${risk.tradesToday} / ${limits.maxTradesPerDay}`} ratio={risk.tradesToday / limits.maxTradesPerDay} />
        <Limit
          label="Losses in a row"
          value={`${risk.consecutiveLosses} / ${limits.maxConsecutiveLosses}`}
          ratio={risk.consecutiveLosses / limits.maxConsecutiveLosses}
        />
        <Limit label="Daily loss" value={`${money(dayLoss)} of ${money(dayLimit)}`} ratio={dayLimit > 0 ? dayLoss / dayLimit : 0} />
        <Limit label="Drawdown" value={`${money(drawdown)} of ${money(drawdownLimit)}`} ratio={drawdownLimit > 0 ? drawdown / drawdownLimit : 0} />
      </ul>

      <div className="mt-4 space-y-1.5 text-[12px] text-muted">
        <p>Entry needs {(limits.minEdge * 100).toFixed(0)}¢ edge after a {(limits.feeRate * 100).toFixed(0)}% taker fee.</p>
        <p>Profit target {cents(limits.profitTargetCents)}; one position at a time.</p>
      </div>

      {risk.halted && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-tile bg-danger-soft p-2.5 text-[12.5px] text-danger">
          <span>Halted for the day: {label(risk.haltReason)}</span>
          <Button
            size="sm"
            variant="secondary"
            loading={resume.isPending}
            onClick={() =>
              resume.mutate(undefined, {
                onSuccess: () => toast('Risk halt cleared and entries resumed'),
                onError: (err: Error) => toast(err.message, 'danger'),
              })
            }
          >
            Clear halt & resume
          </Button>
        </div>
      )}
      {cooldownLeft > 0 && !risk.halted && (
        <p className="mt-3 rounded-tile bg-warning-soft px-2.5 py-2 text-[12.5px] text-warning">
          Cooling down after a loss — {cooldownLeft}s left
        </p>
      )}
      {data.newsBlocked && <p className="mt-3 rounded-tile bg-info-soft px-2.5 py-2 text-[12.5px] text-info">News blackout active</p>}
    </Card>
  )
}

function Limit({ label: limitLabel, value, ratio }: { label: string; value: string; ratio: number }) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0))
  return (
    <li>
      <div className="flex items-center justify-between text-[12.5px]">
        <span className="text-muted">{limitLabel}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cx('h-full rounded-full', clamped >= 1 ? 'bg-danger' : clamped > 0.66 ? 'bg-warning' : 'bg-accent')}
          style={{ width: `${clamped * 100}%` }}
        />
      </div>
    </li>
  )
}

function Trades({ items }: { items: BotTrade[] }) {
  return (
    <Card className="mt-3 p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[14px] font-semibold">Fills</h2>
          <p className="text-[12.5px] text-muted">Every entry, exit and settlement, newest first.</p>
        </div>
        <Badge tone="neutral">{items.length}</Badge>
      </div>

      {items.length === 0 ? (
        <EmptyState icon={<Target />} title="No fills yet" description="The strategy trades 3–6 times a day, so long quiet stretches are normal." />
      ) : (
        <div className="scrollbar-thin mt-3 overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-[13px]">
            <thead className="text-[11.5px] uppercase tracking-wide text-faint">
              <tr className="border-b border-line">
                <th className="py-2 font-medium">Time</th>
                <th className="py-2 font-medium">Event</th>
                <th className="py-2 font-medium">Window</th>
                <th className="py-2 font-medium">Side</th>
                <th className="py-2 text-right font-medium">Price</th>
                <th className="py-2 text-right font-medium">Shares</th>
                <th className="py-2 text-right font-medium">PnL</th>
                <th className="py-2 font-medium">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {[...items].reverse().map((trade, index) => (
                <tr key={`${trade.ts}-${index}`}>
                  <td className="py-2.5 tabular-nums text-muted">{clock(trade.ts)}</td>
                  <td className="py-2.5">
                    <Badge tone={KIND_TONE[trade.kind] ?? 'neutral'} className="capitalize">
                      {trade.kind}
                    </Badge>
                  </td>
                  <td className="py-2.5 text-muted">{trade.slug ? windowLabel(trade.slug) : '—'}</td>
                  <td className="py-2.5">{trade.side ?? '—'}</td>
                  <td className="py-2.5 text-right tabular-nums">{cents(trade.price)}</td>
                  <td className="py-2.5 text-right tabular-nums">{trade.shares ?? '—'}</td>
                  <td
                    className={cx(
                      'py-2.5 text-right font-medium tabular-nums',
                      trade.pnlUsd === undefined ? 'text-faint' : trade.pnlUsd >= 0 ? 'text-success' : 'text-danger',
                    )}
                  >
                    {trade.pnlUsd === undefined ? '—' : money(trade.pnlUsd)}
                  </td>
                  <td className="py-2.5 text-muted">{label(trade.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function Spark({ points }: { points: { ts: number; value: number }[] }) {
  if (points.length < 2) {
    return <div className="grid h-full place-items-center text-[12px] text-faint">collecting price…</div>
  }
  const values = points.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const width = 440
  const height = 56
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${(index / (points.length - 1)) * width},${height - ((point.value - min) / span) * (height - 4) - 2}`)
    .join(' ')
  const up = values[values.length - 1] >= values[0]

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden>
      <path d={path} fill="none" stroke={up ? 'var(--color-success)' : 'var(--color-danger)'} strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
