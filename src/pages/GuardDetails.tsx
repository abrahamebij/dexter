import { Link } from 'react-router'
import { FiArrowLeft, FiPause, FiShield } from 'react-icons/fi'

export default function GuardDetails() {
  return (
    <div className="max-w-3xl space-y-10">
      <Link to="/app" className="inline-flex items-center gap-2 text-sm text-muted hover:text-ink"><FiArrowLeft /> Back to overview</Link>
      <header className="flex items-start justify-between gap-5"><div><p className="text-sm text-subtle">Guard details</p><h1 className="mt-3 text-4xl font-medium tracking-[-0.06em]">ETH / USDC</h1></div><FiShield className="mt-2 text-accent" /></header>
      <section className="rounded-2xl border border-line p-6 sm:p-8">
        <p className="text-sm text-subtle">Rule</p><p className="mt-4 text-2xl leading-relaxed tracking-[-0.04em]">“If liquidation distance falls below 15%, reduce my position by 50%.”</p>
        <div className="mt-8 grid gap-5 border-t border-line pt-6 sm:grid-cols-3"><span><small className="block text-muted">Status</small><b className="mt-1 block font-medium text-accent">Watching</b></span><span><small className="block text-muted">Permission</small><b className="mt-1 block font-medium">Partial close only</b></span><span><small className="block text-muted">Last checked</small><b className="mt-1 block font-medium">Just now</b></span></div>
      </section>
      <button type="button" className="inline-flex items-center gap-2 border-b border-ink pb-2 text-sm font-medium"><FiPause /> Pause guard</button>
    </div>
  )
}
