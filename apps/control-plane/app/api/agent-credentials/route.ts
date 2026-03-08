import { NextResponse } from "next/server";
import {
  AgentCredentialError,
  createAgentCredential,
  listAgentCredentials,
  parseCreateAgentCredentialInput
} from "../../../lib/agent-credentials";
import {
  createOperatorAuthJsonResponse,
  OperatorAuthRequiredError,
  requireOperatorRequestSession
} from "../../../lib/operator-auth-guard";

export async function GET(request: Request) {
  try {
    requireOperatorRequestSession(request);
    const payload = await listAgentCredentials();
    return NextResponse.json(payload);
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
    const body = await request.json();
    const credential = await createAgentCredential(
      parseCreateAgentCredentialInput(body)
    );

    return NextResponse.json(
      {
        credential
      },
      {
        status: 201
      }
    );
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
