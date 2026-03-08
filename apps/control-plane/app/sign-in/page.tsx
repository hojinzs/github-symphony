import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  getOperatorAuthReadiness,
  getOperatorSessionCookieName,
  normalizeOperatorNextPath,
  parseOperatorSessionCookie
} from "../../lib/operator-auth";

type SignInPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const emptySearchParams: Record<string, string | string[] | undefined> = {};
  const [cookieStore, resolvedSearchParams] = await Promise.all([
    cookies(),
    searchParams ?? Promise.resolve(emptySearchParams)
  ]);
  const nextPath = normalizeOperatorNextPath(readSearchParam(resolvedSearchParams.next));
  const session = parseOperatorSessionCookie(
    cookieStore.get(getOperatorSessionCookieName())?.value ?? null
  );

  if (session) {
    redirect(nextPath);
  }

  const error = readSearchParam(resolvedSearchParams.error);
  const readiness = getOperatorAuthReadiness();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center gap-8 px-6 py-10 lg:px-10">
      <section className="rounded-[32px] border border-black/10 bg-white/85 p-8 shadow-[0_30px_120px_rgba(13,20,28,0.08)]">
        <p className="text-sm uppercase tracking-[0.3em] text-signal">Trusted operator access</p>
        <h1 className="mt-4 font-display text-5xl leading-tight text-ink">
          Sign in with GitHub before using the control plane.
        </h1>
        <p className="mt-4 text-lg leading-8 text-ink/70">
          GitHub Symphony allows only configured operator accounts to continue into setup,
          workspace creation, issue submission, and credential management.
        </p>

        {error ? (
          <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {readiness.isConfigured ? (
          <div className="mt-8 space-y-4">
            <p className="text-sm leading-7 text-ink/65">
              {readiness.allowedLogins.length > 0
                ? `Allowed GitHub logins: ${readiness.allowedLogins.join(", ")}`
                : "No login allowlist is configured. Any GitHub account that completes sign-in can operate this control plane."}
            </p>
            <a
              className="inline-flex rounded-full bg-ink px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white"
              href={`/api/auth/github/start?next=${encodeURIComponent(nextPath)}`}
            >
              Sign in with GitHub
            </a>
          </div>
        ) : (
          <div className="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-7 text-amber-800">
            {readiness.error}
          </div>
        )}
      </section>
    </main>
  );
}

function readSearchParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}
