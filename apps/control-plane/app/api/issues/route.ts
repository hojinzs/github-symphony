import { NextResponse } from "next/server";
import {
  createIssueForWorkspace,
  parseCreateIssueInput
} from "../../../lib/issue-service";
import {
  GitHubSetupRequiredError,
  requireReadyGitHubSetup
} from "../../../lib/github-setup-guard";
import {
  createOperatorAuthJsonResponse,
  OperatorAuthRequiredError,
  requireOperatorRequestSession
} from "../../../lib/operator-auth-guard";

export async function POST(request: Request) {
  try {
    requireOperatorRequestSession(request);
    await requireReadyGitHubSetup();
    const body = await request.json();
    const input = parseCreateIssueInput(body);
    const issue = await createIssueForWorkspace(input);

    return NextResponse.json(
      {
        issue
      },
      {
        status: 201
      }
    );
  } catch (error: unknown) {
    if (error instanceof OperatorAuthRequiredError) {
      return createOperatorAuthJsonResponse(error);
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      error instanceof GitHubSetupRequiredError
        ? 412
        : 400;

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
