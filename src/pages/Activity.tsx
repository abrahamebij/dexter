import { useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { api, resolveOwner } from '../lib/api'
type EventItem = { timestamp: string; kind: string; market?: string; reason?: string; txHash?: string; explorer?: string }
export default function Activity() {
  const { address } = useAccount(); const [events, setEvents] = useState<EventItem[]>([])
  useEffect(() => { if (!address) return; const load = () => api<EventItem[]>(`/api/events?owner=${resolveOwner(address)}`).then((value) => setEvents([...value].reverse())).catch(() => undefined); load(); const timer = window.setInterval(load, 5_000); return () => window.clearInterval(timer) }, [address])
  return <div className="space-y-10"><header><p className="text-sm text-subtle">Activity</p><h1 className="mt-3 text-4xl font-medium tracking-[-0.06em]">A record of every decision.</h1></header>{events.length === 0 ? <div className="rounded-2xl border border-line p-8 text-sm text-muted">No events for this address.</div> : <div className="divide-y divide-line rounded-2xl border border-line">{events.map((event, index) => <div key={`${event.timestamp}-${index}`} className="px-6 py-6"><p className="font-medium">{event.kind}</p><p className="mt-1 text-sm text-muted">{event.market ?? ''} {event.reason ?? ''}</p><p className="mt-2 text-xs text-subtle">{new Date(event.timestamp).toLocaleString()}</p>{event.txHash && <a className="mt-2 inline-block text-sm underline" href={event.explorer} target="_blank" rel="noreferrer">{event.txHash}</a>}</div>)}</div>}</div>
}
