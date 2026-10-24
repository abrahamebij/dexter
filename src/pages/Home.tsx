import { useRef } from 'react'
import { Link } from 'react-router'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { FiArrowUpRight, FiCheck, FiChevronDown, FiShield, FiTerminal } from 'react-icons/fi'

gsap.registerPlugin(ScrollTrigger)

const steps = [
  {
    number: '01',
    title: 'Say what matters',
    copy: 'Describe the risk you want to manage in plain English. Dexter turns intent into a rule you can review.',
  },
  {
    number: '02',
    title: 'Set the boundary',
    copy: 'Choose the market, trigger, and amount. Your guard stays narrow, explicit, and yours to revoke.',
  },
  {
    number: '03',
    title: 'Stay in control',
    copy: 'When the rule is met, Dexter can reduce risk through your delegated bot. No guessing. No constant watching.',
  },
]

const principles = ['Deterministic rules', 'Delegated permissions', 'Auditable actions']

export default function Home() {
  const page = useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      const intro = gsap.timeline({ defaults: { ease: 'power3.out' } })

      intro
        .from('.nav-item', { y: -12, opacity: 0, duration: 0.6, stagger: 0.08 })
        .from('.hero-line', { y: 36, opacity: 0, duration: 0.8, stagger: 0.12 }, '-=0.35')
        .from('.hero-copy', { y: 20, opacity: 0, duration: 0.7 }, '-=0.45')
        .from('.hero-panel', { x: 24, opacity: 0, duration: 0.9 }, '-=0.65')
        .from('.hero-footer', { opacity: 0, duration: 0.6 }, '-=0.4')

      gsap.utils.toArray<HTMLElement>('.reveal-section').forEach((section) => {
        gsap.from(section, {
          y: 34,
          opacity: 0,
          duration: 0.8,
          ease: 'power3.out',
          scrollTrigger: {
            trigger: section,
            start: 'top 82%',
          },
        })
      })
    },
    { scope: page },
  )

  return (
    <main ref={page} className="min-h-screen overflow-hidden bg-canvas text-ink">
      <nav className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-7 lg:px-10">
        <Link to="/" className="nav-item flex items-center gap-2 text-lg font-semibold tracking-[-0.04em]">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-xs text-canvas">d</span>
          dexter
        </Link>
        <div className="hidden items-center gap-9 text-sm text-muted md:flex">
          <a className="nav-item transition-colors hover:text-ink" href="#how-it-works">How it works</a>
          <a className="nav-item transition-colors hover:text-ink" href="#principles">Principles</a>
          <a className="nav-item transition-colors hover:text-ink" href="#start">Get started</a>
        </div>
        <a href="#start" className="nav-item group flex items-center gap-2 text-sm font-medium">
          Launch app
          <FiArrowUpRight className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </a>
      </nav>

      <section className="mx-auto grid w-full max-w-7xl items-center gap-16 px-6 pb-24 pt-20 lg:grid-cols-[1.08fr_0.92fr] lg:px-10 lg:pb-36 lg:pt-28">
        <div>
          <p className="hero-line mb-8 text-xs font-medium uppercase tracking-[0.22em] text-subtle">Risk management, made human</p>
          <h1 className="max-w-3xl text-[clamp(3.5rem,8vw,7.5rem)] font-medium leading-[0.91] tracking-[-0.085em]">
            Trade with a
            <span className="hero-line block">clearer head.</span>
          </h1>
          <p className="hero-copy mt-10 max-w-md text-lg leading-8 text-muted">
            Dexter watches your position the way you would, if you never had to sleep. Describe a rule, set the boundary, and keep your downside deliberate.
          </p>
          <div className="hero-copy mt-10 flex flex-wrap items-center gap-5">
            <a href="#start" className="group inline-flex items-center gap-3 rounded-full bg-ink px-6 py-3.5 text-sm font-medium text-canvas transition-transform hover:-translate-y-0.5">
              Create your first guard
              <FiArrowUpRight className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </a>
            <a href="#how-it-works" className="inline-flex items-center gap-2 text-sm font-medium text-muted transition-colors hover:text-ink">
              See how it works
              <FiChevronDown />
            </a>
          </div>
        </div>

        <div className="hero-panel relative">
          <div className="rounded-[2rem] border border-line bg-panel p-5 sm:p-7">
            <div className="flex items-start justify-between border-b border-line-strong pb-6">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-subtle">Active guard</p>
                <h2 className="mt-2 text-2xl font-medium tracking-[-0.05em]">ETH / USDC</h2>
              </div>
              <span className="mt-1 flex items-center gap-2 text-xs font-medium text-accent">
                <span className="h-2 w-2 rounded-full bg-accent-strong" />
                Watching
              </span>
            </div>
            <div className="py-8">
              <p className="text-sm text-muted">Your rule</p>
              <p className="mt-3 max-w-sm text-2xl leading-tight tracking-[-0.05em]">
                “If liquidation distance falls below <span className="text-accent">15%</span>, reduce my position by <span className="text-accent">50%</span>.”
              </p>
            </div>
            <div className="grid grid-cols-2 border-t border-line-strong pt-5">
              <div>
                <p className="text-xs text-subtle">Permission</p>
                <p className="mt-1 text-sm font-medium">Partial close only</p>
              </div>
              <div>
                <p className="text-xs text-subtle">Last checked</p>
                <p className="mt-1 text-sm font-medium">Just now</p>
              </div>
            </div>
          </div>
          <div className="absolute -bottom-7 -left-3 flex items-center gap-3 rounded-2xl border border-line bg-canvas px-4 py-3 shadow-sm sm:-left-8">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-accent"><FiShield /></span>
            <div>
              <p className="text-xs text-subtle">Permissioned action</p>
              <p className="text-sm font-medium">Nothing beyond the rule</p>
            </div>
          </div>
        </div>
      </section>

      <div className="hero-footer mx-auto flex w-full max-w-7xl items-center gap-3 px-6 pb-20 text-xs uppercase tracking-[0.16em] text-subtle lg:px-10">
        <span className="h-px w-10 bg-accent-soft" />
        Built for focused decisions
      </div>

      <section id="how-it-works" className="reveal-section border-t border-line">
        <div className="mx-auto grid max-w-7xl gap-12 px-6 py-24 lg:grid-cols-[0.7fr_1.3fr] lg:px-10 lg:py-32">
          <div>
            <p className="text-sm text-subtle">01 / How it works</p>
            <h2 className="mt-8 max-w-sm text-4xl font-medium leading-[1.02] tracking-[-0.065em] sm:text-5xl">A simple rule, carried through.</h2>
          </div>
          <div className="divide-y divide-line border-y border-line">
            {steps.map((step) => (
              <div key={step.number} className="grid gap-5 py-8 sm:grid-cols-[80px_0.7fr_1fr] sm:gap-8">
                <span className="text-sm text-subtle">{step.number}</span>
                <h3 className="text-xl font-medium tracking-[-0.04em]">{step.title}</h3>
                <p className="max-w-sm text-sm leading-6 text-muted">{step.copy}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="principles" className="reveal-section bg-ink text-canvas">
        <div className="mx-auto grid max-w-7xl gap-16 px-6 py-24 lg:grid-cols-[0.8fr_1.2fr] lg:px-10 lg:py-32">
          <div>
            <p className="text-sm text-accent-soft">02 / Principles</p>
            <h2 className="mt-8 max-w-md text-4xl font-medium leading-[1.02] tracking-[-0.065em] sm:text-5xl">Less noise. More intent.</h2>
          </div>
          <div className="grid gap-8 sm:grid-cols-3">
            {principles.map((principle) => (
              <div key={principle} className="border-t border-dark-line pt-5">
                <FiCheck className="mb-8 text-accent-soft" />
                <h3 className="text-lg tracking-[-0.035em]">{principle}</h3>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="start" className="reveal-section mx-auto max-w-7xl px-6 py-24 lg:px-10 lg:py-36">
        <div className="grid items-end gap-12 lg:grid-cols-[1fr_auto]">
          <div>
            <p className="text-sm text-subtle">03 / Start here</p>
            <h2 className="mt-8 max-w-2xl text-5xl font-medium leading-[0.98] tracking-[-0.075em] sm:text-7xl">Make your next move intentional.</h2>
          </div>
          <div className="max-w-xs lg:pb-2">
            <p className="text-sm leading-6 text-muted">Connect a wallet, describe your first guard, and keep the final say on every action.</p>
            <button type="button" className="group mt-7 inline-flex items-center gap-3 border-b border-ink pb-2 text-sm font-medium">
              Enter Dexter
              <FiArrowUpRight className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </button>
          </div>
        </div>
        <div className="mt-24 flex items-center gap-3 border-t border-line pt-6 text-xs text-subtle">
          <FiTerminal />
          Somnia testnet · Built for deliberate trading
        </div>
      </section>
    </main>
  )
}
