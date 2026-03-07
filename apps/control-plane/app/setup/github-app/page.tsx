import {
  buildGitHubAppInstallUrl
} from "../../../lib/github-app-api";
import { loadGitHubIntegrationSummary } from "../../../lib/github-integration";

type SetupPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function GitHubAppSetupPage({
  searchParams
}: SetupPageProps) {
  const emptySearchParams: Record<string, string | string[] | undefined> = {};
  const [summary, resolvedSearchParams] = await Promise.all([
    loadGitHubIntegrationSummary(),
    searchParams ?? Promise.resolve(emptySearchParams)
  ]);
  const error = readSearchParam(resolvedSearchParams.error);
  const status = readSearchParam(resolvedSearchParams.status);
  const installUrl = summary.integration?.appSlug
    ? buildGitHubAppInstallUrl(summary.integration.appSlug)
    : null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 px-6 py-10 lg:px-10">
      <header className="space-y-4">
        <p className="text-sm uppercase tracking-[0.3em] text-signal">First-run setup</p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-5xl text-ink">Connect GitHub before provisioning workspaces.</h1>
          <span className="rounded-full bg-mist px-4 py-2 text-xs uppercase tracking-[0.2em] text-ink/70">
            {summary.state}
          </span>
        </div>
        <p className="max-w-3xl text-lg leading-8 text-ink/70">
          GitHub Symphony stores one system GitHub App configuration for the instance. Complete
          the app registration and installation flow here, then workspace and issue creation will
          unlock automatically.
        </p>
      </header>

      {error ? (
        <section className="rounded-[28px] border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          {error}
        </section>
      ) : null}

      {status ? (
        <section className="rounded-[28px] border border-emerald-200 bg-emerald-50 p-6 text-sm text-emerald-700">
          {status}
        </section>
      ) : null}

      <section className="grid gap-6 rounded-[32px] border border-black/10 bg-white/80 p-8 shadow-[0_30px_120px_rgba(13,20,28,0.08)]">
        <div className="space-y-3">
          <h2 className="font-display text-3xl text-ink">Current integration state</h2>
          <p className="text-sm leading-7 text-ink/65">
            {summary.state === "ready"
              ? "The control plane can mint installation credentials and provision new work."
              : summary.state === "degraded"
                ? "GitHub credentials are stored, but the installation needs recovery before new work can continue."
                : summary.state === "pending"
                  ? "GitHub App registration started but installation has not completed yet."
                  : "No GitHub App has been configured for this instance yet."}
          </p>
        </div>

        <dl className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-black/10 bg-mist/60 p-4">
            <dt className="text-xs uppercase tracking-[0.2em] text-ink/50">App</dt>
            <dd className="mt-2 text-lg text-ink">
              {summary.integration?.appName ?? "Not registered yet"}
            </dd>
          </div>
          <div className="rounded-2xl border border-black/10 bg-mist/60 p-4">
            <dt className="text-xs uppercase tracking-[0.2em] text-ink/50">Installation target</dt>
            <dd className="mt-2 text-lg text-ink">
              {summary.integration?.installationTargetLogin ?? "Not installed yet"}
            </dd>
          </div>
          <div className="rounded-2xl border border-black/10 bg-mist/60 p-4">
            <dt className="text-xs uppercase tracking-[0.2em] text-ink/50">Stored secrets</dt>
            <dd className="mt-2 text-lg text-ink">
              {summary.integration?.hasClientSecret || summary.integration?.hasPrivateKey
                ? "Encrypted in the config database"
                : "No GitHub secrets stored yet"}
            </dd>
          </div>
          <div className="rounded-2xl border border-black/10 bg-mist/60 p-4">
            <dt className="text-xs uppercase tracking-[0.2em] text-ink/50">Latest setup attempt</dt>
            <dd className="mt-2 text-lg text-ink">
              {summary.latestBootstrapAttempt
                ? summary.latestBootstrapAttempt.isExpired
                  ? "Expired"
                  : summary.latestBootstrapAttempt.status
                : "No attempt recorded"}
            </dd>
          </div>
        </dl>

        {summary.missingFields.length > 0 ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            Missing ready-state fields: {summary.missingFields.join(", ")}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <a
            className="rounded-full bg-ink px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white"
            href="/api/setup/github-app/start"
          >
            {summary.state === "unconfigured" ? "Start setup" : "Run setup again"}
          </a>
          {installUrl ? (
            <a
              className="rounded-full border border-black/10 bg-white px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-ink"
              href={installUrl}
            >
              Reconnect installation
            </a>
          ) : null}
          <form action="/api/setup/github-app/retry" method="post">
            <button
              className="rounded-full border border-black/10 bg-white px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-ink"
              type="submit"
            >
              Clear stale setup state
            </button>
          </form>
        </div>
      </section>

      <section className="grid gap-5 md:grid-cols-3">
        <article className="rounded-[24px] border border-black/10 bg-white/75 p-6 shadow-[0_20px_60px_rgba(13,20,28,0.06)]">
          <h2 className="font-display text-2xl text-ink">1. Register the app</h2>
          <p className="mt-4 text-sm leading-7 text-ink/65">
            Start the manifest flow from this page. GitHub will create the app and return the
            client credentials and private key to the control plane.
          </p>
        </article>
        <article className="rounded-[24px] border border-black/10 bg-white/75 p-6 shadow-[0_20px_60px_rgba(13,20,28,0.06)]">
          <h2 className="font-display text-2xl text-ink">2. Install it</h2>
          <p className="mt-4 text-sm leading-7 text-ink/65">
            Install the GitHub App into the owner that should host Symphony work. The control
            plane validates the installation before it opens workspace provisioning.
          </p>
        </article>
        <article className="rounded-[24px] border border-black/10 bg-white/75 p-6 shadow-[0_20px_60px_rgba(13,20,28,0.06)]">
          <h2 className="font-display text-2xl text-ink">3. Recover if needed</h2>
          <p className="mt-4 text-sm leading-7 text-ink/65">
            If installation access is revoked later, this screen becomes the recovery path for
            reconnecting or restarting bootstrap without wiping existing workspaces.
          </p>
        </article>
      </section>

      {summary.state === "ready" ? (
        <section className="flex flex-wrap gap-3">
          <a
            className="rounded-full bg-ink px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white"
            href="/workspaces/new"
          >
            Create workspace
          </a>
          <a
            className="rounded-full border border-black/10 bg-white px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-ink"
            href="/issues/new"
          >
            Create issue
          </a>
        </section>
      ) : null}
    </main>
  );
}

function readSearchParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}
