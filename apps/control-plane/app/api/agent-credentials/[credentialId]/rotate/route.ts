import { NextResponse } from "next/server";
import {
  AgentCredentialError,
  parseRotateAgentCredentialInput,
  rotateAgentCredential
} from "../../../../../lib/agent-credentials";
import {
  createOperatorAuthJsonResponse,
  OperatorAuthRequiredError,
  requireOperatorRequestSession
} from "../../../../../lib/operator-auth-guard";

type RotateCredentialRouteProps = {
  params: Promise<{
    credentialId: string;
  }>;
};

export async function POST(
  request: Request,
  { params }: RotateCredentialRouteProps
) {
  try {
    requireOperatorRequestSession(request);
    const { credentialId } = await params;
    const body = await request.json();
    const credential = await rotateAgentCredential(
      parseRotateAgentCredentialInput(credentialId, body)
    );

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
