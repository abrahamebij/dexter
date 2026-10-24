import { FiKey, FiShield } from 'react-icons/fi'

export default function Permissions() {
  return (
    <div className="max-w-3xl space-y-10">
      <header><p className="text-sm text-subtle">Permissions</p><h1 className="mt-3 text-4xl font-medium tracking-[-0.06em]">Your boundaries, clearly shown.</h1></header>
      <section className="rounded-2xl border border-line p-6 sm:p-8">
        <div className="flex items-center gap-4 border-b border-line pb-6"><span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent"><FiKey /></span><div><p className="font-medium">Dexter session key</p><p className="mt-1 text-sm text-muted">Connected to your linked bot</p></div></div>
        <div className="grid gap-5 py-6 sm:grid-cols-2"><span><small className="block text-muted">Can do</small><b className="mt-1 block font-medium">Partial closes</b></span><span><small className="block text-muted">Cannot do</small><b className="mt-1 block font-medium">Withdraw or open</b></span></div>
        <button type="button" className="border-b border-ink pb-2 text-sm font-medium">Revoke permission</button>
      </section>
      <p className="flex gap-3 text-sm leading-6 text-muted"><FiShield className="mt-1 shrink-0 text-accent" /> Dexter is designed to act within a narrow, reviewable boundary. You can revoke access at any time.</p>
    </div>
  )
}
