import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { FiArrowUpRight } from 'react-icons/fi'
import { useAccount } from 'wagmi'
import { api, resolveOwner, ruleText, type Guard } from '../lib/api'

export default function Dashboard() {
  const { address } = useAccount()
  const [guards, setGuards] = useState<Guard[]>([])
  const [positions, setPositions] = useState(0)
  useEffect(() => {
    if (!address) return
    const load = () => { api<Guard[]>(`/api/guards?owner=${resolveOwner(address)}`).then(setGuards).catch(() => undefined); api<{ positions: unknown[] }>(`/api/positions?owner=${resolveOwner(address)}`).then((value) => setPositions(value.positions.length)).catch(() => undefined) }
    load(); const timer = window.setInterval(load, 5_000); return () => window.clearInterval(timer)
  }, [address])
  return <div className="space-y-10"><header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="text-sm text-subtle">Overview</p><h1 className="mt-3 text-4xl font-medium tracking-[-0.06em]">Your risk, clearly shown.</h1></div><Link to="/app/guards/new" className="inline-flex w-fit items-center gap-2 rounded-full bg-ink px-5 py-3 text-sm font-medium text-canvas">Create guard <FiArrowUpRight /></Link></header>
    <div className="grid gap-4 md:grid-cols-3">{[['Open positions', String(positions)], ['Active guards', String(guards.filter((guard) => guard.status === 'active').length)], ['Dry-run behavior', 'Simulation only']].map(([label, value]) => <div key={label} className="rounded-2xl border border-line bg-panel p-6"><p className="text-sm text-muted">{label}</p><p className="mt-5 text-3xl font-medium tracking-[-0.05em]">{value}</p></div>)}</div>
    <section className="rounded-2xl border border-line p-6 sm:p-8"><p className="text-sm text-subtle">Active guards</p>{guards.filter((guard) => guard.status === 'active').length === 0 ? <p className="mt-5 text-sm text-muted">No active guards yet.</p> : <div className="mt-5 space-y-4">{guards.filter((guard) => guard.status === 'active').map((guard) => <Link key={guard.id} to={`/app/guards/${guard.id}`} className="block border-b border-line pb-4 last:border-0"><p className="font-medium">{guard.market}</p><p className="mt-1 text-sm text-muted">{ruleText(guard)}</p></Link>)}</div>}</section>
  </div>
}
