import { useState } from 'react'
import { Link } from 'react-router'
import { useAccount, useSignMessage } from 'wagmi'
import { FiArrowLeft, FiArrowUpRight } from 'react-icons/fi'
import { api, authenticatedRequest } from '../lib/api'

type CompiledRule = { market: string; trigger: { type: 'liquidation_distance_pct'; thresholdPct: number } | { type: 'mark_price'; direction: 'below' | 'above'; price: number }; action: { type: 'notify_only' } | { type: 'partial_close'; closePct: 25 | 50 | 75 | 100 }; cooldownSeconds: number }
type CompileResult = { rule: CompiledRule; restatement: string; warning?: string; model: string; docsUrl: string }

export default function NewGuard() {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [text, setText] = useState('')
  const [owner, setOwner] = useState(() => window.localStorage.getItem('dexter.owner') ?? address ?? '')
  const [compiled, setCompiled] = useState<CompileResult | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  async function compile() {
    setBusy(true); setMessage('')
    try {
      setCompiled(await api<CompileResult>('/api/guards/compile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, owner }) }))
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }

  async function save() {
    if (!compiled || !address) return
    setBusy(true); setMessage('')
    try {
      await authenticatedRequest('/api/guards', owner, (message) => signMessageAsync({ message }), { method: 'POST', body: JSON.stringify({ owner, ...compiled.rule, source: text }) })
      setMessage('Guard saved.')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }

  return (
    <div className="max-w-3xl space-y-10">
      <Link to="/app" className="inline-flex items-center gap-2 text-sm text-muted hover:text-ink"><FiArrowLeft /> Back to overview</Link>
      <header><p className="text-sm text-subtle">New guard</p><h1 className="mt-3 text-4xl font-medium tracking-[-0.06em]">Describe what you want protected.</h1></header>
      <section className="space-y-6 rounded-2xl border border-line p-6 sm:p-8">
        <label className="block text-sm font-medium" htmlFor="owner">DreamDEX wallet owner
          <input id="owner" value={owner} onChange={(event) => { setOwner(event.target.value); window.localStorage.setItem('dexter.owner', event.target.value) }} className="mt-2 w-full rounded-xl border border-line-strong bg-panel p-3 font-mono text-sm outline-none focus:border-accent" />
          <small className="mt-2 block font-normal text-muted">Sign with the connected wallet. This may be a different smart-wallet address.</small>
        </label>
        <label className="block text-sm font-medium" htmlFor="rule">Your rule
          <textarea id="rule" rows={4} value={text} onChange={(event) => setText(event.target.value)} placeholder="If my ETH liquidation distance falls below 15%, reduce my position by 50%." className="mt-2 w-full resize-none rounded-xl border border-line-strong bg-panel p-4 text-base outline-none placeholder:text-subtle focus:border-accent" />
        </label>
        <button type="button" onClick={compile} disabled={busy || !text || !owner} className="inline-flex items-center gap-3 rounded-full bg-ink px-5 py-3 text-sm font-medium text-canvas disabled:opacity-50">{busy ? 'Working…' : 'Compile rule'} <FiArrowUpRight /></button>
        {compiled && <div className="space-y-5 rounded-xl bg-panel p-5">
          <p className="text-xs uppercase tracking-[0.15em] text-subtle">Validated rule</p>
          <p className="text-lg leading-7">{compiled.restatement}</p>
          <pre className="overflow-auto text-xs text-muted">{JSON.stringify(compiled.rule, null, 2)}</pre>
          {compiled.warning && <p className="border-l-2 border-accent pl-3 text-sm text-muted">{compiled.warning}</p>}
          <button type="button" onClick={save} disabled={busy} className="border-b border-ink pb-2 text-sm font-medium">Sign and save</button>
        </div>}
        {message && <p className="text-sm text-muted">{message}</p>}
      </section>
      <p className="text-sm leading-6 text-muted">Dexter only simulates while dry run is on. A saved guard can only perform the validated partial-close action.</p>
    </div>
  )
}
