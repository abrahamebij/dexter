import { NavLink, Outlet } from 'react-router'
import { ConnectKitButton } from 'connectkit'
import { FiActivity, FiGrid, FiKey, FiTrendingUp } from 'react-icons/fi'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useAccount } from 'wagmi'

const navigation = [
  { to: '/app', label: 'Overview', icon: FiGrid, end: true },
  { to: '/app/positions', label: 'Positions', icon: FiTrendingUp },
  { to: '/app/activity', label: 'Activity', icon: FiActivity },
  { to: '/app/settings/permissions', label: 'Permissions', icon: FiKey },
]

export default function AppShell() {
  const { address } = useAccount()
  const [health, setHealth] = useState<{ connected: boolean; dryRun: boolean } | null>(null)
  const [owner, setOwner] = useState(() => window.localStorage.getItem('dexter.owner') ?? address ?? '')

  useEffect(() => {
    let active = true
    const load = () => api<{ connected: boolean; dryRun: boolean }>('/api/health').then((value) => active && setHealth(value)).catch(() => active && setHealth(null))
    load()
    const timer = window.setInterval(load, 5_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5 lg:px-10">
          <NavLink to="/" className="flex items-center gap-2 text-lg font-semibold tracking-[-0.04em]">
            <img src="/logo.png" alt="" className="h-7 w-7" />
            dexter
          </NavLink>
          <div className="flex items-center gap-4">
            <div className="hidden items-center gap-3 lg:flex"><input aria-label="DreamDEX wallet owner" value={owner} onChange={(event) => { setOwner(event.target.value); window.localStorage.setItem('dexter.owner', event.target.value) }} placeholder={address ?? 'DreamDEX wallet'} className="w-40 border-b border-line bg-transparent px-1 py-1 text-xs font-mono outline-none focus:border-accent" /><span className="text-xs text-muted">{health ? `${health.connected ? 'Watcher connected' : 'Watcher offline'} · ${health.dryRun ? 'Dry run on' : 'Live execution'}` : 'Watcher unavailable'}</span></div>
            <ConnectKitButton />
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-7xl flex-col gap-10 px-6 py-10 lg:flex-row lg:px-10 lg:py-14">
        <aside className="w-full shrink-0 lg:w-48">
          <nav className="flex gap-2 overflow-x-auto lg:flex-col">
            {navigation.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) => `flex items-center gap-3 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm transition-colors ${isActive ? 'bg-panel font-medium text-ink' : 'text-muted hover:text-ink'}`}
              >
                <Icon />
                {label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
