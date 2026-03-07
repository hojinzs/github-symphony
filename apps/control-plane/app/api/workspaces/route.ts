import { NextResponse } from "next/server";
import { db } from "../../../lib/db";
import {
  parseCreateWorkspaceInput
} from "../../../lib/workspace-service";
import {
  GitHubSetupRequiredError,
  requireReadyGitHubSetup
} from "../../../lib/github-setup-guard";
import { provisionWorkspace } from "../../../lib/workspace-orchestrator";

export async function GET() {
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
}

export async function POST(request: Request) {
  try {
    await requireReadyGitHubSetup();
    const body = await request.json();
    const input = parseCreateWorkspaceInput(body);
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
