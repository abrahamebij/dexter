import { Link } from 'react-router'
import { FiArrowUpRight, FiCheck, FiClock, FiShield } from 'react-icons/fi'

export default function Dashboard() {
  return (
    <div className="space-y-10">
      <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm text-subtle">Overview</p>
          <h1 className="mt-3 text-4xl font-medium tracking-[-0.06em]">Good to have you back.</h1>
        </div>
        <Link to="/app/guards/new" className="inline-flex w-fit items-center gap-2 rounded-full bg-ink px-5 py-3 text-sm font-medium text-canvas">
          Create guard <FiArrowUpRight />
        </Link>
      </header>
      <div className="grid gap-4 md:grid-cols-3">
        {[
          ['Account value', '$12,480.20'],
          ['Open positions', '02'],
          ['Active guards', '01'],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-line bg-panel p-6">
            <p className="text-sm text-muted">{label}</p>
            <p className="mt-5 text-3xl font-medium tracking-[-0.05em]">{value}</p>
          </div>
        ))}
      </div>
      <section className="rounded-2xl border border-line p-6 sm:p-8">
        <div className="flex items-center justify-between border-b border-line pb-5">
          <div>
            <p className="text-sm text-subtle">Active guard</p>
            <h2 className="mt-2 text-2xl font-medium tracking-[-0.05em]">ETH / USDC</h2>
          </div>
          <FiShield className="text-accent" />
        </div>
        <p className="max-w-xl py-8 text-xl leading-relaxed tracking-[-0.03em]">“If liquidation distance falls below 15%, reduce my position by 50%.”</p>
        <div className="flex flex-wrap gap-x-8 gap-y-3 border-t border-line pt-5 text-sm text-muted">
          <span className="flex items-center gap-2"><FiCheck className="text-accent" /> Watching</span>
          <span className="flex items-center gap-2"><FiClock /> Last checked just now</span>
        </div>
      </section>
    </div>
  )
}
