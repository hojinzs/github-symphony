import { createHash } from "node:crypto";
import {
  GitHubBootstrapAttemptStatus,
  GitHubIntegrationStatus,
  type Prisma
} from "@prisma/client";
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

type GitHubBootstrapAttemptRecord = {
  id: string;
  status: GitHubBootstrapAttemptStatus;
  expiresAt: Date;
  manifestUrl: string | null;
  githubAppName: string | null;
  failureReason: string | null;
  createdAt: Date;
};

type GitHubIntegrationRecord = {
  id: string;
  singletonKey: string;
  status: GitHubIntegrationStatus;
  appId: string | null;
  clientId: string | null;
  appSlug: string | null;
  appName: string | null;
  encryptedClientSecret: string | null;
  encryptedPrivateKey: string | null;
  encryptedWebhookSecret: string | null;
  installationId: string | null;
  installationTargetLogin: string | null;
  installationTargetType: string | null;
  installationTargetUrl: string | null;
  degradedReason: string | null;
  lastValidatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  bootstrapAttempts?: GitHubBootstrapAttemptRecord[];
};

type DatabaseLike = Pick<typeof db, "gitHubIntegration" | "gitHubBootstrapAttempt">;

const READY_REQUIRED_FIELDS = [
  "appId",
  "clientId",
  "encryptedClientSecret",
  "encryptedPrivateKey",
  "installationId",
  "installationTargetLogin",
  "installationTargetType"
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
    appId: string | null;
    clientId: string | null;
    appSlug: string | null;
    appName: string | null;
    installationId: string | null;
    installationTargetLogin: string | null;
    installationTargetType: string | null;
    installationTargetUrl: string | null;
    degradedReason: string | null;
    lastValidatedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    hasClientSecret: boolean;
    hasPrivateKey: boolean;
    hasWebhookSecret: boolean;
  } | null;
  latestBootstrapAttempt: {
    id: string;
    status: GitHubBootstrapAttemptStatus;
    expiresAt: Date;
    manifestUrl: string | null;
    githubAppName: string | null;
    failureReason: string | null;
    isExpired: boolean;
    createdAt: Date;
  } | null;
};

export type ReadyGitHubIntegration = {
  id: string;
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string | null;
  appSlug: string | null;
  appName: string | null;
  installationId: string;
  installationTargetLogin: string;
  installationTargetType: string;
  installationTargetUrl: string | null;
  lastValidatedAt: Date | null;
};

export type ConfiguredGitHubAppCredentials = {
  id: string;
  state: GitHubIntegrationState;
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string | null;
  appSlug: string | null;
  appName: string | null;
  installationId: string | null;
  installationTargetLogin: string | null;
  installationTargetType: string | null;
  installationTargetUrl: string | null;
  lastValidatedAt: Date | null;
};

export type SaveGitHubIntegrationInput = {
  status: GitHubIntegrationStatus;
  appId?: string | null;
  clientId?: string | null;
  appSlug?: string | null;
  appName?: string | null;
  appWebhookUrl?: string | null;
  appSetupUrl?: string | null;
  encryptedClientSecret?: string | null;
  encryptedPrivateKey?: string | null;
  encryptedWebhookSecret?: string | null;
  installationId?: string | null;
  installationTargetId?: string | null;
  installationTargetLogin?: string | null;
  installationTargetType?: string | null;
  installationTargetUrl?: string | null;
  manifestCreatedAt?: Date | null;
  lastValidatedAt?: Date | null;
  degradedReason?: string | null;
};

export type CreateGitHubBootstrapAttemptInput = {
  integrationId?: string | null;
  stateToken: string;
  manifest: Prisma.InputJsonValue;
  manifestUrl?: string;
  githubAppName?: string;
  expiresAt: Date;
};

export function fingerprintBootstrapStateToken(stateToken: string): string {
  return createHash("sha256").update(stateToken).digest("hex");
}

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

  const missingFields = getGitHubIntegrationMissingFields(integration);

  if (integration.status === GitHubIntegrationStatus.degraded) {
    return "degraded";
  }

  if (integration.status === GitHubIntegrationStatus.ready) {
    return missingFields.length === 0 ? "ready" : "degraded";
  }

  return "pending";
}

export async function loadGitHubIntegrationSummary(
  database: DatabaseLike = db,
  now: Date = new Date()
): Promise<GitHubIntegrationSummary> {
  const integration =
    (await database.gitHubIntegration.findUnique({
      where: {
        singletonKey: SYSTEM_GITHUB_INTEGRATION_KEY
      },
      include: {
        bootstrapAttempts: {
          orderBy: {
            createdAt: "desc"
          },
          take: 1
        }
      }
    })) as GitHubIntegrationRecord | null;

  const latestBootstrapAttempt = integration?.bootstrapAttempts?.[0] ?? null;

  return {
    state: classifyGitHubIntegration(integration),
    missingFields: integration ? getGitHubIntegrationMissingFields(integration) : [],
    integration: integration
      ? {
          id: integration.id,
          singletonKey: integration.singletonKey,
          status: integration.status,
          appId: integration.appId,
          clientId: integration.clientId,
          appSlug: integration.appSlug,
          appName: integration.appName,
          installationId: integration.installationId,
          installationTargetLogin: integration.installationTargetLogin,
          installationTargetType: integration.installationTargetType,
          installationTargetUrl: integration.installationTargetUrl,
          degradedReason: integration.degradedReason,
          lastValidatedAt: integration.lastValidatedAt,
          createdAt: integration.createdAt,
          updatedAt: integration.updatedAt,
          hasClientSecret: Boolean(integration.encryptedClientSecret),
          hasPrivateKey: Boolean(integration.encryptedPrivateKey),
          hasWebhookSecret: Boolean(integration.encryptedWebhookSecret)
        }
      : null,
    latestBootstrapAttempt: latestBootstrapAttempt
      ? {
          id: latestBootstrapAttempt.id,
          status: latestBootstrapAttempt.status,
          expiresAt: latestBootstrapAttempt.expiresAt,
          manifestUrl: latestBootstrapAttempt.manifestUrl,
          githubAppName: latestBootstrapAttempt.githubAppName,
          failureReason: latestBootstrapAttempt.failureReason,
          isExpired: latestBootstrapAttempt.expiresAt.getTime() <= now.getTime(),
          createdAt: latestBootstrapAttempt.createdAt
        }
      : null
  };
}

export async function loadReadyGitHubIntegration(
  database: DatabaseLike = db,
  secretProtector: GitHubSecretProtector = loadGitHubSecretProtectorFromEnv()
): Promise<ReadyGitHubIntegration> {
  const integration = await loadConfiguredGitHubAppCredentials(
    database,
    secretProtector
  );

  if (integration.state !== "ready" || !integration.installationId) {
    throw new GitHubIntegrationStateError(
      integration.state,
      `GitHub integration is ${integration.state}; bootstrap must complete before GitHub operations can continue.`
    );
  }

  return {
    id: integration.id,
    appId: integration.appId,
    clientId: integration.clientId,
    clientSecret: integration.clientSecret,
    privateKey: integration.privateKey,
    webhookSecret: integration.webhookSecret,
    appSlug: integration.appSlug,
    appName: integration.appName,
    installationId: integration.installationId,
    installationTargetLogin: integration.installationTargetLogin as string,
    installationTargetType: integration.installationTargetType as string,
    installationTargetUrl: integration.installationTargetUrl,
    lastValidatedAt: integration.lastValidatedAt
  };
}

export async function loadConfiguredGitHubAppCredentials(
  database: DatabaseLike = db,
  secretProtector: GitHubSecretProtector = loadGitHubSecretProtectorFromEnv()
): Promise<ConfiguredGitHubAppCredentials> {
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
    !integration.appId ||
    !integration.clientId ||
    !integration.encryptedClientSecret ||
    !integration.encryptedPrivateKey
  ) {
    throw new GitHubIntegrationStateError(
      state,
      "GitHub App credentials are incomplete."
    );
  }

  return {
    id: integration.id,
    state,
    appId: integration.appId,
    clientId: integration.clientId,
    clientSecret: secretProtector.decrypt(integration.encryptedClientSecret),
    privateKey: secretProtector.decrypt(integration.encryptedPrivateKey),
    webhookSecret: integration.encryptedWebhookSecret
      ? secretProtector.decrypt(integration.encryptedWebhookSecret)
      : null,
    appSlug: integration.appSlug,
    appName: integration.appName,
    installationId: integration.installationId,
    installationTargetLogin: integration.installationTargetLogin,
    installationTargetType: integration.installationTargetType,
    installationTargetUrl: integration.installationTargetUrl,
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

export async function createGitHubBootstrapAttempt(
  input: CreateGitHubBootstrapAttemptInput,
  database: DatabaseLike = db
) {
  return database.gitHubBootstrapAttempt.create({
    data: {
      integrationId: input.integrationId ?? undefined,
      status: GitHubBootstrapAttemptStatus.pending,
      stateFingerprint: fingerprintBootstrapStateToken(input.stateToken),
      manifest: input.manifest,
      manifestUrl: input.manifestUrl,
      githubAppName: input.githubAppName,
      expiresAt: input.expiresAt
    }
  });
}

export async function findGitHubBootstrapAttemptByStateToken(
  stateToken: string,
  database: DatabaseLike = db
) {
  return database.gitHubBootstrapAttempt.findUnique({
    where: {
      stateFingerprint: fingerprintBootstrapStateToken(stateToken)
    }
  });
}

export async function updateGitHubBootstrapAttempt(
  attemptId: string,
  input: {
    status?: GitHubBootstrapAttemptStatus;
    integrationId?: string | null;
    installationId?: string | null;
    conversionCompletedAt?: Date | null;
    completedAt?: Date | null;
    failureReason?: string | null;
  },
  database: DatabaseLike = db
) {
  return database.gitHubBootstrapAttempt.update({
    where: {
      id: attemptId
    },
    data: input
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

export async function resetGitHubBootstrapState(
  database: DatabaseLike = db
) {
  const integration = await database.gitHubIntegration.findUnique({
    where: {
      singletonKey: SYSTEM_GITHUB_INTEGRATION_KEY
    }
  });

  if (integration) {
    await database.gitHubIntegration.update({
      where: {
        singletonKey: SYSTEM_GITHUB_INTEGRATION_KEY
      },
      data: {
        status: GitHubIntegrationStatus.pending,
        installationId: null,
        installationTargetId: null,
        installationTargetLogin: null,
        installationTargetType: null,
        installationTargetUrl: null,
        lastValidatedAt: null,
        degradedReason: null
      }
    });
  }

  await database.gitHubBootstrapAttempt.updateMany({
    where: {
      status: {
        in: [
          GitHubBootstrapAttemptStatus.pending,
          GitHubBootstrapAttemptStatus.converted
        ]
      }
    },
    data: {
      status: GitHubBootstrapAttemptStatus.failed,
      failureReason: "Operator restarted GitHub App bootstrap."
    }
  });
}
