import { BookOpen, Clock, ShieldCheck, SlidersHorizontal, Target, TrendingUp } from 'lucide-react'
import { Link } from 'react-router'

import { Badge, Card, PageHeader } from '../components/ui'

const ENTRY_GATES: { title: string; body: string; setting: string }[] = [
  {
    title: 'Wait out the shakeout',
    body: 'No entry in the first five minutes of a 15-minute window. There is no information yet — only noise. Five-minute windows use 100 seconds of observation.',
    setting: '15m observation · 5m observation',
  },
  {
    title: 'The direction has to hold',
    body: 'After the observation window, the price must stay on one side of the window-open reference for at least 60 seconds (20s on 5m). One wick back through the anchor resets it.',
    setting: 'minDirectionHoldSeconds',
  },
  {
    title: 'The move must be real, not extended',
    body: 'A move under 0.05% is inside the noise. A move over 0.5% means the odds have already corrected and you are chasing.',
    setting: 'minMovePct · maxMovePct',
  },
  {
    title: 'The odds must still be mispriced',
    body: 'The bot prices the true probability with a log-normal model and requires at least 6¢ of edge over the ask, after the taker fee. If the market already repriced, there is no trade.',
    setting: 'minEdge · minModelProb · maxModelProb',
  },
  {
    title: 'The book has to be tradeable',
    body: 'Spread at or under 2¢, and never pay more than 65¢ for a side — expensive favourites have no room left to run.',
    setting: 'maxSpreadCents · maxEntryPriceCents',
  },
  {
    title: 'Sit out dead tape and news',
    body: 'If BTC moved less than 0.3% in the last hour or oscillates in a tight < $50 corridor, there is no trapped money to harvest. Scheduled news is a hard blackout: entries stop and open positions leave.',
    setting: 'minHourlyRangePct · tightChopRangeUsd · news blackout',
  },
]

const EXIT_RULES: { condition: string; action: string; note: string }[] = [
  { condition: 'Bid reaches 85¢', action: 'Sell', note: 'The guide locks profit at 85–90¢ rather than holding for the last few cents.' },
  { condition: 'Odds stall at 60–70¢ for 3 minutes', action: 'Sell', note: 'If the thesis were right, the market would have moved. Stalling means the edge is gone. Single-tick CLOB blips are filtered with a 15s grace window.' },
  { condition: 'Odds reverse below entry but above 20¢', action: 'Hold', note: 'Small reversals are noise; selling here just donates the spread.' },
  { condition: 'Odds collapse to 20¢ or below', action: 'Hold to resolution', note: 'The loss is already priced in — selling locks it for nothing.' },
  { condition: 'Scheduled news hits', action: 'Sell immediately', note: 'The thesis was built on a quiet tape. News invalidates it.' },
]

const RISK_RULES: { title: string; body: string }[] = [
  { title: 'Quarter Kelly, hard-capped', body: 'Position size comes from edge, cut to a quarter of full Kelly and capped at 8% of bankroll — roughly $30–80 per $1,000. The guide is blunt about this being the difference between a strategy and a gambling habit.' },
  { title: '3–6 trades a day, not 96', body: 'There are 96 fifteen-minute windows a day (and 288 five-minute windows). The edge is in the few that set up properly; the rest are skipped on purpose.' },
  { title: 'Two losses in a row ends the day', body: 'Back-to-back losses in chop mean the regime does not suit the strategy. The bot halts for the day instead of trying to win it back.' },
  { title: 'Never martingale', body: 'Sizing never reacts to a streak. Doubling after a loss is how a 60% win rate still ruins an account.' },
  { title: 'A daily loss cap and a drawdown kill switch', body: '3% down on the day stops trading; 15% off the high-water mark stops everything until you intervene.' },
]

export function Strategy() {
  return (
    <div className="mx-auto max-w-[1000px] p-5 sm:p-8">
      <PageHeader
        title="The strategy"
        subtitle="“The Polymarket 5-Minute Strategy I Actually Use (Tested)” — as implemented by this bot."
        actions={
          <Link to="/config" className="inline-flex h-8 items-center gap-1.5 rounded-tile border border-line-strong bg-surface px-3 text-[13px] font-medium shadow-[0_1px_1px_rgb(20_20_24/0.04)] hover:bg-surface-2">
            <SlidersHorizontal className="size-3.5" /> Tune thresholds
          </Link>
        }
      />

      <Card className="mt-5 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">BTC Up or Down</Badge>
          <Badge tone="neutral">5-minute windows</Badge>
          <Badge tone="neutral">15-minute windows</Badge>
          <Badge tone="info">Paper by default</Badge>
        </div>
        <p className="mt-4 text-[13.5px] leading-relaxed text-muted">
          Polymarket runs recurring “Bitcoin Up or Down” markets that resolve against Chainlink BTC/USD at the end of a
          fixed window. Most participants pile in during the first minutes, when the price has not decided anything yet.
          The strategy is to let that shakeout finish, confirm which side actually held, and only then buy the side the
          market is still underpricing. The edge is not prediction — it is waiting for the crowd to reveal its hand while
          the odds lag.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Fact icon={<Clock className="size-4" />} label="Observation" value="First 5 min: no trade" />
          <Fact icon={<Target className="size-4" />} label="Entry window" value="Minutes 5–11" />
          <Fact icon={<TrendingUp className="size-4" />} label="Expected hit rate" value="55–65%, wins 2–3×" />
        </div>
      </Card>

      <section className="mt-6">
        <h2 className="text-[15px] font-semibold">The six entry gates</h2>
        <p className="mt-0.5 text-[13px] text-muted">All six must pass. The Live page shows which one stopped the bot and why.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {ENTRY_GATES.map((gate, index) => (
            <Card key={gate.title} className="p-5">
              <div className="flex items-start gap-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-surface-2 text-[12px] font-semibold text-muted">
                  {index + 1}
                </span>
                <div>
                  <h3 className="text-[13.5px] font-semibold">{gate.title}</h3>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted">{gate.body}</p>
                  <p className="mt-2 font-mono text-[11.5px] text-faint">{gate.setting}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-[15px] font-semibold">The exit table</h2>
        <p className="mt-0.5 text-[13px] text-muted">Mechanical, decided before entry — that is the point.</p>
        <Card className="mt-3 overflow-hidden">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-surface-2/60 text-[11.5px] uppercase tracking-wide text-faint">
              <tr>
                <th className="px-5 py-2.5 font-medium">If</th>
                <th className="px-5 py-2.5 font-medium">Then</th>
                <th className="px-5 py-2.5 font-medium">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {EXIT_RULES.map((rule) => (
                <tr key={rule.condition}>
                  <td className="px-5 py-3 font-medium">{rule.condition}</td>
                  <td className="px-5 py-3">
                    <Badge tone={rule.action.startsWith('Sell') ? 'info' : 'neutral'}>{rule.action}</Badge>
                  </td>
                  <td className="px-5 py-3 text-muted">{rule.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      <section className="mt-6">
        <h2 className="text-[15px] font-semibold">Sizing and survival</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {RISK_RULES.map((rule) => (
            <Card key={rule.title} className="p-5">
              <h3 className="flex items-center gap-2 text-[13.5px] font-semibold">
                <ShieldCheck className="size-4 text-success" />
                {rule.title}
              </h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{rule.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-[15px] font-semibold">How this bot applies it</h2>
        <Card className="mt-3 divide-y divide-line">
          {[
            ['Reference price', 'Captured from the bot’s own feed at the window open, so distance, direction and volatility come from one source. Mid-window starts recover the open from 1-minute candles and demand an extra 0.05% of move.'],
            ['Probability model', 'Driftless Brownian motion: p = Φ(ln(price/anchor) / (σ√τ)), with σ from realised variance. The crypto taker fee of 0.07 · p · (1 − p) is subtracted from edge.'],
            ['Order placement', 'Marketable FAK orders through the official SDK, bounded by a maximum price. Nothing rests on the book, so there is nothing to cancel when the thesis changes.'],
            ['Window discovery', 'Slug-addressed windows (btc-updown-5m-<unix>, btc-updown-15m-<unix>) read straight from Gamma; books come from the CLOB. No scraping, no hardcoded IDs.'],
            ['What it will not do', 'Martingale, trade through scheduled news it was not told about, size off a losing streak, or place a live order unless started with --live.'],
          ].map(([title, body]) => (
            <div key={title} className="grid gap-1 p-4 sm:grid-cols-[180px_1fr] sm:gap-4">
              <p className="text-[13px] font-medium">{title}</p>
              <p className="text-[13px] leading-relaxed text-muted">{body}</p>
            </div>
          ))}
        </Card>
      </section>

      <Card className="mt-6 flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-tile bg-accent-soft text-accent">
            <BookOpen className="size-4.5" />
          </span>
          <div>
            <p className="text-[13.5px] font-medium">Source</p>
            <p className="text-[12.5px] text-muted">
              Johannes Thüroff (Crypticorn), “The Polymarket 5-Minute Strategy I Actually Use (Tested)”. This page is the
              implementation, not the article.
            </p>
          </div>
        </div>
        <Link to="/config" className="text-[12.5px] font-medium text-fg hover:underline">
          Open configuration
        </Link>
      </Card>
    </div>
  )
}

function Fact({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-tile border border-line bg-surface-2/40 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11.5px] uppercase tracking-wide text-faint">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-[13px] font-medium">{value}</p>
    </div>
  )
}
