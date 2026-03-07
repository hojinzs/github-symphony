import { NextResponse } from "next/server";
import { loadWorkspaceDashboard } from "../../../lib/dashboard-service";

export async function GET() {
  const workspaces = await loadWorkspaceDashboard();

  return NextResponse.json({
    workspaces
  });
}
