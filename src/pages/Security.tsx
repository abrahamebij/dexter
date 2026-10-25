import { useEffect, useState } from 'react'
import { api } from '../lib/api'
export default function Security() {
  const [health, setHealth] = useState<{ dryRun: boolean; connected: boolean } | null>(null)
  useEffect(() => { const load = () => api<{ dryRun: boolean; connected: boolean }>('/api/health').then(setHealth).catch(() => setHealth(null)); load(); const timer = window.setInterval(load, 5_000); return () => window.clearInterval(timer) }, [])
  return <div className="mx-auto max-w-4xl px-6 py-24 lg:px-10"><p className="text-sm text-subtle">Security</p><h1 className="mt-6 text-6xl font-medium tracking-[-0.08em]">Control is the product.</h1><p className="mt-8 max-w-xl text-lg leading-8 text-muted">Dexter compiles explicit rules, requires a wallet signature to save or change them, and records watcher decisions. The bot is limited to approved order actions.</p>{health && <p className="mt-8 text-sm text-muted">Watcher: {health.connected ? 'connected' : 'offline'} · DRY_RUN: {health.dryRun ? 'true — simulations only' : 'false — execution enabled'}</p>}</div>
}
