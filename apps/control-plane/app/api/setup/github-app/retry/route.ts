import { NextResponse } from "next/server";
import { resetGitHubBootstrapState } from "../../../../../lib/github-integration";

export async function POST(request: Request) {
  await resetGitHubBootstrapState();

  const url = new URL("/setup/github-app", request.url);
  url.searchParams.set("status", "GitHub App setup was reset. Start the flow again.");

  return NextResponse.redirect(url, 303);
}
