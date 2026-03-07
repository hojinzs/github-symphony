import { NextResponse } from "next/server";
import {
  AgentCredentialError,
  parseCreateAgentCredentialInput,
  validateAgentCredential
} from "../../../../lib/agent-credentials";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const input = parseCreateAgentCredentialInput(body);
    const result = await validateAgentCredential({
      provider: input.provider,
      apiKey: input.apiKey
    });

    return NextResponse.json(result);
  } catch (error) {
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
