import { loadGitHubIntegrationSummary } from "../lib/github-integration";

const previewItems = [
  {
    title: "Workspace provisioning",
    description: "Create a GitHub-backed workspace with prompt guardrails and repository allowlists."
  },
  {
    title: "Runtime isolation",
    description: "Map each workspace to a dedicated Symphony worker container and GitHub Project."
  },
  {
    title: "Agent observability",
    description: "Aggregate worker state from runtime endpoints into one operator dashboard."
  }
];

const previewStatuses = {
  provisioning: "Provisioning",
  idle: "Idle",
  running: "Running",
  degraded: "Needs attention"
} as const;

export default async function HomePage() {
  const summary = await loadGitHubIntegrationSummary();
  const primaryAction =
    summary.state === "ready"
      ? {
          href: "/workspaces/new",
          label: "Create workspace"
        }
      : {
          href: "/setup/github",
          label: "Connect GitHub"
        };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-12 px-6 py-10 lg:px-10">
      <section className="grid gap-8 rounded-[32px] border border-black/10 bg-white/80 p-8 shadow-[0_30px_120px_rgba(13,20,28,0.08)] backdrop-blur lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-6">
          <p className="text-sm uppercase tracking-[0.3em] text-signal">GitHub Symphony</p>
          <div className="space-y-4">
            <h1 className="max-w-3xl font-display text-5xl leading-tight text-ink">
              Multi-tenant orchestration for autonomous coding workspaces.
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-ink/70">
              This bootstrap shell establishes the control plane that will create GitHub Projects,
              provision isolated Symphony workers, and surface workspace health from runtime state.
            </p>
          </div>
        </div>
        <div className="rounded-[28px] bg-ink p-6 text-mist">
          <p className="text-sm uppercase tracking-[0.3em] text-tide">Preview statuses</p>
          <div className="mt-6 space-y-4">
            {Object.entries(previewStatuses).map(([status, label]) => (
              <div
                key={status}
                className="flex items-center justify-between rounded-2xl border border-white/10 px-4 py-3"
              >
                <span className="font-mono text-sm text-white/55">{status}</span>
                <span className="rounded-full bg-white/10 px-3 py-1 text-sm">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-4 rounded-[28px] border border-black/10 bg-white/70 p-6 md:grid-cols-3">
        <a className="rounded-[20px] bg-ink px-5 py-4 text-sm uppercase tracking-[0.2em] text-white" href={primaryAction.href}>
          {primaryAction.label}
        </a>
        <a className="rounded-[20px] bg-white px-5 py-4 text-sm uppercase tracking-[0.2em] text-ink shadow-[inset_0_0_0_1px_rgba(13,20,28,0.12)]" href="/issues/new">
          Create issue
        </a>
        <a className="rounded-[20px] bg-white px-5 py-4 text-sm uppercase tracking-[0.2em] text-ink shadow-[inset_0_0_0_1px_rgba(13,20,28,0.12)]" href="/dashboard">
          View dashboard
        </a>
      </section>

      <section className="grid gap-5 md:grid-cols-3">
        {previewItems.map((item) => (
          <article
            key={item.title}
            className="rounded-[24px] border border-black/10 bg-white/75 p-6 shadow-[0_20px_60px_rgba(13,20,28,0.06)]"
          >
            <h2 className="font-display text-2xl text-ink">{item.title}</h2>
            <p className="mt-4 text-base leading-7 text-ink/70">{item.description}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
