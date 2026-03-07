import { NextResponse } from "next/server";
import {
  AgentCredentialError,
  setPlatformDefaultAgentCredential
} from "../../../../lib/agent-credentials";

export async function POST(request: Request) {
  try {
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
