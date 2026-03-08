import { NextResponse } from "next/server";
import {
  AgentCredentialError,
  setPlatformDefaultAgentCredential
} from "../../../../lib/agent-credentials";
import {
  createOperatorAuthJsonResponse,
  OperatorAuthRequiredError,
  requireOperatorRequestSession
} from "../../../../lib/operator-auth-guard";

export async function POST(request: Request) {
  try {
    requireOperatorRequestSession(request);
    const body = (await request.json()) as {
      credentialId?: string;
    };

    if (typeof body.credentialId !== "string" || body.credentialId.trim().length === 0) {
      throw new AgentCredentialError("credentialId must be a non-empty string.");
    }

    const credential = await setPlatformDefaultAgentCredential(body.credentialId.trim());

    return NextResponse.json({
      credential
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
        status: error instanceof AgentCredentialError ? 400 : 500
      }
    );
  }
}
