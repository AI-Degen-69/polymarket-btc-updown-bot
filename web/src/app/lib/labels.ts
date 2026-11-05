export const LABELS: Record<string, string> = {
  'observation-window': 'Waiting out the opening shakeout',
  'too-late-in-window': 'Too close to resolution',
  'no-anchor': 'Reference price not captured yet',
  'no-price': 'No price feed',
  'news-blackout': 'Scheduled news blackout',
  'low-volatility-grind': 'Low-volatility grind — sitting out',
  'insufficient-samples': 'Not enough price samples yet',
  'direction-not-held': 'Direction has not held',
  'move-too-small': 'Move too small to trade',
  'chasing-move': 'Move already extended — not chasing',
  'no-liquidity': 'No quotes on this side',
  'spread-too-wide': 'Spread too wide',
  'odds-too-expensive': 'Odds already too expensive',
  'no-volatility': 'Volatility estimate unavailable',
  'model-prob-too-low': 'Model probability too low',
  'model-prob-too-high': 'Model probability too high',
  'no-mispricing-edge': 'No mispricing left after fees',
  'below-min-order-size': 'Size below the market minimum',
  'confirmed-mispricing': 'Confirmed mispricing',
  'position-open': 'Already holding this window',
  'market-not-open': 'Market not accepting orders',
  'profit-target-hit': 'Profit target hit — sold',
  'odds-stalled': 'Odds stalled — sold',
  'thesis-intact': 'Holding, thesis intact',
  'stalled-but-waiting': 'Stalled, waiting out the clock',
  'accept-loss-at-resolution': 'Holding to resolution',
  'news-invalidated-thesis': 'News invalidated the thesis — sold',
  won: 'Resolved in favour',
  lost: 'Resolved against',
  'max-trades-per-day': 'Daily trade cap reached',
  'max-concurrent-positions': 'Position already open',
  cooldown: 'Cooling down after a loss',
  'kill-switch-file-present': 'Kill switch engaged',
  'daily-loss-limit': 'Daily loss limit hit — halted',
  'max-drawdown': 'Drawdown limit hit — halted',
  'unresolved-fallback': 'Settled without official resolution',
  'entry-did-not-fill': 'Entry order did not fill',
}

export const KIND_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'> = {
  entry: 'success',
  exit: 'info',
  settle: 'accent',
  hold: 'neutral',
  skip: 'neutral',
  blocked: 'warning',
  anchor: 'info',
  risk: 'danger',
  info: 'neutral',
  error: 'danger',
}

export const reasonLabel = (reason: string | null | undefined) =>
  !reason ? '—' : (LABELS[reason] ?? reason.replace(/[:-]/g, ' ').replace(/\s+/g, ' ').trim())

export type MetricUnit = 'ratio' | 'pct' | 'cents' | 'price' | 'sec' | 'usd' | 'count'

export interface MetricSpec {
  /** Detail key holding the measured value. */
  key: string
  /** Detail key holding the limit it was judged against. */
  threshold?: string
  op?: '<' | '>'
  unit?: MetricUnit
  label?: string
}

/**
 * Which measured value and which limit each verdict is judged on. The engine
 * writes both into the event detail, so the journal can show `0.038% < 0.05%`
 * instead of an unlabelled number.
 */
export const REASON_METRICS: Record<string, MetricSpec[]> = {
  'observation-window': [{ key: 'elapsedSec', threshold: 'needsSec', op: '<', unit: 'sec' }],
  'too-late-in-window': [{ key: 'remainingSec', threshold: 'needsSec', op: '<', unit: 'sec' }],
  'low-volatility-grind': [{ key: 'hourlyRangePct', threshold: 'needsPct', op: '<', unit: 'pct' }],
  'tight-chop-no-trend': [{ key: 'obsRangeUsd', threshold: 'minRangeUsd', op: '<', unit: 'usd' }],
  'insufficient-samples': [{ key: 'samples', threshold: 'needsSamples', op: '<', unit: 'count' }],
  'move-too-small': [{ key: 'movePct', threshold: 'needsPct', op: '<', unit: 'pct' }],
  'chasing-move': [{ key: 'movePct', threshold: 'maxPct', op: '>', unit: 'pct' }],
  'spread-too-wide': [{ key: 'spreadCents', threshold: 'maxCents', op: '>', unit: 'cents' }],
  'odds-too-expensive': [{ key: 'ask', label: 'ask', threshold: 'maxAsk', op: '>', unit: 'price' }],
  'model-prob-too-low': [{ key: 'modelProb', label: 'p', threshold: 'minProb', op: '<', unit: 'ratio' }],
  'model-prob-too-high': [{ key: 'modelProb', label: 'p', threshold: 'maxProb', op: '>', unit: 'ratio' }],
  'no-mispricing-edge': [{ key: 'edge', label: 'edge', threshold: 'minEdge', op: '<', unit: 'ratio' }],
  'model-edge-outlier': [{ key: 'edge', label: 'edge', threshold: 'maxEdge', op: '>', unit: 'ratio' }],
  'below-min-order-size': [{ key: 'shares', label: 'shares', threshold: 'minShares', op: '<' }],
  'direction-not-held': [
    { key: 'samples', label: 'samples', unit: 'count' },
    { key: 'movePct', label: 'move', unit: 'pct' },
  ],
  'no-liquidity': [{ key: 'side', label: 'side' }],
  // Journal rows that are not entry attempts: anchors and open-position holds.
  'anchor captured at window open': [
    { key: 'price', label: 'anchor', unit: 'usd' },
    { key: 'source', label: 'source' },
  ],
  'thesis-intact': [{ key: 'bid', label: 'bid', unit: 'price' }],
  'stalled-but-waiting': [
    { key: 'bid', label: 'bid', unit: 'price' },
    { key: 'stalledSec', label: 'stalled', unit: 'sec' },
  ],
  'accept-loss-at-resolution': [{ key: 'bid', label: 'bid', unit: 'price' }],
  'no-bid': [{ key: 'bid', label: 'bid', unit: 'price' }],
  'confirmed-mispricing': [
    { key: 'price', label: 'price', unit: 'price' },
    { key: 'modelProb', label: 'p', unit: 'ratio' },
    { key: 'edge', label: 'edge', unit: 'ratio' },
  ],
}

/** Rows without a paired limit still show what was measured, not empty boxes. */
const FALLBACK_METRICS: MetricSpec[] = [
  { key: 'modelProb', label: 'p', unit: 'ratio' },
  { key: 'edge', label: 'edge', unit: 'ratio' },
  { key: 'movePct', label: 'move', unit: 'pct' },
  { key: 'spreadCents', label: 'spread', unit: 'cents' },
  { key: 'anchorSource' },
]

function formatMetric(value: unknown, unit?: MetricUnit, label?: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') return label ? `${label} ${value}` : value
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  let text: string
  switch (unit) {
    case 'pct':
      text = `${Number(value.toFixed(4))}%`
      break
    case 'cents':
      text = `${Number(value.toFixed(2))}¢`
      break
    case 'price':
      text = `${Math.round(value * 100)}¢`
      break
    case 'sec':
      text = `${Math.round(value)}s`
      break
    case 'usd':
      text = Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`
      break
    case 'count':
      text = `${Math.round(value)}`
      break
    default:
      text = Number.isInteger(value) ? String(value) : value.toFixed(3)
  }
  return label ? `${label} ${text}` : text
}

/** Value + the limit it missed, for the decision journal row. */
export function eventMetrics(
  reason: string,
  detail: Record<string, unknown> | undefined,
): { text: string; limit?: string }[] {
  if (!detail) return []
  const out: { text: string; limit?: string }[] = []
  for (const spec of REASON_METRICS[reason] ?? FALLBACK_METRICS) {
    const text = formatMetric(detail[spec.key], spec.unit, spec.label)
    if (!text) continue
    const limit = spec.threshold ? formatMetric(detail[spec.threshold], spec.unit) : null
    out.push({ text, limit: limit && spec.op ? `${spec.op} ${limit}` : undefined })
    if (out.length === 3) break
  }
  return out
}
