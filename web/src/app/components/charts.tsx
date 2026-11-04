import { motion } from 'motion/react'
import { useId, useState } from 'react'

import { cx } from '../lib/cx'
import { moneyCompact } from '../lib/format'

// Small SVG charts: no dependency, crisp at any size, easy to restyle.

export function AreaChart({ data, height = 220, className }: { data: { label: string; value: number }[]; height?: number; className?: string }) {
  const gradientId = useId()
  const [hover, setHover] = useState<number | null>(null)
  const w = 600
  const h = height
  const padX = 8
  const padTop = 16
  const padBottom = 28
  const max = Math.max(1, ...data.map((d) => d.value)) * 1.15
  const step = data.length > 1 ? (w - padX * 2) / (data.length - 1) : 0
  const points = data.map((d, i) => ({
    x: padX + i * step,
    y: padTop + (h - padTop - padBottom) * (1 - d.value / max),
  }))
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const area = `${line} L${points[points.length - 1]?.x ?? 0},${h - padBottom} L${padX},${h - padBottom} Z`
  const ticks = [0.25, 0.5, 0.75, 1]
  return (
    <div className={cx('relative', className)}>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full" preserveAspectRatio="none" onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0.22" />
            <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <line
            key={t}
            x1={padX}
            x2={w - padX}
            y1={padTop + (h - padTop - padBottom) * (1 - t)}
            y2={padTop + (h - padTop - padBottom) * (1 - t)}
            stroke="var(--color-line)"
            strokeDasharray="2 4"
          />
        ))}
        <motion.path d={area} fill={`url(#${gradientId})`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 0.3 }} />
        <motion.path
          d={line}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.1, ease: 'easeInOut' }}
        />
        {points.map((p, i) => (
          <g key={i}>
            <rect
              x={p.x - step / 2}
              y={0}
              width={step || w}
              height={h - padBottom}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
            {hover === i && (
              <>
                <line x1={p.x} x2={p.x} y1={padTop} y2={h - padBottom} stroke="var(--color-line-strong)" />
                <circle cx={p.x} cy={p.y} r="5" fill="var(--color-surface)" stroke="var(--color-accent)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
              </>
            )}
          </g>
        ))}
        {data.map((d, i) => (
          <text key={d.label} x={points[i].x} y={h - 8} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'} fontSize="12" fill="var(--color-faint)">
            {d.label}
          </text>
        ))}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute -top-1 -translate-x-1/2 rounded-tile bg-fg px-2.5 py-1.5 text-[12px] font-medium text-white shadow-pop"
          style={{ left: `${(points[hover].x / w) * 100}%` }}
        >
          {moneyCompact(data[hover].value)}
        </div>
      )}
    </div>
  )
}

export function StageBars({ data }: { data: { label: string; value: number; count: number; tone: string }[] }) {
  const max = Math.max(1, ...data.map((d) => d.value))
  return (
    <ul className="flex flex-col gap-3.5">
      {data.map((d, i) => (
        <li key={d.label} className="grid grid-cols-[88px_1fr_auto] items-center gap-3 text-[13px]">
          <span className="text-muted">{d.label}</span>
          <span className="h-2 overflow-hidden rounded-[4px] bg-surface-2">
            <motion.span
              className="block h-full rounded-[4px]"
              style={{ background: d.tone }}
              initial={{ width: 0 }}
              animate={{ width: `${(d.value / max) * 100}%` }}
              transition={{ duration: 0.8, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
            />
          </span>
          <span className="w-[72px] text-right tabular-nums">
            <span className="font-medium">{moneyCompact(d.value)}</span>
            <span className="ml-1 text-faint">{d.count}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}
