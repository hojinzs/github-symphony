import { GitHubIntegrationStatus } from "@prisma/client";
import { db } from "./db";
import {
  GitHubIntegrationStateError,
  loadConfiguredGitHubPatCredentials,
  loadGitHubIntegrationSummary,
  markGitHubIntegrationDegraded,
  saveGitHubIntegration
} from "./github-integration";
import {
  loadGitHubSecretProtectorFromEnv,
  type GitHubSecretProtector
} from "./github-integration-secrets";
import {
  GitHubPatValidationError,
  validateGitHubPat
} from "./github-pat-api";

const PAT_REVALIDATION_WINDOW_MS = 15 * 60 * 1000;

type DatabaseLike = Pick<typeof db, "gitHubIntegration">;

export type GitHubProjectCredentials = {
  token: string;
  expiresAt: Date;
  installationId: null;
  ownerLogin: string;
  ownerType: string;
  provider: "pat_classic";
  source: "pat";
  actorLogin: string;
  tokenFingerprint: string;
};

export async function getProjectGitHubCredentials(
  dependencies: {
    db?: DatabaseLike;
    fetchImpl?: typeof fetch;
    secretProtector?: GitHubSecretProtector;
  } = {}
): Promise<GitHubProjectCredentials> {
  const database = dependencies.db ?? db;
  const secretProtector =
    dependencies.secretProtector ?? loadGitHubSecretProtectorFromEnv();
  const summary = await loadGitHubIntegrationSummary(database);

  if (summary.state !== "ready") {
    throw new GitHubIntegrationStateError(
      summary.state,
      summary.integration?.degradedReason ??
        `GitHub integration is ${summary.state}; setup must complete before GitHub operations can continue.`
    );
  }

  const pat = await loadConfiguredGitHubPatCredentials(database, secretProtector);

  try {
    const validated = await validateGitHubPat(
      {
        token: pat.token,
        ownerLogin: pat.validatedOwnerLogin
      },
      dependencies.fetchImpl
    );

    const shouldPersistValidation =
      !pat.lastValidatedAt ||
      Date.now() - pat.lastValidatedAt.getTime() > PAT_REVALIDATION_WINDOW_MS;

    if (shouldPersistValidation) {
      await saveGitHubIntegration(
        {
          status: GitHubIntegrationStatus.ready,
          patActorId: validated.actorId,
          patActorLogin: validated.actorLogin,
          patValidatedOwnerId: validated.validatedOwnerId,
          patValidatedOwnerLogin: validated.validatedOwnerLogin,
          patValidatedOwnerType: validated.validatedOwnerType,
          patValidatedOwnerUrl: validated.validatedOwnerUrl,
          lastValidatedAt: new Date(),
          degradedReason: null
        },
        database
      );
    }

    return {
      token: pat.token,
      expiresAt: new Date(Date.now() + PAT_REVALIDATION_WINDOW_MS),
      installationId: null,
      ownerLogin: pat.validatedOwnerLogin,
      ownerType: pat.validatedOwnerType,
      provider: "pat_classic",
      source: "pat",
      actorLogin: pat.actorLogin,
      tokenFingerprint: pat.tokenFingerprint
    };
  } catch (error) {
    if (error instanceof GitHubPatValidationError) {
      await markGitHubIntegrationDegraded(
        buildGitHubPatDegradedReason(error),
        database
      );
    }

    throw error;
  }
}

function buildGitHubPatDegradedReason(error: GitHubPatValidationError): string {
  switch (error.capability) {
    case "authentication":
      return "The stored machine-user PAT is no longer valid. Replace it from setup before creating workspaces or issues.";
    case "owner_lookup":
      return "The stored machine-user PAT can no longer reach the configured organization owner. Re-run setup with a supported organization.";
    case "repository_inventory":
      return "The stored machine-user PAT no longer has repository inventory access for the configured organization. Re-run setup or restore the required permissions.";
    case "project_access":
      return "The stored machine-user PAT no longer has the GitHub Project access required for workspace provisioning. Re-run setup or restore the required permissions.";
    default:
      return error.message;
  }
}
