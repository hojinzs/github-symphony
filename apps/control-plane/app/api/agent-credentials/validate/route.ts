import { NextResponse } from "next/server";
import {
  AgentCredentialError,
  parseCreateAgentCredentialInput,
  validateAgentCredential
} from "../../../../lib/agent-credentials";
import {
  createOperatorAuthJsonResponse,
  OperatorAuthRequiredError,
  requireOperatorRequestSession
} from "../../../../lib/operator-auth-guard";

export async function POST(request: Request) {
  try {
    requireOperatorRequestSession(request);
    const body = await request.json();
    const input = parseCreateAgentCredentialInput(body);
    const result = await validateAgentCredential({
      provider: input.provider,
      apiKey: input.apiKey
    });

    return NextResponse.json(result);
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
