import { useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { api, resolveOwner } from '../lib/api'
type PermissionsData = { bot: string; botBalance: string; permissions: Array<{ market: string; approved: boolean }> }
export default function Permissions() {
  const { address } = useAccount(); const [data, setData] = useState<PermissionsData | null>(null); const [error, setError] = useState('')
  useEffect(() => { if (!address) return; const load = () => api<PermissionsData>(`/api/permissions?owner=${resolveOwner(address)}`).then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); load(); const timer = window.setInterval(load, 5_000); return () => window.clearInterval(timer) }, [address])
  return <div className="max-w-3xl space-y-10"><header><p className="text-sm text-subtle">Permissions</p><h1 className="mt-3 text-4xl font-medium tracking-[-0.06em]">A narrow execution boundary.</h1></header>{error && <p className="text-sm text-muted">{error}</p>}{data && <section className="rounded-2xl border border-line p-6 sm:p-8"><p className="font-medium">Linked bot</p><p className="mt-2 break-all font-mono text-xs text-muted">{data.bot}</p><p className="mt-2 text-sm text-muted">Balance: {data.botBalance} STT</p><div className="mt-6 space-y-3">{data.permissions.map((permission) => <div key={permission.market} className="flex justify-between border-t border-line pt-3 text-sm"><span>{permission.market}</span><span>{permission.approved ? 'Linked' : 'Not linked'}</span></div>)}</div><p className="mt-6 text-sm leading-6 text-muted">The bot can place orders and partially close for the owner when approved. It cannot withdraw funds or run reduce-only stops.</p></section>}</div>
}
