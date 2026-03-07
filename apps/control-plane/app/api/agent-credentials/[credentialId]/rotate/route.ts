import { NextResponse } from "next/server";
import {
  AgentCredentialError,
  parseRotateAgentCredentialInput,
  rotateAgentCredential
} from "../../../../../lib/agent-credentials";

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
    const { credentialId } = await params;
    const body = await request.json();
    const credential = await rotateAgentCredential(
      parseRotateAgentCredentialInput(credentialId, body)
    );

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
