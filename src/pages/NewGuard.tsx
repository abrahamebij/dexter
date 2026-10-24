import { Link } from 'react-router'
import { FiArrowLeft, FiArrowUpRight, FiCheck } from 'react-icons/fi'

export default function NewGuard() {
  return (
    <div className="max-w-3xl space-y-10">
      <Link to="/app" className="inline-flex items-center gap-2 text-sm text-muted hover:text-ink"><FiArrowLeft /> Back to overview</Link>
      <header><p className="text-sm text-subtle">New guard</p><h1 className="mt-3 text-4xl font-medium tracking-[-0.06em]">Describe what you want protected.</h1></header>
      <section className="space-y-8 rounded-2xl border border-line p-6 sm:p-8">
        <div>
          <label htmlFor="rule" className="text-sm font-medium">Your rule</label>
          <textarea id="rule" rows={4} placeholder="If my ETH liquidation distance falls below 15%, reduce my position by 50%." className="mt-3 w-full resize-none rounded-xl border border-line-strong bg-panel p-4 text-base outline-none placeholder:text-subtle focus:border-accent" />
        </div>
        <div className="rounded-xl bg-panel p-5">
          <p className="text-xs uppercase tracking-[0.15em] text-subtle">Dexter understood</p>
          <div className="mt-5 grid gap-4 text-sm sm:grid-cols-3">
            <span><b className="block font-medium">Trigger</b><small className="text-muted">Distance below 15%</small></span>
            <span><b className="block font-medium">Market</b><small className="text-muted">ETH / USDC</small></span>
            <span><b className="block font-medium">Action</b><small className="text-muted">Reduce by 50%</small></span>
          </div>
        </div>
        <button type="button" className="inline-flex items-center gap-3 rounded-full bg-ink px-5 py-3 text-sm font-medium text-canvas">Review guard <FiArrowUpRight /></button>
      </section>
      <p className="flex items-start gap-3 text-sm leading-6 text-muted"><FiCheck className="mt-1 shrink-0 text-accent" /> Dexter will only be able to perform the exact action shown above.</p>
    </div>
  )
}
