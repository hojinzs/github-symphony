import { NextResponse } from "next/server";
import {
  AgentCredentialError
} from "../../../../../lib/agent-credentials";
import {
  extractRuntimeAuthorizationSecret,
  verifyWorkspaceRuntimeAuthSecret,
  WorkspaceRuntimeAuthError
} from "../../../../../lib/runtime-broker-auth";
import { issueWorkspaceAgentCredentials } from "../../../../../lib/runtime-agent-credentials";

type AgentCredentialRouteProps = {
  params: Promise<{
    workspaceId: string;
  }>;
};

export async function POST(
  request: Request,
  { params }: AgentCredentialRouteProps
) {
  const { workspaceId } = await params;

  try {
    const secret = extractRuntimeAuthorizationSecret(request);

    if (!verifyWorkspaceRuntimeAuthSecret(workspaceId, secret)) {
      throw new WorkspaceRuntimeAuthError("Workspace runtime authentication failed.");
    }

    const credentials = await issueWorkspaceAgentCredentials(workspaceId);

    return NextResponse.json(credentials);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      error instanceof WorkspaceRuntimeAuthError
        ? 401
        : error instanceof AgentCredentialError
          ? 503
          : 500;

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
