import { randomBytes } from "node:crypto";
import { GitHubIntegrationStatus } from "@prisma/client";
import {
  buildGitHubAppManifest,
  buildGitHubManifestStartHtml
} from "../../../../../lib/github-app-api";
import { resolveControlPlaneBaseUrl } from "../../../../../lib/control-plane-url";
import {
  createGitHubBootstrapAttempt,
  saveGitHubIntegration
} from "../../../../../lib/github-integration";

const BOOTSTRAP_ATTEMPT_TTL_MS = 15 * 60 * 1000;

export async function GET(request: Request) {
  const stateToken = randomBytes(24).toString("base64url");
  const baseUrl = resolveControlPlaneBaseUrl(request);
  const manifest = buildGitHubAppManifest(baseUrl);
  const integration = await saveGitHubIntegration({
    status: GitHubIntegrationStatus.pending,
    degradedReason: null
  });

  await createGitHubBootstrapAttempt({
    integrationId: integration.id,
    stateToken,
    manifest,
    manifestUrl: baseUrl,
    githubAppName: manifest.name,
    expiresAt: new Date(Date.now() + BOOTSTRAP_ATTEMPT_TTL_MS)
  });

  return new Response(
    buildGitHubManifestStartHtml({
      state: stateToken,
      manifest
    }),
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8"
      }
    }
  );
}
