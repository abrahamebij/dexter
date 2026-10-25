import { useEffect, useState } from "react";
import { Link } from "react-router";
import { FiArrowUpRight } from "react-icons/fi";
import { useAccount } from "wagmi";
import { api, resolveOwner, ruleText, type Guard } from "../lib/api";

export default function Dashboard() {
  const { address } = useAccount();
  const [guards, setGuards] = useState<Guard[]>([]);
  const [positions, setPositions] = useState(0);
  const activeGuards = guards.filter((guard) => guard.status === "active");
  useEffect(() => {
    if (!address) return;
    const load = () => {
      api<Guard[]>(`/api/guards?owner=${resolveOwner(address)}`)
        .then(setGuards)
        .catch(() => undefined);
      api<{ positions: unknown[] }>(
        `/api/positions?owner=${resolveOwner(address)}`,
      )
        .then((value) => setPositions(value.positions.length))
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 5_000);
    return () => window.clearInterval(timer);
  }, [address]);
  return (
    <div className="space-y-10">
      <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm text-subtle">Overview</p>
          <h1 className="mt-3 text-4xl font-medium tracking-[-0.06em]">
            Your risk, clearly shown.
          </h1>
        </div>
        <Link
          to="/app/guards/new"
          className="inline-flex w-fit items-center gap-2 rounded-full bg-ink px-5 py-3 text-sm font-medium text-canvas"
        >
          Create guard <FiArrowUpRight />
        </Link>
      </header>
      <div className="grid gap-4 md:grid-cols-3">
        {[
          ["Open positions", String(positions)],
          [
            "Active guards",
            String(activeGuards.length),
          ],
          ["Dry-run behavior", "Simulation only"],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-2xl border border-line bg-panel p-6"
          >
            <p className="text-sm text-muted">{label}</p>
            <p className="mt-5 text-3xl font-medium tracking-[-0.05em]">
              {value}
            </p>
          </div>
        ))}
      </div>
      <section className="rounded-2xl border border-line p-6 sm:p-8">
        <p className="text-sm text-subtle">Your guards</p>
        {guards.length === 0 ? (
          <p className="mt-5 text-sm text-muted">No guards yet.</p>
        ) : (
          <div className="mt-5 space-y-4">
            {guards.map((guard) => {
              const isRunning =
                guard.status === "active" || guard.status === "executing";
              const statusLabel =
                guard.status === "active"
                  ? "Monitoring"
                  : guard.status === "executing"
                    ? "Executing"
                    : guard.status === "paused"
                      ? "Paused"
                      : "Fired";
              return (
                <Link
                  key={guard.id}
                  to={`/app/guards/${guard.id}`}
                  className="block border-b border-line pb-4 last:border-0"
                >
                  <div className="flex items-center justify-between gap-4">
                    <p className="font-medium">{guard.market}</p>
                    <span className="inline-flex shrink-0 items-center gap-2 text-xs text-muted">
                      {isRunning && (
                        <span
                          aria-hidden="true"
                          className="h-2 w-2 animate-pulse rounded-full bg-accent"
                        />
                      )}
                      {statusLabel}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted">{ruleText(guard)}</p>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
