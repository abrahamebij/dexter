import { NavLink, Outlet } from 'react-router'
import { ConnectKitButton } from 'connectkit'
import { FiActivity, FiGrid, FiKey, FiTrendingUp } from 'react-icons/fi'
import { useEffect, useState } from 'react'
import { api, ownerStorageKey, type AuthorityResult } from '../lib/api'
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
  const [owner, setOwner] = useState('')
  const [accountError, setAccountError] = useState('')

  useEffect(() => {
    let active = true
    const load = () => api<{ connected: boolean; dryRun: boolean }>('/api/health').then((value) => active && setHealth(value)).catch(() => active && setHealth(null))
    load()
    const timer = window.setInterval(load, 5_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    if (!address) {
      setOwner('')
      setAccountError('')
      return
    }
    const stored = window.localStorage.getItem(ownerStorageKey(address))
    if (!stored) {
      setOwner('')
      setAccountError('')
      return
    }
    api<AuthorityResult>(`/api/authority?account=${encodeURIComponent(stored)}&signer=${encodeURIComponent(address)}`)
      .then((result) => {
        if (result.hasAuthority) setOwner(stored)
        else {
          window.localStorage.removeItem(ownerStorageKey(address))
          setOwner('')
          setAccountError('The saved DreamDEX wallet is no longer verified for this connected wallet.')
        }
      })
      .catch((error) => {
        setOwner('')
        setAccountError(error instanceof Error ? error.message : String(error))
      })
  }, [address])

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5 lg:px-10">
          <NavLink to="/" className="flex items-center gap-2 text-lg font-semibold tracking-[-0.04em]">
            <img src="/logo.png" alt="" className="h-7 w-7" />
            Dexter
          </NavLink>
          <div className="flex items-center gap-4">
            <div className="hidden items-center gap-3 lg:flex"><span className="text-xs text-muted">{owner ? `Guarding ${owner.slice(0, 6)}…${owner.slice(-4)}` : accountError || 'No verified DreamDEX wallet'}</span><span className="text-xs text-muted">{health ? `${health.connected ? 'Watcher connected' : 'Watcher offline'} · ${health.dryRun ? 'Dry run on' : 'Live execution'}` : 'Watcher unavailable'}</span></div>
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
