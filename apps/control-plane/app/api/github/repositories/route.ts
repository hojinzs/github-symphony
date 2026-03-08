import { NextResponse } from "next/server";
import {
  listGitHubInstallationRepositories
} from "../../../../lib/github-installation-repositories";
import {
  GitHubSetupRequiredError,
  requireReadyGitHubSetup
} from "../../../../lib/github-setup-guard";
import {
  createOperatorAuthJsonResponse,
  OperatorAuthRequiredError,
  requireOperatorRequestSession
} from "../../../../lib/operator-auth-guard";

export async function GET(request: Request) {
  try {
    requireOperatorRequestSession(request);
    await requireReadyGitHubSetup();
    const repositories = await listGitHubInstallationRepositories();

    return NextResponse.json({
      repositories
    });
  } catch (error: unknown) {
    if (error instanceof OperatorAuthRequiredError) {
      return createOperatorAuthJsonResponse(error);
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      error instanceof GitHubSetupRequiredError
        ? 412
        : 503;

    return NextResponse.json(
      {
        error: message
      },
      {
        status
      }
    );
  }
}
