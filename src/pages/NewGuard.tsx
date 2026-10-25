import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useAccount, useSignMessage } from 'wagmi'
import { FiArrowLeft, FiArrowUpRight } from 'react-icons/fi'
import { api, authenticatedRequest } from '../lib/api'

type Rule = { market: string; trigger: { type: 'liquidation_distance_pct'; thresholdPct: number } | { type: 'mark_price'; direction: 'below' | 'above'; price: number }; action: { type: 'notify_only' } | { type: 'partial_close'; closePct: 25 | 50 | 75 | 100 }; cooldownSeconds: number }
type Result = { rule: Rule; restatement: string; warning?: string; assumptions: string[]; model: string; docsUrl: string; source: 'gemini' | 'cache' | 'manual'; keyUsed?: 'primary' | 'fallback' }

export default function NewGuard() {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [text, setText] = useState('')
  const [owner, setOwner] = useState(() => window.localStorage.getItem('dexter.owner') ?? address ?? '')
  const [markets, setMarkets] = useState<string[]>([])
  const [manual, setManual] = useState(false)
  const [triggerType, setTriggerType] = useState<'liquidation_distance_pct' | 'mark_price'>('liquidation_distance_pct')
  const [threshold, setThreshold] = useState('10')
  const [direction, setDirection] = useState<'below' | 'above'>('below')
  const [price, setPrice] = useState('')
  const [action, setAction] = useState<'notify_only' | 'partial_close'>('notify_only')
  const [closePct, setClosePct] = useState<25 | 50 | 75 | 100>(50)
  const [market, setMarket] = useState('')
  const [cooldown, setCooldown] = useState('300')
  const [compiled, setCompiled] = useState<Result | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastCompileAt, setLastCompileAt] = useState(0)

  useEffect(() => { api<{ markets: string[] }>('/api/markets').then((value) => { setMarkets(value.markets); setMarket(value.markets[0] ?? '') }).catch((error) => setMessage(error instanceof Error ? error.message : String(error))) }, [])

  async function compile() {
    if (Date.now() - lastCompileAt < 3_000) { setMessage('Please wait three seconds between compile requests.'); return }
    setBusy(true); setMessage(''); setLastCompileAt(Date.now())
    try {
      setCompiled(await api<Result>('/api/guards/compile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, owner }) }))
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }

  async function validateManual() {
    setBusy(true); setMessage('')
    const rule = { market, trigger: triggerType === 'mark_price' ? { type: triggerType, direction, price: Number(price) } : { type: triggerType, thresholdPct: Number(threshold) }, action: action === 'notify_only' ? { type: action } : { type: action, closePct }, cooldownSeconds: Number(cooldown) }
    try { setCompiled(await api<Result>('/api/guards/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner, rule }) })) } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }

  async function save() {
    if (!compiled || !address) return
    setBusy(true); setMessage('')
    try { await authenticatedRequest('/api/guards', owner, (message) => signMessageAsync({ message }), { method: 'POST', body: JSON.stringify({ owner, ...compiled.rule, source: compiled.source === 'manual' ? 'manual' : 'ai' }) }); setMessage('Guard saved.') } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }

  return <div className="max-w-3xl space-y-10">
    <Link to="/app" className="inline-flex items-center gap-2 text-sm text-muted hover:text-ink"><FiArrowLeft /> Back to overview</Link>
    <header><p className="text-sm text-subtle">New guard</p><h1 className="mt-3 text-4xl font-medium tracking-[-0.06em]">Describe what you want protected.</h1></header>
    <section className="space-y-6 rounded-2xl border border-line p-6 sm:p-8">
      <label className="block text-sm font-medium" htmlFor="owner">DreamDEX wallet owner<input id="owner" value={owner} onChange={(event) => { setOwner(event.target.value); window.localStorage.setItem('dexter.owner', event.target.value) }} className="mt-2 w-full rounded-xl border border-line-strong bg-panel p-3 font-mono text-sm outline-none focus:border-accent" /></label>
      <div className="flex gap-4 text-sm"><button type="button" onClick={() => setManual(false)} className={!manual ? 'border-b border-ink pb-1 font-medium' : 'text-muted'}>Describe in plain English</button><button type="button" onClick={() => setManual(true)} className={manual ? 'border-b border-ink pb-1 font-medium' : 'text-muted'}>Build manually</button></div>
      {!manual ? <><label className="block text-sm font-medium" htmlFor="rule">Your rule<textarea id="rule" rows={4} value={text} onChange={(event) => setText(event.target.value)} placeholder="If my ETH liquidation distance falls below 15%, reduce my position by 50%." className="mt-2 w-full resize-none rounded-xl border border-line-strong bg-panel p-4 text-base outline-none placeholder:text-subtle focus:border-accent" /></label><button type="button" onClick={compile} disabled={busy || !text || !owner} className="inline-flex items-center gap-3 rounded-full bg-ink px-5 py-3 text-sm font-medium text-canvas disabled:opacity-50">{busy ? 'Working...' : 'Compile rule'} <FiArrowUpRight /></button></> :
        <div className="grid gap-4 text-sm"><label>Market<select value={market} onChange={(event) => setMarket(event.target.value)} className="mt-2 w-full rounded-xl border border-line-strong bg-panel p-3">{markets.map((item) => <option key={item}>{item}</option>)}</select></label><label>Trigger<select value={triggerType} onChange={(event) => setTriggerType(event.target.value as typeof triggerType)} className="mt-2 w-full rounded-xl border border-line-strong bg-panel p-3"><option value="liquidation_distance_pct">Liquidation distance percent</option><option value="mark_price">Mark price</option></select></label>{triggerType === 'liquidation_distance_pct' ? <label>Threshold percent<input type="number" value={threshold} onChange={(event) => setThreshold(event.target.value)} className="mt-2 w-full rounded-xl border border-line-strong bg-panel p-3" /></label> : <><label>Direction<select value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)} className="mt-2 w-full rounded-xl border border-line-strong bg-panel p-3"><option value="below">Below</option><option value="above">Above</option></select></label><label>Price<input type="number" value={price} onChange={(event) => setPrice(event.target.value)} className="mt-2 w-full rounded-xl border border-line-strong bg-panel p-3" /></label></>}<label>Action<select value={action} onChange={(event) => setAction(event.target.value as typeof action)} className="mt-2 w-full rounded-xl border border-line-strong bg-panel p-3"><option value="notify_only">Notify only</option><option value="partial_close">Partial close</option></select></label>{action === 'partial_close' && <label>Close percent<select value={closePct} onChange={(event) => setClosePct(Number(event.target.value) as typeof closePct)} className="mt-2 w-full rounded-xl border border-line-strong bg-panel p-3">{[25, 50, 75, 100].map((item) => <option key={item} value={item}>{item}%</option>)}</select></label>}<label>Cooldown seconds<input type="number" value={cooldown} onChange={(event) => setCooldown(event.target.value)} className="mt-2 w-full rounded-xl border border-line-strong bg-panel p-3" /></label><button type="button" onClick={validateManual} disabled={busy || !owner || !market} className="w-fit rounded-full bg-ink px-5 py-3 font-medium text-canvas disabled:opacity-50">{busy ? 'Working...' : 'Validate manual rule'}</button></div>}
      {compiled && <div className="space-y-5 rounded-xl bg-panel p-5"><div className="flex gap-3 text-xs uppercase tracking-[0.15em] text-subtle"><span>{compiled.source}</span>{compiled.keyUsed && <span>{compiled.keyUsed}</span>}</div><p className="text-lg leading-7">{compiled.restatement}</p>{compiled.assumptions.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-muted">{compiled.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>}<pre className="overflow-auto text-xs text-muted">{JSON.stringify(compiled.rule, null, 2)}</pre>{compiled.warning && <p className="border-l-2 border-accent pl-3 text-sm text-muted">{compiled.warning}</p>}<button type="button" onClick={save} disabled={busy} className="border-b border-ink pb-2 text-sm font-medium">Sign and save</button></div>}
      {message && <p className="text-sm text-muted">{message}</p>}
    </section>
    <p className="text-sm leading-6 text-muted">Dexter only simulates while dry run is on. A saved guard can only perform the validated partial-close action.</p>
  </div>
}
