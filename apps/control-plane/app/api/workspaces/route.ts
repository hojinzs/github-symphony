import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import {
  createWorkspaceInputFromSubmission,
  parseCreateWorkspaceSubmission
} from "../../../lib/workspace-service";
import {
  resolveGitHubInstallationRepositorySelection
} from "../../../lib/github-installation-repositories";
import {
  GitHubSetupRequiredError,
  requireReadyGitHubSetup
} from "../../../lib/github-setup-guard";
import {
  createOperatorAuthJsonResponse,
  OperatorAuthRequiredError,
  requireOperatorRequestSession
} from "../../../lib/operator-auth-guard";
import { provisionWorkspace } from "../../../lib/workspace-orchestrator";

export async function GET(request: Request) {
  try {
    requireOperatorRequestSession(request);
    const workspaces = await db.workspace.findMany({
      include: {
        repositories: true,
        symphonyInstance: true
      },
      orderBy: {
        createdAt: "desc"
      }
    });

    return NextResponse.json({
      workspaces
    });
  } catch (error) {
    if (error instanceof OperatorAuthRequiredError) {
      return createOperatorAuthJsonResponse(error);
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error"
      },
      {
        status: 500
      }
    );
  }
}

export async function POST(request: Request) {
  try {
    requireOperatorRequestSession(request);
    await requireReadyGitHubSetup();
    const body = await request.json();
    const submission = parseCreateWorkspaceSubmission(body);
    const repositories = await resolveGitHubInstallationRepositorySelection(
      submission.repositoryIds
    );
    const input = createWorkspaceInputFromSubmission(submission, repositories);
    const { workspace, project, runtime } = await provisionWorkspace(input);

    return NextResponse.json(
      {
        workspace,
        project,
        runtime
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
