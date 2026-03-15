import { redirect } from "next/navigation";
import { loadGitHubIntegrationSummary } from "../../../lib/github-integration";
import { buildGitHubSetupPath } from "../../../lib/github-setup-guard";
import { requireOperatorPageSession } from "../../../lib/operator-auth-guard";
import { IssueCreateForm } from "./issue-create-form";

export const dynamic = "force-dynamic";

export default async function NewIssuePage() {
  await requireOperatorPageSession("/issues/new");
  const summary = await loadGitHubIntegrationSummary();

  if (summary.state !== "ready") {
    redirect(buildGitHubSetupPath("/issues/new"));
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 px-6 py-10 lg:px-10">
      <header className="space-y-4">
        <p className="text-sm uppercase tracking-[0.3em] text-signal">Issue intake</p>
        <h1 className="font-display text-5xl text-ink">Send a task to a workspace.</h1>
        <p className="max-w-3xl text-lg leading-8 text-ink/70">
          Select a provisioned workspace, target one of its allowed repositories, and create the
          GitHub issue that Symphony will pick up.
        </p>
      </header>
      <IssueCreateForm />
    </main>
  );
}
