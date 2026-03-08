import { GitHubIntegrationStatus } from "@prisma/client";
import { db } from "./db";
import {
  type GitHubSecretProtector,
  loadGitHubSecretProtectorFromEnv
} from "./github-integration-secrets";

export const SYSTEM_GITHUB_INTEGRATION_KEY = "system";

export type GitHubIntegrationState =
  | "unconfigured"
  | "pending"
  | "ready"
  | "degraded";

type GitHubIntegrationRecord = {
  id: string;
  singletonKey: string;
  status: GitHubIntegrationStatus;
  encryptedPatToken: string | null;
  patTokenFingerprint: string | null;
  patActorId: string | null;
  patActorLogin: string | null;
  patValidatedOwnerId: string | null;
  patValidatedOwnerLogin: string | null;
  patValidatedOwnerType: string | null;
  patValidatedOwnerUrl: string | null;
  lastValidatedAt: Date | null;
  degradedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type DatabaseLike = Pick<typeof db, "gitHubIntegration">;

const READY_REQUIRED_FIELDS = [
  "encryptedPatToken",
  "patTokenFingerprint",
  "patActorId",
  "patActorLogin",
  "patValidatedOwnerId",
  "patValidatedOwnerLogin",
  "patValidatedOwnerType"
] as const;

export class GitHubIntegrationStateError extends Error {
  constructor(
    readonly state: GitHubIntegrationState,
    message: string
  ) {
    super(message);
  }
}

export type GitHubIntegrationSummary = {
  state: GitHubIntegrationState;
  missingFields: string[];
  integration: {
    id: string;
    singletonKey: string;
    status: GitHubIntegrationStatus;
    patTokenFingerprint: string | null;
    patActorId: string | null;
    patActorLogin: string | null;
    patValidatedOwnerId: string | null;
    patValidatedOwnerLogin: string | null;
    patValidatedOwnerType: string | null;
    patValidatedOwnerUrl: string | null;
    degradedReason: string | null;
    lastValidatedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    hasPatToken: boolean;
  } | null;
};

export type ConfiguredGitHubPatCredentials = {
  id: string;
  state: GitHubIntegrationState;
  token: string;
  tokenFingerprint: string;
  actorId: string;
  actorLogin: string;
  validatedOwnerId: string;
  validatedOwnerLogin: string;
  validatedOwnerType: string;
  validatedOwnerUrl: string | null;
  lastValidatedAt: Date | null;
};

export type SaveGitHubIntegrationInput = {
  status: GitHubIntegrationStatus;
  encryptedPatToken?: string | null;
  patTokenFingerprint?: string | null;
  patActorId?: string | null;
  patActorLogin?: string | null;
  patValidatedOwnerId?: string | null;
  patValidatedOwnerLogin?: string | null;
  patValidatedOwnerType?: string | null;
  patValidatedOwnerUrl?: string | null;
  lastValidatedAt?: Date | null;
  degradedReason?: string | null;
};

export function getGitHubIntegrationMissingFields(
  integration: Pick<GitHubIntegrationRecord, (typeof READY_REQUIRED_FIELDS)[number]>
): string[] {
  return READY_REQUIRED_FIELDS.filter((field) => !integration[field]);
}

export function classifyGitHubIntegration(
  integration: GitHubIntegrationRecord | null
): GitHubIntegrationState {
  if (!integration) {
    return "unconfigured";
  }

  if (integration.status === GitHubIntegrationStatus.degraded) {
    return "degraded";
  }

  if (integration.status === GitHubIntegrationStatus.ready) {
    return getGitHubIntegrationMissingFields(integration).length === 0
      ? "ready"
      : "degraded";
  }

  return "pending";
}

export async function loadGitHubIntegrationSummary(
  database: DatabaseLike = db
): Promise<GitHubIntegrationSummary> {
  const integration = (await database.gitHubIntegration.findUnique({
    where: {
      singletonKey: SYSTEM_GITHUB_INTEGRATION_KEY
    }
  })) as GitHubIntegrationRecord | null;

  return {
    state: classifyGitHubIntegration(integration),
    missingFields: integration ? getGitHubIntegrationMissingFields(integration) : [],
    integration: integration
      ? {
          id: integration.id,
          singletonKey: integration.singletonKey,
          status: integration.status,
          patTokenFingerprint: integration.patTokenFingerprint,
          patActorId: integration.patActorId,
          patActorLogin: integration.patActorLogin,
          patValidatedOwnerId: integration.patValidatedOwnerId,
          patValidatedOwnerLogin: integration.patValidatedOwnerLogin,
          patValidatedOwnerType: integration.patValidatedOwnerType,
          patValidatedOwnerUrl: integration.patValidatedOwnerUrl,
          degradedReason: integration.degradedReason,
          lastValidatedAt: integration.lastValidatedAt,
          createdAt: integration.createdAt,
          updatedAt: integration.updatedAt,
          hasPatToken: Boolean(integration.encryptedPatToken)
        }
      : null
  };
}

export async function loadConfiguredGitHubPatCredentials(
  database: DatabaseLike = db,
  secretProtector: GitHubSecretProtector = loadGitHubSecretProtectorFromEnv()
): Promise<ConfiguredGitHubPatCredentials> {
  const integration = (await database.gitHubIntegration.findUnique({
    where: {
      singletonKey: SYSTEM_GITHUB_INTEGRATION_KEY
    }
  })) as GitHubIntegrationRecord | null;
  const state = classifyGitHubIntegration(integration);

  if (!integration) {
    throw new GitHubIntegrationStateError(
      "unconfigured",
      "GitHub integration has not been configured yet."
    );
  }

  if (
    !integration.encryptedPatToken ||
    !integration.patTokenFingerprint ||
    !integration.patActorId ||
    !integration.patActorLogin ||
    !integration.patValidatedOwnerId ||
    !integration.patValidatedOwnerLogin ||
    !integration.patValidatedOwnerType
  ) {
    throw new GitHubIntegrationStateError(
      state,
      "GitHub PAT credentials are incomplete."
    );
  }

  return {
    id: integration.id,
    state,
    token: secretProtector.decrypt(integration.encryptedPatToken),
    tokenFingerprint: integration.patTokenFingerprint,
    actorId: integration.patActorId,
    actorLogin: integration.patActorLogin,
    validatedOwnerId: integration.patValidatedOwnerId,
    validatedOwnerLogin: integration.patValidatedOwnerLogin,
    validatedOwnerType: integration.patValidatedOwnerType,
    validatedOwnerUrl: integration.patValidatedOwnerUrl,
    lastValidatedAt: integration.lastValidatedAt
  };
}

export async function saveGitHubIntegration(
  input: SaveGitHubIntegrationInput,
  database: DatabaseLike = db
) {
  return database.gitHubIntegration.upsert({
    where: {
      singletonKey: SYSTEM_GITHUB_INTEGRATION_KEY
    },
    create: {
      singletonKey: SYSTEM_GITHUB_INTEGRATION_KEY,
      ...input
    },
    update: input
  });
}

export async function markGitHubIntegrationDegraded(
  degradedReason: string,
  database: DatabaseLike = db
) {
  return database.gitHubIntegration.update({
    where: {
      singletonKey: SYSTEM_GITHUB_INTEGRATION_KEY
    },
    data: {
      status: GitHubIntegrationStatus.degraded,
      degradedReason
    }
  });
}
