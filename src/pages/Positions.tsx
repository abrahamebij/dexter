import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { FiArrowUpRight } from 'react-icons/fi'
import { useAccount } from 'wagmi'
import { api, resolveOwner } from '../lib/api'

type Position = { market: string; side: string; size: string; entryPrice: string; markPrice: string | null; margin: string; liquidationPrice: string | null; liquidationPriceDisplay: string; liquidationDistancePct: number | null; unrealizedPnl: string | null }
export default function Positions() {
  const { address } = useAccount()
  const [positions, setPositions] = useState<Position[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    if (!address) return
    const load = () => api<{ positions: Position[] }>(`/api/positions?owner=${resolveOwner(address)}`).then((value) => { setPositions(value.positions); setError('') }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
    load(); const timer = window.setInterval(load, 5_000); return () => window.clearInterval(timer)
  }, [address])
  return <div className="space-y-10"><header><p className="text-sm text-subtle">Positions</p><h1 className="mt-3 text-4xl font-medium tracking-[-0.06em]">Your open positions.</h1></header>
    {error && <p className="text-sm text-muted">{error}</p>}
    {positions.length === 0 ? <div className="rounded-2xl border border-line p-8 text-sm text-muted">No open positions for this connected address.</div> : <div className="grid gap-4">{positions.map((position) => <div key={position.market} className="rounded-2xl border border-line p-6"><div className="flex items-start justify-between"><div><p className="font-medium">{position.market}</p><p className="mt-1 text-sm text-muted">{position.side} · {position.size}</p></div><Link to="/app/guards/new" className="flex items-center gap-2 text-sm font-medium">Guard this <FiArrowUpRight /></Link></div><div className="mt-6 grid gap-4 text-sm sm:grid-cols-3"><span><small className="block text-muted">Entry / mark</small>{position.entryPrice} / {position.markPrice ?? '—'}</span><span><small className="block text-muted">Liquidation</small>{position.liquidationPriceDisplay} {position.liquidationDistancePct === null ? '' : `(${position.liquidationDistancePct}%)`}</span><span><small className="block text-muted">Unrealized PnL</small>{position.unrealizedPnl ?? '—'}</span></div></div>)}</div>}
  </div>
}
