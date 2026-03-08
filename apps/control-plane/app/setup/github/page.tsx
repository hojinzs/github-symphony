import { loadGitHubIntegrationSummary } from "../../../lib/github-integration";
import { requireOperatorPageSession } from "../../../lib/operator-auth-guard";

type SetupPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function GitHubSetupPage({ searchParams }: SetupPageProps) {
  const emptySearchParams: Record<string, string | string[] | undefined> = {};
  await requireOperatorPageSession("/setup/github");
  const [summary, resolvedSearchParams] = await Promise.all([
    loadGitHubIntegrationSummary(),
    searchParams ?? Promise.resolve(emptySearchParams)
  ]);
  const error = readSearchParam(resolvedSearchParams.error);
  const status = readSearchParam(resolvedSearchParams.status);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 px-6 py-10 lg:px-10">
      <header className="space-y-4">
        <p className="text-sm uppercase tracking-[0.3em] text-signal">First-run setup</p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-5xl text-ink">
            Connect GitHub with a machine-user PAT.
          </h1>
          <span className="rounded-full bg-mist px-4 py-2 text-xs uppercase tracking-[0.2em] text-ink/70">
            {summary.state}
          </span>
        </div>
        <p className="max-w-3xl text-lg leading-8 text-ink/70">
          GitHub Symphony uses one organization-backed machine-user PAT for repository
          discovery, workspace provisioning, issue creation, and runtime GitHub access.
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

      {summary.integration?.degradedReason ? (
        <section className="rounded-[28px] border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
          {summary.integration.degradedReason}
        </section>
      ) : null}

      <section className="grid gap-6 rounded-[32px] border border-black/10 bg-white/80 p-8 shadow-[0_30px_120px_rgba(13,20,28,0.08)] lg:grid-cols-[1.2fr,0.8fr]">
        <div className="space-y-3">
          <div className="space-y-3">
            <h2 className="font-display text-3xl text-ink">Machine-user PAT</h2>
            <p className="text-sm leading-7 text-ink/65">
              Use a dedicated machine user and the organization that owns the repositories and
              GitHub Projects for this instance. Setup validates actor access, repository
              inventory, and Project capability before unlocking provisioning.
            </p>
          </div>

          <form
            action="/api/setup/github"
            className="grid gap-4 rounded-[28px] border border-black/10 bg-mist/60 p-5"
            method="post"
          >
            <label className="grid gap-2">
              <span className="text-xs uppercase tracking-[0.2em] text-ink/55">
                Machine-user PAT
              </span>
              <input
                className="rounded-2xl border border-black/10 px-4 py-3"
                name="token"
                placeholder="ghp_..."
                required
                type="password"
              />
            </label>

            <label className="grid gap-2">
              <span className="text-xs uppercase tracking-[0.2em] text-ink/55">
                Organization owner
              </span>
              <input
                className="rounded-2xl border border-black/10 px-4 py-3"
                defaultValue={summary.integration?.patValidatedOwnerLogin ?? ""}
                name="ownerLogin"
                placeholder="acme"
                required
              />
            </label>

            <div className="rounded-2xl border border-black/10 bg-white/80 p-4 text-sm leading-7 text-ink/65">
              Required GitHub classic PAT scopes: <code>repo</code>, <code>read:org</code>,{" "}
              <code>project</code>.
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                className="rounded-full bg-ink px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white"
                type="submit"
              >
                {summary.integration?.hasPatToken ? "Replace PAT" : "Save PAT"}
              </button>
              <span className="rounded-full border border-black/10 bg-white px-4 py-3 text-xs uppercase tracking-[0.2em] text-ink/55">
                Supported path
              </span>
            </div>
          </form>
        </div>

        <div className="grid gap-4 content-start">
          <article className="rounded-[24px] border border-black/10 bg-mist/60 p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-display text-2xl text-ink">Current integration</h2>
              <span className="rounded-full bg-white px-3 py-1 text-xs uppercase tracking-[0.2em] text-ink/65">
                PAT only
              </span>
            </div>
            <dl className="mt-4 grid gap-3 text-sm text-ink/70">
              <div>
                <dt className="uppercase tracking-[0.18em] text-ink/45">State</dt>
                <dd className="mt-1 text-base text-ink">{summary.state}</dd>
              </div>
              <div>
                <dt className="uppercase tracking-[0.18em] text-ink/45">Actor</dt>
                <dd className="mt-1 text-base text-ink">
                  {summary.integration?.patActorLogin ?? "Not validated yet"}
                </dd>
              </div>
              <div>
                <dt className="uppercase tracking-[0.18em] text-ink/45">Validated owner</dt>
                <dd className="mt-1 text-base text-ink">
                  {summary.integration?.patValidatedOwnerLogin ?? "Not configured yet"}
                </dd>
              </div>
              <div>
                <dt className="uppercase tracking-[0.18em] text-ink/45">Stored secret</dt>
                <dd className="mt-1 text-base text-ink">
                  {summary.integration?.hasPatToken
                    ? summary.integration.patTokenFingerprint
                    : "No PAT stored yet"}
                </dd>
              </div>
              <div>
                <dt className="uppercase tracking-[0.18em] text-ink/45">Last validated</dt>
                <dd className="mt-1 text-base text-ink">
                  {summary.integration?.lastValidatedAt?.toISOString() ?? "Not validated yet"}
                </dd>
              </div>
            </dl>
          </article>

          {summary.missingFields.length > 0 ? (
            <article className="rounded-[24px] border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
              Missing ready-state fields: {summary.missingFields.join(", ")}
            </article>
          ) : null}

          <article className="rounded-[24px] border border-black/10 bg-white/75 p-5 shadow-[0_20px_60px_rgba(13,20,28,0.06)]">
            <h2 className="font-display text-2xl text-ink">Recovery</h2>
            <p className="mt-4 text-sm leading-7 text-ink/65">
              If the PAT is revoked, expires, or loses organization Project access, replace it on
              this page. Existing workspace metadata stays intact.
            </p>
          </article>
        </div>
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
