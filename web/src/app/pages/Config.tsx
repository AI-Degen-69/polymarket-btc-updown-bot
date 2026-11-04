import { useState } from 'react'
import { RotateCcw } from 'lucide-react'

import { Badge, Button, Card, Field, Input, PageHeader, Skeleton, useToast } from '../components/ui'
import { useBotConfig, useSaveBotConfig, useBotControl, type BotConfigView } from '../lib/bot'
import { cx } from '../lib/cx'

type Draft = Record<string, number>

interface FieldSpec {
  path: string
  label: string
  hint?: string
  step?: number
}

const GROUPS: { title: string; note?: string; fields: FieldSpec[] }[] = [
  {
    title: 'Capital',
    note: 'Sizing starts here: Kelly fractions and every loss limit are a percentage of this.',
    fields: [{ path: 'bankrollUsd', label: 'Bankroll (USD)', step: 10 }],
  },
  {
    title: 'Entry gates',
    note: 'Every gate must pass before an order is sent.',
    fields: [
      { path: 'entry.minEdge', label: 'Minimum edge', hint: '0.06 = 6¢ after fees', step: 0.01 },
      { path: 'entry.maxEntryPriceCents', label: 'Max price paid', hint: '0.65 = 65¢', step: 0.01 },
      { path: 'entry.minMovePct', label: 'Minimum move (%)', step: 0.01 },
      { path: 'entry.maxMovePct', label: 'Chase ceiling (%)', step: 0.05 },
      { path: 'entry.minHourlyRangePct', label: 'Chop filter: 1h range (%)', step: 0.05 },
      { path: 'entry.tightChopRangeUsd', label: 'Tight chop corridor ($)', hint: '50 = skip if obs range < $50', step: 5 },
      { path: 'entry.maxSpreadCents', label: 'Max spread (¢)', step: 0.5 },
      { path: 'entry.minModelProb', label: 'Min model probability', step: 0.01 },
      { path: 'entry.maxModelProb', label: 'Max model probability', step: 0.01 },
      { path: 'entry.nonLiveAnchorExtraMovePct', label: 'Extra move for recovered anchor (%)', step: 0.01 },
    ],
  },
  {
    title: 'Sizing',
    fields: [
      { path: 'entry.kellyCut', label: 'Kelly fraction', hint: '0.25 = quarter Kelly', step: 0.05 },
      { path: 'entry.maxPositionPct', label: 'Max position (% of bankroll)', hint: '0.08 = $80 per $1,000', step: 0.01 },
      { path: 'entry.feeRate', label: 'Taker fee rate', step: 0.01 },
    ],
  },
  {
    title: 'Exits',
    fields: [
      { path: 'exit.profitTargetCents', label: 'Profit target (¢)', hint: '0.85 = 85¢', step: 0.01 },
      { path: 'exit.stallBandLow', label: 'Stall band low (¢)', step: 0.01 },
      { path: 'exit.stallBandHigh', label: 'Stall band high (¢)', step: 0.01 },
      { path: 'exit.acceptLossBelowCents', label: 'Hold below (¢)', step: 0.01 },
      { path: 'exit.stallGraceSeconds', label: 'Stall grace window (s)', hint: '15 = 15s hysteresis on quote jitter', step: 1 },
    ],
  },
  {
    title: 'Risk limits',
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

function readPath(source: unknown, path: string): number {
  const value = path.split('.').reduce<unknown>((cursor, key) => (cursor as Record<string, unknown> | undefined)?.[key], source)
  return typeof value === 'number' ? value : 0
}

function flatten(config: BotConfigView): Draft {
  const draft: Draft = {}
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
  const values = draft ?? (config ? flatten(config) : null)
  const activeIntervals = intervals ?? config?.intervals ?? []
  const newsText = events ?? config?.news.events.join('\n') ?? ''
  const dirty = draft !== null || intervals !== null || events !== null

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
            <Button variant="primary" size="sm" onClick={onSave} loading={save.isPending} disabled={!dirty || !values}>
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
              <div>
                <h2 className="text-[14px] font-semibold">Windows</h2>
                <p className="text-[12.5px] text-muted">Which recurring markets the bot is allowed to trade.</p>
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
              </div>
            </div>
            <p className="mt-2 text-[12px] text-faint">
              Keep at least one enabled. Disabling 5m narrows sizing to a single window at a time.
            </p>
          </Card>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {GROUPS.map((group) => (
              <Card key={group.title} className={cx('p-5', group.fields.length > 6 && 'lg:col-span-2')}>
                <h2 className="text-[14px] font-semibold">{group.title}</h2>
                {group.note && <p className="mt-0.5 text-[12px] text-muted">{group.note}</p>}
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {group.fields.map((field) => (
                    <Field key={field.path} label={field.label} hint={field.hint}>
                      <Input
                        type="number"
                        step={field.step ?? 0.01}
                        value={values[field.path] ?? 0}
                        onChange={(event) => set(field.path, event.target.value)}
                        className="tabular-nums"
                      />
                    </Field>
                  ))}
                </div>
              </Card>
            ))}

            <Card className="p-5 lg:col-span-2">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-[14px] font-semibold">Scheduled news</h2>
                  <p className="text-[12.5px] text-muted">
                    One ISO timestamp per line. The bot refuses new entries inside the blackout and leaves open positions.
                  </p>
                </div>
                <Field label="Blackout (minutes)">
                  <Input
                    type="number"
                    step={1}
                    value={values['news.blackoutMinutes'] ?? 0}
                    onChange={(event) => set('news.blackoutMinutes', event.target.value)}
                    className="w-[110px] tabular-nums"
                  />
                </Field>
              </div>
              <textarea
                value={newsText}
                onChange={(event) => setEvents(event.target.value)}
                rows={5}
                placeholder={'2026-11-03T18:00:00Z\n2026-11-04T13:30:00Z'}
                className="mt-3 w-full rounded-control border border-line-strong bg-surface px-3 py-2 font-mono text-[12.5px] leading-relaxed outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/15"
              />
            </Card>
          </div>

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
              <Button variant="primary" size="sm" onClick={onSave} loading={save.isPending} disabled={!dirty}>
                Save changes
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
