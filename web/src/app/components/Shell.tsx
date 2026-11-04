import { Activity, BookOpen, LayoutDashboard, Menu as MenuIcon, Moon, SlidersHorizontal, Sun, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'

import { cx } from '../lib/cx'

const links = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/live', label: 'Live bot', icon: Activity },
  { to: '/config', label: 'Configuration', icon: SlidersHorizontal },
  { to: '/strategy', label: 'Strategy', icon: BookOpen },
]

function getInitialTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark'
  const saved = localStorage.getItem('bot-theme')
  if (saved === 'dark' || saved === 'light') return saved
  return 'dark'
}

export function Shell() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(getInitialTheme)
  const location = useLocation()

  useEffect(() => setMobileOpen(false), [location.pathname])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    if (theme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
    localStorage.setItem('bot-theme', theme)
  }, [theme])

  const toggleTheme = () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))

  const sidebar = (
    <div className="flex h-full flex-col px-3 py-3">
      <div className="flex h-10 items-center gap-2.5 px-2">
        <span className="grid size-7 place-items-center rounded-[9px] bg-fg text-surface">
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 16.5l5-5 3.5 3.5L20 6.5" />
            <path d="M20 11V6.5h-4.5" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-semibold tracking-tight">Up/Down desk</p>
          <p className="truncate text-[11px] text-faint">Polymarket 5m · 15m</p>
        </div>
      </div>

      <nav className="mt-4 flex flex-col gap-0.5">
        {links.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cx(
                'flex h-9 items-center gap-2.5 rounded-control px-2.5 text-[13.5px] font-medium transition-colors',
                isActive ? 'bg-surface text-fg shadow-card' : 'text-muted hover:bg-raised/60 hover:text-fg',
              )
            }
          >
            <Icon className="size-4" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-2 px-1 pb-1">
        <button
          type="button"
          onClick={toggleTheme}
          className="flex h-9 w-full items-center justify-between rounded-control px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:bg-raised/60 hover:text-fg"
          aria-label="Toggle theme"
        >
          <span className="flex items-center gap-2">
            {theme === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
            <span>{theme === 'dark' ? 'Dark theme' : 'Light theme'}</span>
          </span>
          <span className="text-[11px] font-mono text-faint uppercase">{theme}</span>
        </button>

        <p className="text-[11.5px] leading-relaxed text-faint">
          Paper by default. Live orders only ever come from a manual <span className="font-mono">--live</span> run.
        </p>
      </div>
    </div>
  )

  return (
    <div className="flex h-full">
      <aside className="hidden w-[236px] shrink-0 border-r border-line bg-bg lg:block">{sidebar}</aside>

      <div className="fixed inset-x-0 top-0 z-30 flex h-12 items-center justify-between border-b border-line bg-bg/90 px-3 backdrop-blur lg:hidden">
        <button type="button" aria-label="Open menu" onClick={() => setMobileOpen(true)} className="grid size-9 place-items-center rounded-control">
          <MenuIcon className="size-5" />
        </button>
        <span className="text-[14px] font-semibold">Up/Down desk</span>
        <button type="button" onClick={toggleTheme} className="grid size-9 place-items-center rounded-control text-muted" aria-label="Toggle theme">
          {theme === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
        </button>
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMobileOpen(false)}>
          <div className="absolute inset-0 bg-fg/20" />
          <aside className="absolute inset-y-0 left-0 w-[280px] bg-bg shadow-dialog" onClick={(e) => e.stopPropagation()}>
            <button type="button" aria-label="Close menu" onClick={() => setMobileOpen(false)} className="absolute right-3 top-3 grid size-9 place-items-center rounded-control">
              <X className="size-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <main className="min-w-0 flex-1 pt-12 lg:p-2 lg:pl-0 lg:pt-2">
        <div className="scrollbar-thin h-full overflow-y-auto bg-surface lg:rounded-card lg:border lg:border-line">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
