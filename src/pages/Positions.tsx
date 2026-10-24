import { Link } from 'react-router'
import { FiArrowUpRight } from 'react-icons/fi'

export default function Positions() {
  return (
    <div className="space-y-10">
      <header><p className="text-sm text-subtle">Positions</p><h1 className="mt-3 text-4xl font-medium tracking-[-0.06em]">Your open positions.</h1></header>
      <div className="overflow-hidden rounded-2xl border border-line">
        <div className="hidden grid-cols-[1.3fr_1fr_1fr_1fr_auto] gap-4 border-b border-line bg-panel px-6 py-4 text-xs uppercase tracking-[0.15em] text-subtle md:grid">
          <span>Market</span><span>Size</span><span>Entry</span><span>PnL</span><span />
        </div>
        <div className="grid gap-5 px-6 py-6 md:grid-cols-[1.3fr_1fr_1fr_1fr_auto] md:items-center md:gap-4">
          <div><p className="font-medium">ETH / USDC</p><p className="mt-1 text-sm text-muted">Long · 5x</p></div>
          <div><p className="text-sm">$4,200</p><p className="mt-1 text-xs text-muted">0.84 ETH</p></div>
          <p className="text-sm">$2,846.12</p><p className="text-sm text-accent">+$183.40</p>
          <Link to="/app/guards/new" className="flex items-center gap-2 text-sm font-medium">Guard this <FiArrowUpRight /></Link>
        </div>
      </div>
    </div>
  )
}
