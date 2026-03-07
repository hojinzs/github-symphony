import { redirect } from "next/navigation";
import { loadGitHubIntegrationSummary } from "../../../lib/github-integration";
import { buildGitHubSetupPath } from "../../../lib/github-setup-guard";
import { WorkspaceCreateForm } from "./workspace-create-form";

export default async function NewWorkspacePage() {
  const summary = await loadGitHubIntegrationSummary();

  if (summary.state !== "ready") {
    redirect(buildGitHubSetupPath("/workspaces/new"));
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 px-6 py-10 lg:px-10">
      <header className="space-y-4">
        <p className="text-sm uppercase tracking-[0.3em] text-signal">Workspace setup</p>
        <h1 className="font-display text-5xl text-ink">Create a new Symphony workspace.</h1>
        <p className="max-w-3xl text-lg leading-8 text-ink/70">
          Define prompt guardrails and register the repositories this workspace is allowed to
          touch. The control plane uses the stored GitHub App installation automatically.
        </p>
      </header>
      <WorkspaceCreateForm />
    </main>
  );
}
