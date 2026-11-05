import { Activity, ArrowUpRight, Radio, TrendingDown, TrendingUp } from 'lucide-react'
import { useRef } from 'react'

import { useBotConfig, type BotConfigView, type Interval, type MarketView, type PositionView } from '../lib/bot'
import { cx } from '../lib/cx'
import { reasonLabel } from '../lib/labels'
import { Badge, Card } from './ui'

// Polymarket's official embed only plots last-trade prints, so a market this
// quiet is stuck at its listing price forever. These panels keep the Polymarket
// credit but chart the live book instead: implied Up odds sampled every
// snapshot poll (2s) over the window, alongside the bot's own decision stats.

// Implied Up probability, normalized from asks (or either side alone).
function impliedUp(market: MarketView): number {
  const up = market.quotes.Up.ask ?? market.quotes.Up.bid
  const down = market.quotes.Down.ask ?? market.quotes.Down.bid
  if (up !== null && down !== null && up + down > 0) return up / (up + down)
  if (up !== null) return up
  if (down !== null) return 1 - down
  return 0.5
}

interface OddsPoint {
  t: number
  v: number // implied Up, 0..1
}

interface GateTick {
  atSec: number
  tone: string
  label: string
  title: string
}

const MAX_SAMPLES = 300
// shortcut: odds history is sampled in-browser only (2s poll, reset per window, lost on reload);
// upgrade to bot-persisted odds history if you need the line across refreshes.
const useOddsSeries = (market: MarketView) => {
  const series = useRef<{ slug: string; points: OddsPoint[] }>({ slug: '', points: [] })

  if (series.current.slug !== market.slug) {
    series.current = { slug: market.slug, points: [] }
  }
  const now = Date.now()
  const v = impliedUp(market)
  const points = series.current.points
  // Seed at the window open so there is a line from the first paint.
  if (points.length === 0) points.push({ t: market.startMs, v })
  else if (now - points[points.length - 1]!.t > 1_500) points.push({ t: now, v })
  if (points.length > MAX_SAMPLES) points.splice(0, points.length - MAX_SAMPLES)

  // The snapshot refetches every 2s, re-running this and re-rendering.
  return series.current.points
}

const priceCents = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)}¢`)
const pct = (value: number | null, digits = 3) => (value === null ? '-' : `${value.toFixed(digits)}%`)
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
// Elapsed time into the window, e.g. 5:00 — "passed", not "remaining".
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

export function PolymarketLiveChart({ markets, positions = [] }: { markets: MarketView[]; positions?: PositionView[] }) {
  const { data: config } = useBotConfig()

  return (
    <div className="mt-3 grid gap-3 lg:grid-cols-2">
      {markets.length === 0 ? (
        <Card className="p-5 lg:col-span-2">
          <WaitingBody />
        </Card>
      ) : (
        markets.map((market) => (
          <MarketChartPanel
            key={market.slug}
            market={market}
            position={positions.find((p) => p.slug === market.slug)}
            params={config?.config.intervalParams[market.interval] ?? null}
          />
        ))
      )}
    </div>
  )
}

function MarketChartPanel({
  market,
  position,
  params,
}: {
  market: MarketView
  position?: PositionView
  params: BotConfigView['intervalParams'][Interval] | null
}) {
  const points = useOddsSeries(market)
  const total = Math.max(1, market.endMs - market.startMs)
  const intervalSec = total / 1000
  const holdingSide = position?.side ?? null
  const progress = Math.min(1, Math.max(0, (total - market.secondsRemaining * 1000) / total))
  const elapsedSec = Math.max(0, intervalSec - market.secondsRemaining)
  // The bar is a calendar of the bot's regimes, independent of whether a trade
  // is available right now: observe (accent) → tradeable (green) → closed (red).
  const bands = params
    ? [
        {
          key: 'observe',
          from: 0,
          to: params.observationSeconds,
          tone: 'bg-accent',
          soft: 'bg-accent-soft',
        },
        {
          key: 'tradeable',
          from: params.observationSeconds,
          to: intervalSec - params.minRemainingSeconds,
          tone: 'bg-success',
          soft: 'bg-success-soft',
        },
        {
          key: 'closed',
          from: intervalSec - params.minRemainingSeconds,
          to: intervalSec,
          tone: 'bg-danger',
          soft: 'bg-danger-soft',
        },
      ]
        .map((band) => {
          const to = Math.max(band.from, Math.min(band.to, intervalSec))
          const filled = Math.min(1, Math.max(0, (elapsedSec - band.from) / Math.max(1, to - band.from)))
          return { ...band, width: ((to - band.from) / intervalSec) * 100, filled: filled * 100 }
        })
        .filter((band) => band.width > 0)
    : []
  // Ticks sit exactly on the band edges above, labelled with elapsed time.
  const ticks = params
    ? [
        {
          atSec: params.observationSeconds,
          tone: 'bg-info',
          label: mmss(params.observationSeconds),
          title: `Observation window ends · direction must then hold ${params.minDirectionHoldSeconds}s`,
        },
        position
          ? {
              atSec: (position.entryAtMs - market.startMs) / 1000 + params.stallSeconds,
              tone: 'bg-danger',
              label: mmss((position.entryAtMs - market.startMs) / 1000 + params.stallSeconds),
              title: `Stall exit · ${params.stallSeconds}s without movement`,
            }
          : null,
        {
          atSec: intervalSec - params.minRemainingSeconds,
          tone: 'bg-danger',
          label: mmss(intervalSec - params.minRemainingSeconds),
          title: `No new entries · last ${params.minRemainingSeconds}s`,
        },
      ].filter((tick): tick is GateTick => tick !== null && tick.atSec > 0 && tick.atSec < intervalSec)
    : []
  const verdictTone = market.verdict.action === 'enter' ? 'success' : market.verdict.action === 'blocked' ? 'warning' : 'neutral'
  const slug = market.slug
  const eventUrl = `https://polymarket.com/event/${slug}?utm_medium=embed&utm_campaign=market&utm_content=spread-hunter`

  return (
    <Card aria-label={`Live odds for ${slug}`} className="flex flex-col p-5">
      <p className="flex items-center gap-1.5 text-[11px] text-faint">
        <Radio className="size-3 text-danger" aria-hidden />
        Live odds · via Polymarket
      </p>
      <div className="mt-1 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-[13px] font-semibold">
            {market.interval} window
            <span className="text-[11.5px] font-normal text-faint">{clock(market.startMs)}</span>
            {holdingSide && <Badge tone="accent">holding {holdingSide}</Badge>}
          </h3>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-faint">{slug}</p>
        </div>
        <Badge tone={verdictTone} dot>
          {reasonLabel(market.verdict.reason)}
        </Badge>
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px] text-faint">
        <span>{Math.round(progress * 100)}% elapsed</span>
        <span className="tabular-nums">{Math.max(0, Math.round(market.secondsRemaining))}s left</span>
      </div>
      <div className="relative mt-1 pb-3">
        <div className="flex h-1 overflow-hidden rounded-full bg-surface-2">
          {bands.length === 0 ? (
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-1000 ease-linear"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          ) : (
            bands.map((band) => (
              <div key={band.key} className={cx('h-full', band.soft)} style={{ width: `${band.width}%` }}>
                <div
                  className={cx('h-full transition-[width] duration-1000 ease-linear', band.tone)}
                  style={{ width: `${band.filled}%` }}
                />
              </div>
            ))
          )}
        </div>
        {ticks.map((tick) => (
          // Clamped so an edge label cannot spill out of the card.
          <span
            key={tick.title}
            title={tick.title}
            aria-label={tick.title}
            className="absolute top-0 -translate-x-1/2"
            style={{ left: `${Math.min(96, Math.max(4, (tick.atSec / intervalSec) * 100))}%` }}
          >
            <span className={cx('mx-auto -mt-[3px] block h-[10px] w-0.5 rounded-full', tick.tone)} />
            <span className="mt-0.5 block whitespace-nowrap text-[9px] tabular-nums tracking-wide text-faint">{tick.label}</span>
          </span>
        ))}
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-x-4 gap-y-2">
        <Field label="BTC" value={market.price === null ? '-' : market.price.toFixed(2)} />
        <Field label="Anchor" value={market.anchor ? market.anchor.value.toFixed(2) : 'pending'} hint={market.anchor?.source} />
        <Field label="Move" value={pct(market.movePct)} hint={`needs ${market.requiredMovePct}%`} />
        <Field label="Model p" value={market.modelProb === null ? '-' : market.modelProb.toFixed(3)} />
        <Field label="Edge" value={market.edge === null ? '-' : `${(market.edge * 100).toFixed(1)}¢`} />
        <Field label="Spread" value={market.spreadCents === null ? '-' : `${market.spreadCents.toFixed(1)}¢`} />
      </dl>

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        {(['Up', 'Down'] as const).map((outcome) => {
          const leading = market.side === outcome
          const holding = holdingSide === outcome
          return (
            <div
              key={outcome}
              className={cx(
                'rounded-tile border px-3 py-1.5',
                holding || leading ? 'border-accent/40 bg-accent-soft' : 'border-line bg-surface-2/50',
              )}
            >
              <p className="flex items-center gap-1.5 text-[11px] text-muted">
                {outcome === 'Up' ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
                {outcome}
                {holding ? <span className="text-[10px] font-medium text-accent">held</span> : leading && <span className="text-[10px] text-faint">leading</span>}
              </p>
              <p className="mt-0.5 text-[12.5px] font-medium tabular-nums">
                {priceCents(market.quotes[outcome].bid)} / {priceCents(market.quotes[outcome].ask)}
              </p>
            </div>
          )
        })}
      </div>

      <OddsChart market={market} points={points} />

      <div className="mt-1 flex items-center justify-between gap-2 text-[10.5px] text-faint">
        <span>Implied by the book · sampled 2s</span>
        <a href={eventUrl} target="_blank" rel="noopener" className="inline-flex items-center gap-1 font-medium hover:text-accent">
          trade on Polymarket
          <ArrowUpRight className="size-3" aria-hidden />
        </a>
      </div>
    </Card>
  )
}

function OddsChart({ market, points }: { market: MarketView; points: OddsPoint[] }) {
  const W = 600
  const H = 110
  const PAD_TOP = 10
  const PAD_BOTTOM = 12
  const span = Math.max(1, market.endMs - market.startMs)
  const yFor = (v: number) => PAD_TOP + (H - PAD_TOP - PAD_BOTTOM) * (1 - v)
  const xFor = (t: number) => Math.min(W, Math.max(0, ((t - market.startMs) / span) * W))
  const coords = points.map((p) => [xFor(p.t), yFor(p.v)] as const)
  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const last = coords[coords.length - 1]!
  const area = `${line} L${last[0].toFixed(1)},${H - PAD_BOTTOM} L${coords[0]![0].toFixed(1)},${H - PAD_BOTTOM} Z`
  const current = points[points.length - 1]?.v ?? 0.5
  const oddsColor = current >= 0.5 ? 'var(--color-success)' : 'var(--color-danger)'
  const upPct = impliedUp(market) * 100

  return (
    <div
      className="mt-2.5 flex min-h-[130px] flex-1 flex-col"
      role="img"
      aria-label={`Implied Up odds ${upPct.toFixed(0)}% this window`}
    >
      <div className="flex items-center justify-between text-[11px] text-faint">
        <span>
          Implied Up · <span className="font-semibold tabular-nums text-fg">{upPct.toFixed(0)}%</span>
        </span>
        <span>
          Down <span className="font-semibold tabular-nums text-fg">{(100 - upPct).toFixed(0)}%</span>
        </span>
      </div>
      <div className="relative mt-1 flex-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-hidden>
        {[0.25, 0.5, 0.75].map((t) => (
          <line
            key={t}
            x1={0}
            x2={W}
            y1={yFor(t)}
            y2={yFor(t)}
            stroke={t === 0.5 ? 'var(--color-line-strong)' : 'var(--color-line)'}
            strokeDasharray={t === 0.5 ? '6 4' : '2 4'}
            strokeWidth={1}
          />
        ))}
        <text x={2} y={yFor(0.5) - 3} fontSize={10} fill="var(--color-faint)">50</text>
        {coords.length > 0 && (
          <>
            <path d={area} fill={oddsColor} fillOpacity={0.14} />
            <path d={line} fill="none" stroke={oddsColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            <circle cx={last[0]} cy={last[1]} r={4} fill={oddsColor} stroke="var(--color-surface)" strokeWidth={2} />
          </>
        )}
      </svg>
      </div>
    </div>
  )
}

function Field({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-faint">{label}</dt>
      <dd className="mt-0.5 text-[12px] font-medium tabular-nums">
        {value}
        {hint && <span className="ml-1 text-[10px] font-normal text-faint">{hint}</span>}
      </dd>
    </div>
  )
}

function WaitingBody() {
  return (
    <div className="grid h-[230px] place-items-center">
      <div className="flex flex-col items-center gap-2 text-center">
        <Activity className="size-6 animate-pulse text-faint" aria-hidden />
        <p className="text-[13px] font-medium text-muted">Next window opening…</p>
        <p className="max-w-[320px] text-[12px] text-faint">
          The bot reattaches on its own — this switches the moment the new 5m/15m market appears.
        </p>
      </div>
    </div>
  )
}
