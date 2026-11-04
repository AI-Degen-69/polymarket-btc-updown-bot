import { useMemo, useState, type ReactNode } from 'react'
import { Clock, Coins, Filter, LogOut, Megaphone, Repeat, RotateCcw, Scale, ShieldAlert } from 'lucide-react'

import { Badge, Button, Card, Field, Input, PageHeader, Skeleton, useToast } from '../components/ui'
import { useBotConfig, useSaveBotConfig, useBotControl, type BotConfigView } from '../lib/bot'
import { cx } from '../lib/cx'
import { DEFAULT_CONFIG, EDITABLE } from '../../../../src/defaults.ts'

type Draft = Record<string, number>

interface FieldSpec {
  path: string
  label: string
  hint?: string
  tip?: ReactNode
  step?: number
}

/** Bounds come from the bot's shared EDITABLE table (src/defaults.ts). */
const rangeError = ([min, max]: [number, number]): string =>
  max === Number.POSITIVE_INFINITY ? `At least ${min}` : `Between ${min} and ${max}`
const inRange = (path: string, value: number): boolean => {
  const range = EDITABLE[path]
  return !range || (Number.isFinite(value) && value >= range[0] && value <= range[1])
}
const errorFor = (path: string, value: number): string | undefined => {
  const range = EDITABLE[path]
  return range && !inRange(path, value) ? rangeError(range) : undefined
}

/** Small reset-to-default button — same height as the input it joins (h-9). */
function ResetFieldButton({ onReset, label, className }: { onReset: () => void; label: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={onReset}
      aria-label={`Reset ${label} to default`}
      title="Reset to default"
      className={cx(
        'grid h-9 w-9 shrink-0 place-items-center border border-l-0 border-line-strong bg-surface-2 text-faint transition-colors hover:bg-raised hover:text-fg',
        className ?? 'rounded-r-control',
      )}
    >
      <RotateCcw className="size-4" aria-hidden="true" />
    </button>
  )
}

/** Shared "anti-…" tooltip structure: title, one-line gist, two edge cases, footnote. */
function EdgeTip({ title, gist, lowLabel, lowText, highLabel, highText, foot }: {
  title: string
  gist: string
  lowLabel: string
  lowText: string
  highLabel: string
  highText: string
  foot: string
}) {
  return (
    <span className="block">
      <span className="block text-[12px] font-semibold">{title}</span>
      <span className="mt-1 block text-[11.5px] leading-snug text-surface/85">{gist}</span>
      <span className="mt-2 block space-y-1.5 border-t border-surface/15 pt-2 text-[11px] leading-snug text-surface/85">
        <span className="flex gap-2">
          <span className="w-10 shrink-0 font-mono font-semibold text-surface">{lowLabel}</span>
          <span>{lowText}</span>
        </span>
        <span className="flex gap-2">
          <span className="w-10 shrink-0 font-mono font-semibold text-surface">{highLabel}</span>
          <span>{highText}</span>
        </span>
      </span>
      <span className="mt-2 block border-t border-surface/15 pt-2 text-[10.5px] leading-snug text-surface/60">{foot}</span>
    </span>
  )
}

// Section accent tones — matched to what each group controls.
const TONES = {
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  info: 'bg-info-soft text-info',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-surface-2 text-muted',
} as const
type Tone = keyof typeof TONES

const GROUPS: { title: string; note?: string; icon: typeof Coins; tone: Tone; fields: FieldSpec[] }[] = [
  {
    title: 'Capital',
    note: 'Sizing starts here: Kelly fractions and every loss limit are a percentage of this.',
    icon: Coins,
    tone: 'success',
    fields: [{ path: 'bankrollUsd', label: 'Bankroll (USD)', step: 10 }],
  },
  {
    title: 'Entry gates',
    note: 'Every gate must pass before an order is sent.',
    icon: Filter,
    tone: 'info',
    fields: [
      { path: 'entry.minEdge', label: 'Minimum edge', hint: '0.06 = 6¢ after fees', tip: <EdgeTip title="Min edge" gist="Model probability minus all-in cost (ask + taker fee) must clear this before an order is sent." lowLabel="0" lowText="Edge ≥ 0 qualifies — you buy coin-flip setups and donate fees." highLabel="0.9" highText="Near-free wins only — nothing qualifies; the bot sits out." foot="Default 0.06 (6¢) · fee already in the math · clamped 0–0.9" />, step: 0.01 },
      { path: 'entry.maxEntryPriceCents', label: 'Max price paid', hint: '0.65 = 65¢', tip: <EdgeTip title="Max price paid" gist="Highest ask the bot will pay per share — expensive favorites can never pay for their risk/reward." lowLabel="0.01" lowText="Almost no ask qualifies — bot effectively never enters." highLabel="0.99" highText="Any ask accepted — even 95¢ for +5¢ upside vs −95¢ down." foot="Default 0.65 (65¢) · above this the order is skipped · clamped 0.01–0.99" />, step: 0.01 },
      { path: 'entry.minMovePct', label: 'Minimum move (%)', tip: <EdgeTip title="Min move" gist="Smallest absolute BTC move from the window open that counts as real direction, not tape noise." lowLabel="0" lowText="Noise qualifies — constant micro-churn, fees bleed every trade." highLabel="5" highText="Only 5%+ moves qualify — never happens in 15m; bot never enters." foot="Default 0.05 (0.05%) · +recovery penalty off live anchors · clamped 0–5" />, step: 0.01 },
      { path: 'entry.maxMovePct', label: 'Chase ceiling (%)', tip: <EdgeTip title="Anti-chasing filter" gist="Skip the trade once BTC has moved more than this from the window open — by then the odds have corrected and you'd be buying late." lowLabel="0" lowText="Every trade rejected — any move trips the gate; a flat tape fails the min-move check." highLabel="100%" highText="Never trips — the bot would chase any move, even one already priced in." foot="Default 0.5 (0.5%) · also caps projected drift in the model · saved values clamp to 0.01–20" />, step: 0.05 },
      { path: 'entry.minHourlyRangePct', label: 'Chop filter: 1h range (%)', tip: <EdgeTip title="Chop filter" gist="1h high–low range must exceed this or the tape is a grind with no shakeout to fade — sit out." lowLabel="0" lowText="Filter off — bot trades dead, low-volatility grinds." highLabel="20" highText="Only a 20% hourly range qualifies — bot always sits out." foot="Default 0.3 (0.3%) · needs ≥15m of price history · clamped 0–20" />, step: 0.05 },
      { path: 'entry.tightChopRangeUsd', label: 'Tight chop corridor ($)', hint: '50 = skip if obs range < $50', tip: <EdgeTip title="Tight chop corridor" gist="Price range over the observation window (high–low, in $) must exceed this — tighter oscillation means false signals dominate." lowLabel="$0" lowText="Filter off — bot trades tight, meaningless oscillation." highLabel="$10k" highText="Never qualifies — bot never enters." foot="Default $50 · needs ≥3 samples · clamped $0–10,000" />, step: 5 },
      { path: 'entry.maxSpreadCents', label: 'Max spread (¢)', step: 0.5 },
      { path: 'entry.minModelProb', label: 'Min model probability', tip: <EdgeTip title="Min model probability" gist="The model must be at least this confident in the side before any order is sent." lowLabel="0.01" lowText="Confidence floor ~off — the edge gate is the only guard left." highLabel="0.99" highText="Near-certainty demanded — nothing qualifies; bot idle." foot="Default 0.52 · gate: model-prob-too-low · clamped 0.01–0.99" />, step: 0.01 },
      { path: 'entry.maxModelProb', label: 'Max model probability', tip: <EdgeTip title="Max model probability" gist="Above this confidence the move is already priced in — buying here is buying late." lowLabel="0.01" lowText="Nearly every signal rejected as too late — nothing passes." highLabel="0.999" highText="Cap off — the model can be arithmetically certain and still buys." foot="Default 0.72 · gate: model-prob-too-high · clamped 0.01–0.999" />, step: 0.01 },
      { path: 'entry.nonLiveAnchorExtraMovePct', label: 'Extra move for recovered anchor (%)', tip: <EdgeTip title="Recovered anchor extra" gist="Extra move required when the anchor was rebuilt from candle history (bot restart) instead of captured live." lowLabel="0" lowText="History-recovered anchors trusted exactly like live ones." highLabel="5" highText="Recovered-anchor windows untradeable — min move ≈ 5.05%." foot="Default 0.05 · only when anchor source ≠ live · clamped 0–5" />, step: 0.01 },
    ],
  },
  {
    title: 'Sizing',
    icon: Scale,
    tone: 'accent',
    fields: [
      { path: 'entry.kellyCut', label: 'Kelly fraction', hint: '0.25 = quarter Kelly', step: 0.05 },
      { path: 'entry.maxPositionPct', label: 'Max position (% of bankroll)', hint: '0.08 = $80 per $1,000', step: 0.01 },
      { path: 'entry.feeRate', label: 'Taker fee rate', step: 0.01 },
    ],
  },
  {
    title: 'Exits',
    icon: LogOut,
    tone: 'warning',
    fields: [
      { path: 'exit.profitTargetCents', label: 'Profit target (¢)', hint: '0.85 = 85¢', step: 0.01 },
      { path: 'exit.stallBandLow', label: 'Stall band low (¢)', tip: <EdgeTip title="Stall band low" gist="Bottom of the 'momentum faded' zone — bid inside the band for the stall window → sell into weakness." lowLabel="0.05" lowText="Band starts near zero — everything counts as stalling; sold far too early." highLabel="0.95" highText="Low ≥ high empties the band — the stall exit never fires." foot="Default 0.60 (60¢) · pair with band high · clamped 0.05–0.95" />, step: 0.01 },
      { path: 'exit.stallBandHigh', label: 'Stall band high (¢)', tip: <EdgeTip title="Stall band high" gist="Top of the 'momentum faded' zone — above it, profit-target and hold logic rule instead." lowLabel="0.05" lowText="Empty if high ≤ low — the stall exit never fires." highLabel="0.99" highText="Band swallows take-profit prices — dumped as 'stalled' before the 85¢ target." foot="Default 0.70 (70¢) · pair with band low · clamped 0.05–0.99" />, step: 0.01 },
      { path: 'exit.acceptLossBelowCents', label: 'Hold below (¢)', tip: <EdgeTip title="Hold below" gist="Below this bid, never sell — dumping locks in the loss; hold for the resolution rebound." lowLabel="0.01" lowText="Hold zone ~off — you'd panic-dump near-zero odds." highLabel="0.5" highText="Wide hold zone — bag-holding 40–50¢ dips; capital pinned in dead positions." foot="Default 0.20 (20¢) · hold to expiry · clamped 0.01–0.5" />, step: 0.01 },
      { path: 'exit.stallGraceSeconds', label: 'Stall grace window (s)', hint: '15 = 15s hysteresis on quote jitter', tip: <EdgeTip title="Stall grace window" gist="How long a bid may flicker outside the stall band before the stall timer wipes — absorbs CLOB jitter." lowLabel="0s" lowText="No grace — one tick outside the band resets the stall timer." highLabel="300s" highText="5 min of jitter tolerated — stalled positions held far too long." foot="Default 15 (15s) · clamped 0–300" />, step: 1 },
    ],
  },
  {
    title: 'Risk limits',
    icon: ShieldAlert,
    tone: 'danger',
    fields: [
      { path: 'risk.maxTradesPerDay', label: 'Max trades per day', step: 1 },
      { path: 'risk.maxConsecutiveLosses', label: 'Stop after N losses', step: 1 },
      { path: 'risk.dailyLossLimitPct', label: 'Daily loss limit (%)', step: 0.5 },
      { path: 'risk.maxDrawdownPct', label: 'Max drawdown (%)', step: 1 },
      { path: 'risk.maxConcurrentPositions', label: 'Max open positions', step: 1 },
      { path: 'risk.cooldownAfterLossSec', label: 'Cooldown after a loss (s)', step: 30 },
    ],
  },
  {
    title: 'Window timing',
    note: 'The 15m window is the guide’s original clock; 5m scales the same rules to the shorter window.',
    icon: Clock,
    tone: 'info',
    fields: [
      { path: 'intervalParams.15m.observationSeconds', label: '15m observation (s)', step: 10 },
      { path: 'intervalParams.15m.minDirectionHoldSeconds', label: '15m direction hold (s)', step: 5 },
      { path: 'intervalParams.15m.minRemainingSeconds', label: '15m min time left (s)', step: 10 },
      { path: 'intervalParams.15m.stallSeconds', label: '15m stall exit (s)', step: 10 },
      { path: 'intervalParams.5m.observationSeconds', label: '5m observation (s)', step: 5 },
      { path: 'intervalParams.5m.minDirectionHoldSeconds', label: '5m direction hold (s)', step: 5 },
      { path: 'intervalParams.5m.minRemainingSeconds', label: '5m min time left (s)', step: 5 },
      { path: 'intervalParams.5m.stallSeconds', label: '5m stall exit (s)', step: 5 },
    ],
  },
]

const ALL_PATHS = [...GROUPS.flatMap((group) => group.fields.map((field) => field.path)), 'news.blackoutMinutes']

function readPath(source: unknown, path: string): number {
  const value = path.split('.').reduce<unknown>((cursor, key) => (cursor as Record<string, unknown> | undefined)?.[key], source)
  return typeof value === 'number' ? value : 0
}

function flatten(config: BotConfigView): Draft {
  const draft: Draft = { 'news.blackoutMinutes': config.news.blackoutMinutes }
  for (const group of GROUPS) for (const field of group.fields) draft[field.path] = readPath(config, field.path)
  return draft
}

export function Config() {
  const query = useBotConfig()
  const save = useSaveBotConfig()
  const control = useBotControl()
  const toast = useToast()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [intervals, setIntervals] = useState<('5m' | '15m')[] | null>(null)
  const [events, setEvents] = useState<string | null>(null)

  const config = query.data?.config ?? null
  // Factory defaults are bundled from the bot's single source of truth (src/defaults.ts).
  const defaultValues = useMemo(() => flatten(DEFAULT_CONFIG as unknown as BotConfigView), [])
  const defaultIntervals = DEFAULT_CONFIG.intervals
  const values = draft ?? (config ? flatten(config) : null)
  const activeIntervals = intervals ?? config?.intervals ?? []
  const newsText = events ?? config?.news.events.join('\n') ?? ''
  const dirty = draft !== null || intervals !== null || events !== null
  // Save is blocked while any field is out of range (or no interval is selected).
  const hasErrors =
    values !== null && (ALL_PATHS.some((path) => !inRange(path, values[path] ?? 0)) || activeIntervals.length === 0)

  const set = (path: string, raw: string) => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return
    setDraft({ ...(values ?? {}), [path]: parsed })
  }

  const onSave = () => {
    if (!values) return
    const payload: Record<string, unknown> = {
      ...values,
      intervals: activeIntervals,
      'news.events': newsText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    }
    save.mutate(payload, {
      onSuccess: (result) => {
        setDraft(null)
        setIntervals(null)
        setEvents(null)
        const warnings = result.warnings ?? []
        toast(warnings.length ? `Saved with ${warnings.length} adjustment(s)` : 'Configuration saved')
        if (warnings.length) console.warn('Config warnings:', warnings)
      },
      onError: (error: Error) => toast(error.message, 'danger'),
    })
  }

  return (
    <div className="mx-auto max-w-[1000px] p-5 sm:p-8">
      <PageHeader
        title="Configuration"
        subtitle="Every threshold the strategy uses. A running bot reloads on its next tick."
        actions={
          <div className="flex items-center gap-2">
            {control.data && (
              <Badge tone={control.data.running ? 'success' : 'neutral'} dot>
                {control.data.running ? 'Running' : 'Stopped'}
              </Badge>
            )}
            <Button variant="primary" size="sm" onClick={onSave} loading={save.isPending} disabled={!dirty || !values || hasErrors} title={hasErrors ? 'Fix the highlighted fields first' : undefined}>
              Save changes
            </Button>
          </div>
        }
      />

      {query.isLoading || !config || !values ? (
        <Skeleton className="mt-6 h-[420px] rounded-card" />
      ) : (
        <>
          <Card className="mt-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-tile bg-accent-soft text-accent">
                  <Repeat className="size-4.5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h2 className="text-[14px] font-semibold">Windows</h2>
                  <p className="mt-0.5 text-[12px] leading-snug text-muted">Which recurring markets the bot is allowed to trade.</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {(['15m', '5m'] as const).map((interval) => {
                  const on = activeIntervals.includes(interval)
                  return (
                    <button
                      key={interval}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setIntervals(
                          on
                            ? activeIntervals.filter((value) => value !== interval)
                            : (['15m', '5m'] as const).filter((value) => value === interval || activeIntervals.includes(value)),
                        )
                      }
                      className={cx(
                        'h-8 rounded-tile border px-3 text-[12.5px] font-medium transition-colors',
                        on ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line bg-surface text-muted hover:text-fg',
                      )}
                    >
                      {interval}
                    </button>
                  )
                })}
                <ResetFieldButton label="windows" onReset={() => setIntervals([...defaultIntervals])} className="rounded-control border-l" />
              </div>
            </div>
            <p className={cx('mt-2 text-[12px]', activeIntervals.length === 0 ? 'font-medium text-danger' : 'text-faint')}>
              Keep at least one enabled. Disabling 5m narrows sizing to a single window at a time.
            </p>
          </Card>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {GROUPS.map((group) => {
              const Icon = group.icon
              return (
              <Card key={group.title} className={cx('p-5', group.fields.length > 6 && 'lg:col-span-2')}>
                <div className="flex items-center gap-3">
                  <span className={cx('grid size-9 shrink-0 place-items-center rounded-tile', TONES[group.tone])}>
                    <Icon className="size-4.5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-[14px] font-semibold">{group.title}</h2>
                    {group.note && <p className="mt-0.5 text-[12px] leading-snug text-muted">{group.note}</p>}
                  </div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {group.fields.map((field) => {
                    const value = values[field.path] ?? 0
                    const fieldError = errorFor(field.path, value)
                    return (
                      <Field key={field.path} label={field.label} hint={field.hint} tip={field.tip} error={fieldError}>
                        <span className="flex min-w-0 items-stretch">
                          <Input
                            type="number"
                            step={field.step ?? 0.01}
                            value={value}
                            onChange={(event) => set(field.path, event.target.value)}
                            invalid={fieldError !== undefined}
                            className="rounded-r-none border-r-0 tabular-nums"
                          />
                          <ResetFieldButton label={field.label} onReset={() => set(field.path, String(defaultValues[field.path] ?? 0))} />
                        </span>
                      </Field>
                    )
                  })}
                </div>
              </Card>
              )
            })}

            <Card className="p-5 lg:col-span-2">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-tile bg-warning-soft text-warning">
                    <Megaphone className="size-4.5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-[14px] font-semibold">Scheduled news</h2>
                    <p className="mt-0.5 text-[12px] leading-snug text-muted">
                      One ISO timestamp per line. The bot refuses new entries inside the blackout and leaves open positions.
                    </p>
                  </div>
                </div>
                <Field label="Blackout (minutes)" error={errorFor('news.blackoutMinutes', values['news.blackoutMinutes'] ?? 0)}>
                  <span className="flex min-w-0 items-stretch">
                    <Input
                      type="number"
                      step={1}
                      value={values['news.blackoutMinutes'] ?? 0}
                      onChange={(event) => set('news.blackoutMinutes', event.target.value)}
                      invalid={errorFor('news.blackoutMinutes', values['news.blackoutMinutes'] ?? 0) !== undefined}
                      className="w-[110px] rounded-r-none border-r-0 tabular-nums"
                    />
                    <ResetFieldButton label="blackout window" onReset={() => set('news.blackoutMinutes', String(defaultValues['news.blackoutMinutes'] ?? 0))} />
                  </span>
                </Field>
              </div>
              <div className="mt-3 flex items-start">
                <textarea
                  aria-label="Scheduled news events, one ISO timestamp per line"
                  value={newsText}
                  onChange={(event) => setEvents(event.target.value)}
                  rows={5}
                  placeholder={'2026-11-03T18:00:00Z\n2026-11-04T13:30:00Z'}
                  className="w-full rounded-r-none border border-r-0 border-line-strong bg-surface px-3 py-2 font-mono text-[12.5px] leading-relaxed outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15"
                />
                <ResetFieldButton label="news events" onReset={() => setEvents('')} />
              </div>
            </Card>
          </div>

          {hasErrors && (
            <p role="alert" className="mt-3 text-[12px] font-medium text-danger">
              Some fields are out of range — Save is disabled until they are fixed.
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[12.5px] text-faint">
              Saved to <span className="font-mono">bot/config.json</span>. Values are clamped to safe bounds; live mode cannot be changed here.
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraft(null)
                  setIntervals(null)
                  setEvents(null)
                }}
                disabled={!dirty}
              >
                <RotateCcw /> Discard
              </Button>
              <Button variant="primary" size="sm" onClick={onSave} loading={save.isPending} disabled={!dirty || hasErrors} title={hasErrors ? 'Fix the highlighted fields first' : undefined}>
                Save changes
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
