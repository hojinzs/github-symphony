import { NextResponse } from "next/server";
import { loadWorkspaceDashboard } from "../../../lib/dashboard-service";
import {
  createOperatorAuthJsonResponse,
  OperatorAuthRequiredError,
  requireOperatorRequestSession
} from "../../../lib/operator-auth-guard";

export async function GET(request: Request) {
  try {
    requireOperatorRequestSession(request);
    const workspaces = await loadWorkspaceDashboard();

    return NextResponse.json({
      workspaces
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
        status: 500
      }
    );
  }
}
