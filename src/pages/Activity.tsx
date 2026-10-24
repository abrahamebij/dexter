import { FiArrowUpRight, FiCheck, FiClock } from 'react-icons/fi'

const events = [
  ['Guard evaluated', 'ETH / USDC remained above its boundary', 'Just now', 'check'],
  ['Guard created', 'Partial close permission confirmed', '2 hours ago', 'check'],
  ['Wallet connected', 'Session ready for review', '2 hours ago', 'clock'],
]

export default function Activity() {
  return (
    <div className="space-y-10">
      <header><p className="text-sm text-subtle">Activity</p><h1 className="mt-3 text-4xl font-medium tracking-[-0.06em]">A record of every decision.</h1></header>
      <div className="divide-y divide-line rounded-2xl border border-line">
        {events.map(([title, copy, time, icon]) => <div key={title} className="flex items-start gap-4 px-6 py-6"><span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">{icon === 'check' ? <FiCheck /> : <FiClock />}</span><div className="flex-1"><p className="font-medium">{title}</p><p className="mt-1 text-sm text-muted">{copy}</p></div><span className="text-xs text-subtle">{time}</span></div>)}
      </div>
      <a href="/" className="inline-flex items-center gap-2 text-sm font-medium">View transaction history <FiArrowUpRight /></a>
    </div>
  )
}
