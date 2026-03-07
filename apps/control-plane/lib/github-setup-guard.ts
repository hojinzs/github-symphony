import { loadGitHubIntegrationSummary } from "./github-integration";

export class GitHubSetupRequiredError extends Error {
  constructor(readonly state: string) {
    super(
      `GitHub App bootstrap is ${state}. Complete setup before creating workspaces or issues.`
    );
  }
}

export async function requireReadyGitHubSetup() {
  const summary = await loadGitHubIntegrationSummary();

  if (summary.state !== "ready") {
    throw new GitHubSetupRequiredError(summary.state);
  }

  return summary;
}

export function buildGitHubSetupPath(nextPath: string): string {
  const url = new URL("http://github-symphony.local/setup/github-app");
  url.searchParams.set("next", nextPath);
  return `${url.pathname}${url.search}`;
}
