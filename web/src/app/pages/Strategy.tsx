import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Clock,
  Coins,
  Gauge,
  LogOut,
  Percent,
  ShieldAlert,
  ShieldCheck,
  Sigma,
  SlidersHorizontal,
  Target,
  TrendingUp,
  Zap,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'

import { Badge, Button, Card, PageHeader } from '../components/ui'

// ----------------------------------------------------------------------
// DATA DEFINITIONS & THRESHOLDS
// ----------------------------------------------------------------------

const ENTRY_GATES = [
  {
    step: 1,
    title: 'Wait Out the Shakeout',
    subtitle: 'Observation Window',
    icon: Clock,
    body: 'No entry in the first 5 minutes (300s) of a 15-minute market. Early wicks are driven by bots repositioning and emotional market orders. Wait for the shakeout to exhaust.',
    setting: 'observationSeconds: 300s (15m) · 100s (5m)',
    keyMetric: '00:00 → 05:00',
    metricLabel: 'Observation silence',
    tone: 'neutral' as const,
  },
  {
    step: 2,
    title: 'Direction Must Hold ≥ 60s',
    subtitle: 'Post-Shakeout Trend',
    icon: TrendingUp,
    body: 'Direction follows sustained tape momentum, not anchor side. A dump below the open that stabilizes and rallies up for 60s is an Up recovery. Oscillating wicks cancel the signal.',
    setting: 'minDirectionHoldSeconds: 60s (15m) · 20s (5m)',
    keyMetric: '≥ 60 seconds',
    metricLabel: 'Continuous slope',
    tone: 'accent' as const,
  },
  {
    step: 3,
    title: 'Move Size: 0.05% to 0.50%',
    subtitle: 'Noise & Anti-Chasing Filter',
    icon: Gauge,
    body: 'Moves under 0.05% are negligible noise. Moves over 0.50% mean the market odds have already adjusted and you are chasing late money.',
    setting: 'minMovePct: 0.05% · maxMovePct: 0.50%',
    keyMetric: '0.05% – 0.50%',
    metricLabel: 'Allowed move range',
    tone: 'info' as const,
  },
  {
    step: 4,
    title: 'True Probability Edge ≥ 6¢',
    subtitle: 'Mispricing Model',
    icon: Percent,
    body: 'True probability is calculated via log-normal Brownian motion with momentum drift. You only buy when our probability exceeds the CLOB ask plus taker fees by at least 6¢.',
    setting: 'minEdge: 0.06 · minModelProb: 0.52 · maxModelProb: 0.72',
    keyMetric: 'Edge ≥ 0.06',
    metricLabel: 'Statistical surplus',
    tone: 'success' as const,
  },
  {
    step: 5,
    title: 'Book Liquidity & Spread ≤ 2¢',
    subtitle: 'Execution Health',
    icon: Coins,
    body: 'Only trade when bid-ask spread is ≤ 2¢. Never pay over 65¢ for a side — expensive favorites carry poor risk/reward and cannot absorb fees.',
    setting: 'maxSpreadCents: 2¢ · maxEntryPrice: 65¢',
    keyMetric: 'Spread ≤ 2¢',
    metricLabel: 'Tight book required',
    tone: 'warning' as const,
  },
  {
    step: 6,
    title: 'Skip Dead Chop & Scheduled News',
    subtitle: 'Regime Safety Guard',
    icon: ShieldAlert,
    body: 'Sit out if 1-hour range is under 0.3% or the 5-minute observation corridor is under $50. Full ±15 minute blackout around high-impact economic news (FOMC, CPI, Fed).',
    setting: 'minHourlyRangePct: 0.3% · tightChopRangeUsd: $50 · news.blackoutMinutes: 15',
    keyMetric: 'Corridor ≥ $50',
    metricLabel: 'Volatile regime only',
    tone: 'danger' as const,
  },
]

const EXIT_SCENARIOS = [
  {
    id: 'take-profit',
    condition: 'Bid reaches 85¢ – 90¢',
    action: 'Sell to lock profit',
    tone: 'success' as const,
    badge: 'Take Profit',
    pnl: '+150% to +220%',
    why: 'The remaining 10–15¢ does not compensate for binary resolution risk. Lock the win and free cash for the next cycle.',
  },
  {
    id: 'stalled',
    condition: 'Odds stall at 60¢ – 70¢ (180s on 15m; 60s on 5m)',
    action: 'Sell & exit stalled trade',
    tone: 'warning' as const,
    badge: 'Momentum Faded',
    pnl: '+40% to +80%',
    why: 'If the thesis were correct, price would have expanded to target. Stalling indicates exhaustion; a 15s grace window filters single-tick CLOB jitter.',
  },
  {
    id: 'reversal-hold',
    condition: 'Odds dip below entry but stay > 20¢',
    action: 'Hold position calmly',
    tone: 'info' as const,
    badge: 'Thesis Intact',
    pnl: '-10% to -35%',
    why: 'Normal retracements and noise wicks are expected. Selling at minor discounts donates the bid-ask spread to market makers.',
  },
  {
    id: 'resolution-hold',
    condition: 'Odds collapse to ≤ 20¢',
    action: 'Hold until final resolution',
    tone: 'danger' as const,
    badge: 'Hold to Expiry',
    pnl: 'Max Loss (-100%)',
    why: 'Selling at 15–20¢ crystalizes a guaranteed ~80% loss for pennies. Holding retains the non-zero probability of an end-of-window rebound.',
  },
  {
    id: 'news-flash',
    condition: 'Major scheduled news hits mid-trade',
    action: 'Emergency market exit',
    tone: 'danger' as const,
    badge: 'News Invalidation',
    pnl: 'Market Mark',
    why: 'Macro shocks render all technical edges invalid. Exit immediately and reassess in a stable regime.',
  },
]

// ----------------------------------------------------------------------
// TABLE OF CONTENTS (scroll-spy)
// ----------------------------------------------------------------------

const TOC = [
  {
    id: 'strategy-timeline',
    label: 'Window Timeline & Walkthrough',
    short: '1. Window Timeline',
    icon: Clock,
    children: [
      { id: 'timeline-anatomy', label: '15-Minute Market Anatomy' },
      { id: 'timeline-walkthrough', label: 'The Signature Trade Setup' },
      { id: 'entry-gates', label: 'The Six Entry Gates' },
    ],
  },
  {
    id: 'strategy-math',
    label: 'Mathematical Formulation & Edge Model',
    short: '2. Math & Edge Model',
    icon: Sigma,
    children: [
      { id: 'formula-probability', label: 'Log-Normal Probability Model' },
      { id: 'formula-fees', label: 'Taker Fee Schedule' },
      { id: 'formula-edge', label: 'Net Edge Threshold' },
      { id: 'formula-kelly', label: 'Quarter Kelly Sizing' },
    ],
  },
  {
    id: 'strategy-exits',
    label: 'Mechanical Exit Matrix & Scenarios',
    short: '3. Exit Matrix',
    icon: LogOut,
    children: [
      { id: 'exit-matrix', label: 'Exit Scenarios' },
      { id: 'exit-grace', label: 'Hysteresis Grace Window' },
    ],
  },
  {
    id: 'strategy-risk',
    label: 'Capital Sizing & Risk Discipline',
    short: '4. Capital & Risk',
    icon: ShieldCheck,
    children: [
      { id: 'risk-kelly', label: 'Fractional Kelly vs Martingale' },
      { id: 'risk-breakers', label: 'Deterministic Circuit Breakers' },
    ],
  },
] as const

const TOC_IDS = TOC.flatMap((item) => [item.id, ...item.children.map((child) => child.id)])

// ----------------------------------------------------------------------
// MAIN COMPONENT
// ----------------------------------------------------------------------

export function Strategy() {
  const [activeId, setActiveId] = useState<string>(TOC[0].id)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveId(entry.target.id)
        }
      },
      { rootMargin: '-10% 0px -70% 0px' },
    )
    for (const id of TOC_IDS) {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    }
    // The page content sits inside Shell's scrolling container (overflow-y-auto),
    // not the window. Use that container for the end-of-page check.
    const container = document.querySelector<HTMLElement>('.scrollbar-thin.overflow-y-auto')
    const onScroll = () => {
      if (!container) return
      const last = TOC_IDS[TOC_IDS.length - 1]
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 4) {
        setActiveId(last)
      }
    }
    container?.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      container?.removeEventListener('scroll', onScroll)
    }
  }, [])

  const jumpTo = (id: string) => {
    setActiveId(id)
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="mx-auto max-w-[1180px] p-5 sm:p-8">
      <PageHeader
        title="Strategy & Architecture"
        subtitle="Johannes Thüroff’s tested Polymarket 5-Minute Strategy — timings, mathematics, and execution rules."
        actions={
          <Link
            to="/config"
            className="inline-flex h-8 items-center gap-1.5 rounded-tile border border-line-strong bg-surface px-3 text-[13px] font-medium shadow-[0_1px_1px_rgb(20_20_24/0.04)] hover:bg-surface-2"
          >
            <SlidersHorizontal className="size-3.5" /> Tune thresholds
          </Link>
        }
      />

      {/* Hero Overview */}
      <Card className="mt-5 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">BTC Up or Down</Badge>
          <Badge tone="neutral">15-Minute Windows (96 / day)</Badge>
          <Badge tone="neutral">5-Minute Windows (288 / day)</Badge>
          <Badge tone="info">Paper by Default</Badge>
        </div>
        <p className="mt-4 text-[14px] leading-relaxed text-muted">
          Polymarket runs recurring <strong className="text-fg font-semibold">“Bitcoin Up or Down”</strong> prediction
          markets settling against Chainlink BTC/USD. Most participants enter within the first 60 seconds on adrenaline,
          getting trapped in false breakouts. This strategy does the reverse: it waits{' '}
          <strong className="text-fg font-semibold">5 full minutes</strong> to observe shakeout exhaustion, confirms a{' '}
          <strong className="text-fg font-semibold">momentum direction (60s on 15m · 20s on 5m)</strong>, and enters only when odds lag
          the real probability.
        </p>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-tile border border-line bg-surface-2/50 p-3.5">
            <span className="flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-wider text-faint">
              <Clock className="size-4 text-accent" /> Observation Phase
            </span>
            <p className="mt-1.5 text-[15px] font-bold text-fg">First 5 Min: No Entry</p>
            <p className="text-[12px] text-muted">Exhausts noise & fakeouts</p>
          </div>

          <div className="rounded-tile border border-line bg-surface-2/50 p-3.5">
            <span className="flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-wider text-faint">
              <Target className="size-4 text-success" /> Active Entry Window
            </span>
            <p className="mt-1.5 text-[15px] font-bold text-fg">Minutes 5 – 11</p>
            <p className="text-[12px] text-muted">Requires ≥ 60s confirmed direction</p>
          </div>

          <div className="rounded-tile border border-line bg-surface-2/50 p-3.5">
            <span className="flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-wider text-faint">
              <TrendingUp className="size-4 text-info" /> Performance Profile
            </span>
            <p className="mt-1.5 text-[15px] font-bold text-fg">55% – 65% Win Rate</p>
            <p className="text-[12px] text-muted">Wins typically 2× – 3× loss size</p>
          </div>
        </div>
      </Card>

      {/* Section quick-jump buttons — single row, real Button components */}
      <div className="mt-6 flex gap-2 overflow-x-auto pb-1" aria-label="Jump to section">
        {TOC.map((item) => {
          const isActive = activeId === item.id || item.children.some((child) => child.id === activeId)
          const Icon = item.icon
          return (
            <Button
              key={item.id}
              variant={isActive ? 'primary' : 'secondary'}
              size="md"
              onClick={() => jumpTo(item.id)}
              className="min-w-[170px] flex-1 whitespace-nowrap"
              aria-current={isActive ? 'true' : undefined}
            >
              <Icon />
              {item.short}
            </Button>
          )
        })}
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_236px]">
        <div className="min-w-0 space-y-6">

      {/* SECTION 1: VISUAL TIMELINE & WALKTHROUGH */}
      <section id="strategy-timeline" aria-label="Window timeline and real trade walkthrough" className="scroll-mt-16 space-y-6">
          {/* Section: Window Timeline Diagram */}
          <Card id="timeline-anatomy" className="scroll-mt-16 p-6">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-[16px] font-semibold text-fg">15-Minute Market Anatomy</h3>
                <p className="text-[13px] text-muted">How the strategy sections the 900-second window into deterministic phases</p>
              </div>
              <Badge tone="accent">900 Seconds Total</Badge>
            </div>

            {/* Visual Timeline Bar */}
            <div className="mt-6">
              <div className="grid h-10 w-full grid-cols-12 overflow-hidden rounded-tile border border-line text-[11px] font-semibold text-white">
                <div className="col-span-4 flex items-center justify-center bg-danger/80 px-2 text-center">
                  Min 0 – 5 (Shakeout)
                </div>
                <div className="col-span-5 flex items-center justify-center bg-success/85 px-2 text-center">
                  Min 5 – 11 (Active Entry Zone)
                </div>
                <div className="col-span-3 flex items-center justify-center bg-info/80 px-2 text-center">
                  Min 11 – 15 (Exit)
                </div>
              </div>

              {/* Timeline Milestones */}
              <div className="mt-3 grid grid-cols-12 text-[11.5px] font-mono text-faint">
                <div className="col-span-4">0:00 (Open / Anchor)</div>
                <div className="col-span-5 text-center">5:00 (Observation Ends)</div>
                <div className="col-span-3 text-right">15:00 (Resolution)</div>
              </div>

              {/* Explanatory Cards below timeline */}
              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <div className="rounded-tile border border-danger/20 bg-danger-soft/25 p-3.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-danger">00:00 – 05:00 · 300s</span>
                  <p className="mt-1 text-[13.5px] font-semibold text-fg">Observation Silence</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted">
                    No orders sent. Emotional traders pile in on initial candles. High volatility often produces false
                    reversals that trap early positions.
                  </p>
                </div>

                <div className="rounded-tile border border-success/20 bg-success-soft/25 p-3.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-success">05:00 – 11:00 · 360s</span>
                  <p className="mt-1 text-[13.5px] font-semibold text-fg">Directional Confirmation</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted">
                    If direction holds continuously for <code className="rounded bg-surface px-1 text-fg font-mono">≥ 60s</code> and odds
                    remain mispriced <code className="rounded bg-surface px-1 text-fg font-mono">edge ≥ 0.06</code>, orders execute via FAK.
                  </p>
                </div>

                <div className="rounded-tile border border-info/20 bg-info-soft/25 p-3.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-info">11:00 – 15:00 · 240s</span>
                  <p className="mt-1 text-[13.5px] font-semibold text-fg">Resolution Window</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted">
                    New entries forbidden (<code className="rounded bg-surface px-1 text-fg font-mono">minRemainingSeconds = 240s</code>).
                    Bot manages exits at target prices or holds to Chainlink settlement.
                  </p>
                </div>
              </div>
            </div>
          </Card>

          {/* Section: The Real Trade Walkthrough SVG Chart */}
          <Card id="timeline-walkthrough" className="scroll-mt-16 p-6">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-[16px] font-semibold text-fg">The Signature Trade Setup (Guide's Real Win)</h3>
                <p className="text-[13px] text-muted">
                  Visual proof of the edge: early dump exhausts, direction recovers for 60s, bot buys UP at 28¢ below the open
                </p>
              </div>
              <Badge tone="success">+203% Net Return</Badge>
            </div>

            {/* SVG Visual Graph */}
            <div className="mt-6 overflow-hidden rounded-tile border border-line bg-surface-2/40 p-4">
              <svg viewBox="0 0 800 320" role="img" aria-label="15-minute window timeline showing the shakeout, active entry zone, and exit phase" className="h-auto w-full font-sans" preserveAspectRatio="xMidYMid meet">
                {/* Background Grid */}
                <line x1="60" y1="50" x2="760" y2="50" stroke="var(--color-line)" strokeDasharray="3 3" />
                <line x1="60" y1="130" x2="760" y2="130" stroke="var(--color-line)" strokeDasharray="3 3" />
                <line x1="60" y1="210" x2="760" y2="210" stroke="var(--color-line)" strokeDasharray="3 3" />
                <line x1="60" y1="280" x2="760" y2="280" stroke="var(--color-line)" />

                {/* Y-axis Labels */}
                <text x="50" y="55" textAnchor="end" fontSize="11" fill="var(--color-faint)">$67,500</text>
                <text x="50" y="135" textAnchor="end" fontSize="11" fill="var(--color-accent)" fontWeight="bold">$67,400</text>
                <text x="50" y="215" textAnchor="end" fontSize="11" fill="var(--color-faint)">$67,250</text>
                <text x="50" y="280" textAnchor="end" fontSize="11" fill="var(--color-danger)">$67,150</text>

                {/* Anchor Reference Line ($67,400) */}
                <line x1="60" y1="130" x2="760" y2="130" stroke="var(--color-accent)" strokeWidth="1.5" strokeDasharray="5 5" />
                <text x="755" y="125" textAnchor="end" fontSize="11" fill="var(--color-accent)" fontWeight="bold">Window Open Anchor ($67,400)</text>

                {/* Observation Window Divider (Min 5 = X: 310) */}
                <line x1="310" y1="30" x2="310" y2="290" stroke="var(--color-line-strong)" strokeWidth="1.5" strokeDasharray="4 4" />
                <text x="315" y="42" fontSize="11" fill="var(--color-muted)" fontWeight="600">Minute 5: Observation End</text>

                {/* Price Trajectory Path */}
                <path
                  d="M60,130 C80,200 95,280 120,280 L220,280 C260,280 280,275 310,270 C340,265 360,225 390,210 L440,200 C500,180 560,70 620,50 L750,45"
                  fill="none"
                  stroke="var(--color-fg)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />

                {/* Event 1: Panic Dump */}
                <circle cx="120" cy="280" r="4.5" fill="var(--color-danger)" />
                <text x="120" y="305" textAnchor="middle" fontSize="10.5" fill="var(--color-danger)">14:01 Dump to $67,150</text>
                <text x="120" y="260" textAnchor="middle" fontSize="10" fill="var(--color-faint)">Down odds hit 82¢</text>

                {/* Event 2: Shakeout Exhausts */}
                <circle cx="260" cy="280" r="4" fill="var(--color-muted)" />
                <text x="260" y="265" textAnchor="middle" fontSize="10" fill="var(--color-muted)">14:04 Stabilized</text>

                {/* Event 3: Direction confirmed & Entry */}
                <circle cx="440" cy="200" r="6" fill="var(--color-success)" stroke="#fff" strokeWidth="2" />
                <rect x="360" y="145" width="160" height="42" rx="6" fill="var(--color-surface)" stroke="var(--color-success)" strokeWidth="1.2" />
                <text x="440" y="162" textAnchor="middle" fontSize="11" fill="var(--color-success)" fontWeight="bold">14:07 BUY UP @ 28¢</text>
                <text x="440" y="177" textAnchor="middle" fontSize="10" fill="var(--color-muted)">Held 60s · Model p = 55%</text>

                {/* Event 4: Profit Take */}
                <circle cx="620" cy="50" r="6" fill="var(--color-info)" stroke="#fff" strokeWidth="2" />
                <rect x="545" y="65" width="150" height="42" rx="6" fill="var(--color-surface)" stroke="var(--color-info)" strokeWidth="1.2" />
                <text x="620" y="82" textAnchor="middle" fontSize="11" fill="var(--color-info)" fontWeight="bold">14:11 SELL UP @ 85¢</text>
                <text x="620" y="97" textAnchor="middle" fontSize="10" fill="var(--color-muted)">Profit Target Hit (+203%)</text>
              </svg>
            </div>

            {/* Step-by-Step Breakdown Grid */}
            <div className="mt-5 grid gap-3 sm:grid-cols-4">
              <div className="rounded-tile border border-line bg-surface p-3">
                <span className="font-mono text-[11px] font-bold text-accent">STEP 1 · 14:00</span>
                <p className="mt-1 text-[13px] font-semibold text-fg">Market Opens @ $67,400</p>
                <p className="mt-1 text-[12px] text-muted">Anchor captured from live spot feed. Both outcomes start near 50¢.</p>
              </div>

              <div className="rounded-tile border border-line bg-surface p-3">
                <span className="font-mono text-[11px] font-bold text-danger">STEP 2 · 14:01–14:04</span>
                <p className="mt-1 text-[13px] font-semibold text-fg">Shakeout Dump to $67,150</p>
                <p className="mt-1 text-[12px] text-muted">Emotional crowd buys DOWN at 82¢. UP crashes to 18¢. Bot stays idle.</p>
              </div>

              <div className="rounded-tile border border-line bg-surface p-3">
                <span className="font-mono text-[11px] font-bold text-success">STEP 3 · 14:07</span>
                <p className="mt-1 text-[13px] font-semibold text-fg">Reversal Entry @ 28¢</p>
                <p className="mt-1 text-[12px] text-muted">BTC rallied to $67,250 over 60s. Damped momentum model yields 55% probability.</p>
              </div>

              <div className="rounded-tile border border-line bg-surface p-3">
                <span className="font-mono text-[11px] font-bold text-info">STEP 4 · 14:11</span>
                <p className="mt-1 text-[13px] font-semibold text-fg">Profit Locked @ 85¢</p>
                <p className="mt-1 text-[12px] text-muted">UP reaches 88¢. Marketable FAK sells at 85¢. 57¢ profit per share banked.</p>
              </div>
            </div>
          </Card>

          {/* Section: The Six Entry Gates Breakdown */}
          <section id="entry-gates" className="scroll-mt-16">
            <h3 className="text-[16px] font-semibold text-fg">The Six Mandatory Entry Gates</h3>
            <p className="mt-0.5 text-[13px] text-muted">All six gates must evaluate to true. If any single gate fails, the trade is skipped.</p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {ENTRY_GATES.map((gate) => {
                const IconComponent = gate.icon
                return (
                  <Card key={gate.title} className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-surface-2 text-muted">
                          <IconComponent className="size-4" aria-hidden="true" />
                        </span>
                        <div>
                          <h4 className="text-[14px] font-semibold text-fg">{gate.title}</h4>
                          <span className="text-[12px] font-medium text-accent">{gate.subtitle}</span>
                        </div>
                      </div>
                      <Badge tone={gate.tone}>{gate.keyMetric}</Badge>
                    </div>

                    <p className="mt-3 text-[13px] leading-relaxed text-muted">{gate.body}</p>

                    <div className="mt-4 flex items-center justify-between border-t border-line pt-2.5">
                      <span className="text-[11px] uppercase tracking-wider text-faint">{gate.metricLabel}</span>
                      <code className="font-mono text-[11.5px] text-fg">{gate.setting}</code>
                    </div>
                  </Card>
                )
              })}
            </div>
          </section>
      </section>

      {/* SECTION 2: MATHEMATICAL FORMULATIONS */}
      <section id="strategy-math" aria-label="Mathematical formulation and edge model" className="scroll-mt-16 space-y-6">
          <Card className="p-6">
            <h3 className="text-[16px] font-semibold text-fg">Mathematical Models & Pricing Formulations</h3>
            <p className="text-[13px] text-muted">
              Mathematical derivations governing the true probability estimates, fees, edge thresholds, and fractional sizing.
            </p>

            <div className="mt-6 space-y-6">
              {/* Formula 1: Drift-Adjusted Probability Model */}
              <div id="formula-probability" className="scroll-mt-16 rounded-card border border-line bg-surface-2/30 p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-[14.5px] font-bold text-fg">1. Log-Normal Probability Model with Momentum Drift</h4>
                  <Badge tone="accent">Drifted Brownian Motion</Badge>
                </div>
                <p className="mt-1 text-[13px] text-muted">
                  Estimates the cumulative probability that BTC ends above the open reference price at window close:
                </p>

                {/* Formula Display Block */}
                <div className="my-4 overflow-x-auto rounded-tile border border-line bg-surface p-4 text-center font-serif text-[18px] text-fg shadow-sm">
                  <span>
                    <i>p</i> = Φ
                    <span className="inline-block px-1">
                      <span className="inline-flex flex-col text-center align-middle text-[15px]">
                        <span className="border-b border-fg pb-0.5 font-normal">
                          ln(<i>P</i> / <i>P</i><sub>0</sub>) + μ · τ
                        </span>
                        <span className="pt-0.5 font-normal">
                          σ · √τ
                        </span>
                      </span>
                    </span>
                  </span>
                </div>

                {/* Variable Dictionary */}
                <div className="grid gap-2 text-[12.5px] sm:grid-cols-2">
                  <div className="rounded bg-surface p-2 border border-line/70">
                    <strong className="font-mono text-accent">P</strong> : Current spot price ($67,250)
                  </div>
                  <div className="rounded bg-surface p-2 border border-line/70">
                    <strong className="font-mono text-accent">P₀</strong> : Window open reference anchor ($67,400)
                  </div>
                  <div className="rounded bg-surface p-2 border border-line/70">
                    <strong className="font-mono text-accent">μ</strong> : Damped post-shakeout recovery velocity (damped by 0.42)
                  </div>
                  <div className="rounded bg-surface p-2 border border-line/70">
                    <strong className="font-mono text-accent">τ</strong> : Remaining time to expiry in seconds
                  </div>
                  <div className="rounded bg-surface p-2 border border-line/70">
                    <strong className="font-mono text-accent">σ</strong> : Realized volatility per √second from variance scaling
                  </div>
                  <div className="rounded bg-surface p-2 border border-line/70">
                    <strong className="font-mono text-accent">Φ(·)</strong> : Standard normal cumulative distribution function (CDF)
                  </div>
                </div>
              </div>

              {/* Formula 2: Crypto Taker Fee Schedule */}
              <div id="formula-fees" className="scroll-mt-16 rounded-card border border-line bg-surface-2/30 p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-[14.5px] font-bold text-fg">2. Polymarket Crypto Category Taker Fee Schedule</h4>
                  <Badge tone="warning">Variable Quadratic Fee</Badge>
                </div>
                <p className="mt-1 text-[13px] text-muted">
                  Polymarket charges taker fees on crypto Up/Down markets scaled parabolically with contract price:
                </p>

                <div className="my-4 overflow-x-auto rounded-tile border border-line bg-surface p-4 text-center font-serif text-[18px] text-fg shadow-sm">
                  <span>
                    Fee = <i>C</i> · <i>r</i> · <i>p</i> · (1 − <i>p</i>)
                  </span>
                </div>

                <div className="text-[12.5px] text-muted">
                  With multiplier <code className="font-mono text-fg font-semibold">C = 1</code> and rate{' '}
                  <code className="font-mono text-fg font-semibold">r = 0.07 (7%)</code>. The fee peaks at exactly{' '}
                  <strong className="text-fg font-semibold">1.75¢ per share</strong> when price is 50¢, dropping to{' '}
                  <strong className="text-fg font-semibold">1.41¢</strong> at 28¢ and <strong className="text-fg font-semibold">0.89¢</strong> at 85¢.
                </div>
              </div>

              {/* Formula 3: Statistical Edge Criterion */}
              <div id="formula-edge" className="scroll-mt-16 rounded-card border border-line bg-surface-2/30 p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-[14.5px] font-bold text-fg">3. Net Statistical Edge Threshold</h4>
                  <Badge tone="success">Hard Gate ≥ 6¢</Badge>
                </div>
                <p className="mt-1 text-[13px] text-muted">
                  Orders execute solely when the estimated win probability exceeds the total acquisition cost by at least 6 cents:
                </p>

                <div className="my-4 overflow-x-auto rounded-tile border border-line bg-surface p-4 text-center font-serif text-[18px] text-fg shadow-sm">
                  <span>
                    Edge = <i>p</i><sub>model</sub> − Ask − TakerFee(Ask) ≥ 0.06
                  </span>
                </div>

                <p className="text-[12.5px] text-muted">
                  Example: Model evaluates <code className="font-mono text-fg font-semibold">p = 0.555</code> on UP. Ask is{' '}
                  <code className="font-mono text-fg font-semibold">0.28</code> with fee{' '}
                  <code className="font-mono text-fg font-semibold">0.014</code>. Net edge is{' '}
                  <code className="font-mono text-success font-semibold">0.555 − 0.28 − 0.014 = +0.261 (26.1¢)</code>, comfortably exceeding the 6¢ requirement.
                </p>
              </div>

              {/* Formula 4: Fractional Kelly Sizing */}
              <div id="formula-kelly" className="scroll-mt-16 rounded-card border border-line bg-surface-2/30 p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-[14.5px] font-bold text-fg">4. Quarter Kelly Position Sizing Formula</h4>
                  <Badge tone="info">Risk Allocation</Badge>
                </div>
                <p className="mt-1 text-[13px] text-muted">
                  Prevents gambler's ruin by scaling bet size proportional to edge, scaled down to 25% of full Kelly:
                </p>

                <div className="my-4 overflow-x-auto rounded-tile border border-line bg-surface p-4 text-center font-serif text-[18px] text-fg shadow-sm">
                  <span>
                    <i>f</i><sup>*</sup> ={' '}
                    <span className="inline-flex flex-col text-center align-middle text-[15px]">
                      <span className="border-b border-fg pb-0.5 font-normal">
                        <i>p</i> − <i>Price</i><sub>eff</sub>
                      </span>
                      <span className="pt-0.5 font-normal">
                        1 − <i>Price</i><sub>eff</sub>
                      </span>
                    </span>
                    <span className="mx-4 text-faint">|</span>
                    Position = min( Bankroll · 0.25 · <i>f</i><sup>*</sup>, Bankroll · 0.08, Cash )
                  </span>
                </div>

                <div className="grid gap-2 text-[12.5px] sm:grid-cols-3">
                  <div className="rounded bg-surface p-2.5 border border-line">
                    <span className="text-faint text-[11px] block uppercase font-mono">Bankroll $1,000</span>
                    <span className="font-semibold text-fg">Stake Range: $30 – $80</span>
                  </div>
                  <div className="rounded bg-surface p-2.5 border border-line">
                    <span className="text-faint text-[11px] block uppercase font-mono">Hard Cap</span>
                    <span className="font-semibold text-fg">8% Max Allocation</span>
                  </div>
                  <div className="rounded bg-surface p-2.5 border border-line">
                    <span className="text-faint text-[11px] block uppercase font-mono">Kelly Cut</span>
                    <span className="font-semibold text-fg">0.25 (¼ Kelly)</span>
                  </div>
                </div>
              </div>
            </div>
          </Card>
      </section>

      {/* SECTION 3: EXIT MATRIX */}
      <section id="strategy-exits" aria-label="Mechanical exit matrix and scenarios" className="scroll-mt-16 space-y-6">
          <Card id="exit-matrix" className="scroll-mt-16 p-6">
            <h3 className="text-[16px] font-semibold text-fg">The Mechanical Exit Matrix</h3>
            <p className="text-[13px] text-muted">
              Pre-programmed, non-emotional exits executed automatically by the bot loop.
            </p>

            <div className="mt-5 space-y-3">
              {EXIT_SCENARIOS.map((sc) => (
                <div
                  key={sc.id}
                  className="rounded-tile border border-line bg-surface p-4 transition-all hover:bg-surface-2/40"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <Badge tone={sc.tone}>{sc.badge}</Badge>
                      <span className="text-[14px] font-semibold text-fg">{sc.condition}</span>
                    </div>
                    <span className="font-mono text-[12.5px] font-bold text-muted">{sc.pnl}</span>
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-[200px_1fr] text-[13px]">
                    <div className="font-medium text-fg">Action: {sc.action}</div>
                    <div className="text-muted leading-relaxed">{sc.why}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Grace Window Visual Note */}
          <Card id="exit-grace" className="scroll-mt-16 border-accent/30 bg-accent-soft/20 p-5">
            <div className="flex items-start gap-3">
              <Zap className="size-5 shrink-0 text-accent mt-0.5" />
              <div>
                <h4 className="text-[14px] font-bold text-fg">15-Second Hysteresis Grace Window</h4>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">
                  Order book bid quotes naturally jitter on the CLOB (e.g. 60¢ → 59¢ → 61¢). Rather than resetting the
                  3-minute stall timer to 0 on a single 2-second blip, the bot maintains a 15-second grace window,
                  preventing micro-fluctuations from breaking stall discipline.
                </p>
              </div>
            </div>
          </Card>
      </section>

      {/* SECTION 4: RISK & SIZING */}
      <section id="strategy-risk" aria-label="Capital sizing and risk discipline" className="scroll-mt-16 space-y-6">
          <Card className="p-6">
            <h3 className="text-[16px] font-semibold text-fg">Capital Preservation & Risk Discipline</h3>
            <p className="text-[13px] text-muted">
              Why 60% win-rate traders blow up without sizing rules, and how this bot prevents gambler's ruin.
            </p>

            <div id="risk-kelly" className="mt-6 grid scroll-mt-16 gap-4 sm:grid-cols-2">
              {/* Card 1: Quarter Kelly */}
              <div className="rounded-tile border border-success/30 bg-success-soft/20 p-5">
                <span className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-wider text-success">
                  <CheckCircle2 className="size-4" /> Recommended: Fractional Kelly
                </span>
                <h4 className="mt-2 text-[15px] font-bold text-fg">Quarter Kelly (¼ Kelly)</h4>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
                  Position size is determined by mathematical edge, cut by 75% to absorb variance. On $1,000 bankroll, typical
                  position is <strong className="text-fg font-semibold">$30 – $80</strong>. A sequence of losses naturally
                  shrinks position sizing, mathematically eliminating bankruptcy risk.
                </p>
                <div className="mt-4 rounded bg-surface p-2.5 text-[12px] font-mono text-fg border border-line">
                  Max single trade risk: ≤ 8% of bankroll
                </div>
              </div>

              {/* Card 2: Martingale Trap */}
              <div className="rounded-tile border border-danger/30 bg-danger-soft/20 p-5">
                <span className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-wider text-danger">
                  <AlertTriangle className="size-4" /> Strictly Forbidden: Martingale
                </span>
                <h4 className="mt-2 text-[15px] font-bold text-fg">Doubling Down on Losses</h4>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
                  Doubling stake after a loss to "make it back" guarantees account ruin in binary prediction markets.
                  Four unexpected losses in chop turn an $80 trade into $1,280. Sizing ignores streaks entirely.
                </p>
                <div className="mt-4 rounded bg-surface p-2.5 text-[12px] font-mono text-danger border border-line">
                  Streak multiplier: 1.0× (Zero martingale)
                </div>
              </div>
            </div>

            {/* Hard Stop Parameters */}
            <div id="risk-breakers" className="mt-6 scroll-mt-16 border-t border-line pt-5">
              <h4 className="text-[14px] font-bold text-fg">Deterministic Circuit Breakers</h4>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div className="rounded-tile border border-line bg-surface p-3.5">
                  <span className="text-[11px] font-mono uppercase text-faint">Consecutive Losses</span>
                  <p className="mt-1 text-[16px] font-bold text-danger">2 Losses in a Row</p>
                  <p className="text-[12px] text-muted">Halts trading for remainder of UTC day</p>
                </div>

                <div className="rounded-tile border border-line bg-surface p-3.5">
                  <span className="text-[11px] font-mono uppercase text-faint">Daily Loss Ceiling</span>
                  <p className="mt-1 text-[16px] font-bold text-danger">3% of Equity</p>
                  <p className="text-[12px] text-muted">Locks bankroll to protect principle</p>
                </div>

                <div className="rounded-tile border border-line bg-surface p-3.5">
                  <span className="text-[11px] font-mono uppercase text-faint">Max Drawdown</span>
                  <p className="mt-1 text-[16px] font-bold text-danger">15% from Peak</p>
                  <p className="text-[12px] text-muted">Emergency halt until manual audit</p>
                </div>
              </div>
            </div>
          </Card>
      </section>
        </div>

        {/* Side table of contents — jumps to sections, scroll-spy highlights current */}
        <aside className="hidden lg:block">
          <nav aria-label="Table of contents" className="sticky top-6 rounded-card border border-line bg-surface-2/30 p-4">
            <p className="px-2 text-[11px] font-semibold uppercase tracking-wider text-faint">On this page</p>
            <ul className="mt-2 space-y-1.5">
              {TOC.map((item) => {
                const isActive = activeId === item.id || item.children.some((child) => child.id === activeId)
                return (
                  <li key={item.id}>
                    <a
                      href={`#${item.id}`}
                      aria-current={isActive ? 'location' : undefined}
                      className={`block rounded-tile px-2 py-1.5 text-[12.5px] leading-snug transition-colors ${
                        isActive ? 'bg-surface font-semibold text-accent shadow-sm' : 'font-medium text-muted hover:bg-surface hover:text-fg'
                      }`}
                    >
                      {item.label}
                    </a>
                    <ul className="ml-2 mt-0.5 space-y-0.5 border-l border-line pl-3">
                      {item.children.map((child) => {
                        const childActive = activeId === child.id
                        return (
                          <li key={child.id}>
                            <a
                              href={`#${child.id}`}
                              aria-current={childActive ? 'location' : undefined}
                              className={`block rounded-tile px-2 py-1 text-[12px] leading-snug transition-colors ${
                                childActive ? 'font-semibold text-accent' : 'text-faint hover:text-fg'
                              }`}
                            >
                              {child.label}
                            </a>
                          </li>
                        )
                      })}
                    </ul>
                  </li>
                )
              })}
            </ul>
          </nav>
        </aside>
      </div>

      {/* Footer attribution */}
      <Card className="mt-6 flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-tile bg-accent-soft text-accent">
            <BookOpen className="size-4.5" />
          </span>
          <div>
            <p className="text-[13.5px] font-medium text-fg">Primary Source</p>
            <p className="text-[12.5px] text-muted">
              Johannes Thüroff, M.Eng. (Crypticorn), “The Polymarket 5-Minute Strategy I Actually Use (Tested)”.
            </p>
          </div>
        </div>
        <Link to="/config" className="text-[12.5px] font-medium text-fg hover:underline">
          Tune threshold settings →
        </Link>
      </Card>
    </div>
  )
}
