import { DashboardClient } from "./workspace-dashboard";

export default function DashboardPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-10 lg:px-10">
      <header className="space-y-4">
        <p className="text-sm uppercase tracking-[0.3em] text-signal">Observability</p>
        <h1 className="font-display text-5xl text-ink">Track every active workspace.</h1>
        <p className="max-w-3xl text-lg leading-8 text-ink/70">
          The dashboard polls worker state endpoints in parallel and merges them with control-plane
          metadata so operators can see where automation is healthy or degraded.
        </p>
      </header>
      <DashboardClient />
    </main>
  );
}
