export type Guard = {
  id: string
  owner: string
  market: string
  trigger: { type: 'liquidation_distance_pct'; thresholdPct: number } | { type: 'mark_price'; direction: 'below' | 'above'; price: number }
  action: { type: 'notify_only' } | { type: 'partial_close'; closePct: 25 | 50 | 75 | 100 }
  cooldownSeconds: number
  status: 'active' | 'paused' | 'fired'
  createdAt: string
  lastTriggeredAt: string | null
  source: string
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const payload = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(payload.error ?? `Request failed with ${response.status}`)
  return payload
}

export function ruleText(guard: Pick<Guard, 'market' | 'trigger' | 'action'>): string {
  const trigger = guard.trigger.type === 'mark_price'
    ? `when mark price is ${guard.trigger.direction} ${guard.trigger.price}`
    : `when liquidation is within ${guard.trigger.thresholdPct}% of mark price`
  const action = guard.action.type === 'notify_only' ? 'send a notification' : `close ${guard.action.closePct}%`
  return `On ${guard.market}, ${action} ${trigger}.`
}

export function resolveOwner(connectedAddress?: string): string {
  if (typeof window !== 'undefined') return window.localStorage.getItem('dexter.owner') ?? connectedAddress ?? ''
  return connectedAddress ?? ''
}

export async function authenticatedRequest<T>(path: string, owner: string, signMessage: (message: string) => Promise<`0x${string}`>, init: RequestInit = {}): Promise<T> {
  const nonce = await api<{ message: string; owner: string }>(`/api/auth/nonce?owner=${encodeURIComponent(owner)}`)
  const signature = await signMessage(nonce.message)
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  headers.set('x-dexter-auth', JSON.stringify({ message: nonce.message, signature, owner }))
  return api<T>(path, { ...init, headers })
}
