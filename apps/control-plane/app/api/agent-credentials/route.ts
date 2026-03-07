import { NextResponse } from "next/server";
import {
  AgentCredentialError,
  createAgentCredential,
  listAgentCredentials,
  parseCreateAgentCredentialInput
} from "../../../lib/agent-credentials";

export async function GET() {
  const payload = await listAgentCredentials();
  return NextResponse.json(payload);
}

export async function POST(request: Request) {
  try {
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
