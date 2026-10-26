import { ConnectKitButton } from 'connectkit'
import { FiArrowLeft, FiLock } from 'react-icons/fi'
import { Link, Outlet } from 'react-router'
import { useAccount } from 'wagmi'

export default function AuthShield() {
  const { isConnected } = useAccount()

  if (!isConnected) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas px-6 text-ink">
        <div className="w-full max-w-md text-center">
          <Link to="/" className="mx-auto flex w-fit items-center gap-2 text-lg font-semibold tracking-[-0.04em]">
            <img src="/logo.png" alt="" className="h-7 w-7" />
            Dexter
          </Link>
          <div className="mt-16 rounded-2xl border border-line bg-panel p-8 sm:p-10">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent"><FiLock /></span>
            <h1 className="mt-6 text-3xl font-medium tracking-[-0.06em]">Connect to continue.</h1>
            <p className="mx-auto mt-4 max-w-xs text-sm leading-6 text-muted">Your positions and guards live behind your wallet. Connect to access your private workspace.</p>
            <div className="mt-8 flex justify-center"><ConnectKitButton /></div>
          </div>
          <Link to="/" className="mt-8 inline-flex items-center gap-2 text-sm text-muted hover:text-ink"><FiArrowLeft /> Return home</Link>
        </div>
      </main>
    )
  }

  return <Outlet />
}
