import {
  AgentCredentialProvider,
  AgentCredentialStatus,
  WorkspaceAgentCredentialSource,
  type Prisma
} from "@prisma/client";
import { db } from "./db";
import { loadPlatformSecretProtectorFromEnv } from "./platform-secrets";

const DEFAULT_OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const PLATFORM_DEFAULT_SINGLETON_KEY = "system";

export class AgentCredentialError extends Error {}

export type AgentCredentialSummary = {
  id: string;
  label: string;
  provider: AgentCredentialProvider;
  status: AgentCredentialStatus;
  fingerprint: string;
  isPlatformDefault: boolean;
  lastValidatedAt: string | null;
  degradedReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateAgentCredentialInput = {
  label: string;
  apiKey: string;
  provider: AgentCredentialProvider;
};

export type RotateAgentCredentialInput = {
  credentialId: string;
  apiKey: string;
};

type AgentCredentialDatabase = Pick<
  typeof db,
  "agentCredential" | "platformAgentCredentialConfig" | "workspace" | "symphonyInstance"
>;

type AgentCredentialRecord = Prisma.AgentCredentialGetPayload<{
  select: {
    id: true;
    label: true;
    provider: true;
    secretFingerprint: true;
    status: true;
    lastValidatedAt: true;
    degradedReason: true;
    createdAt: true;
    updatedAt: true;
  };
}>;

type EffectiveAgentCredentialRecord = Prisma.WorkspaceGetPayload<{
  select: {
    id: true;
    name: true;
    agentCredentialSource: true;
    agentCredential: {
      select: {
        id: true;
        label: true;
        provider: true;
        encryptedSecret: true;
        secretFingerprint: true;
        status: true;
        degradedReason: true;
        lastValidatedAt: true;
      };
    };
  };
}>;

export function parseCreateAgentCredentialInput(
  value: unknown
): CreateAgentCredentialInput {
  if (!isRecord(value)) {
    throw new AgentCredentialError("Agent credential payload must be an object.");
  }

  const label = requireNonEmptyString(value.label, "label");
  const apiKey = requireNonEmptyString(value.apiKey, "apiKey");
  const provider = parseProvider(value.provider);

  return {
    label,
    apiKey,
    provider
  };
}

export function parseRotateAgentCredentialInput(
  credentialId: string,
  value: unknown
): RotateAgentCredentialInput {
  if (!isRecord(value)) {
    throw new AgentCredentialError("Agent credential payload must be an object.");
  }

  return {
    credentialId,
    apiKey: requireNonEmptyString(value.apiKey, "apiKey")
  };
}

export async function validateAgentCredential(input: {
  provider?: AgentCredentialProvider;
  apiKey: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}): Promise<{
  provider: AgentCredentialProvider;
  fingerprint: string;
  status: AgentCredentialStatus;
  checkedAt: string;
}> {
  const provider = input.provider ?? AgentCredentialProvider.openai;
  const secretProtector = loadPlatformSecretProtectorFromEnv();
  const fingerprint = secretProtector.fingerprint(input.apiKey);

  if (provider !== AgentCredentialProvider.openai) {
    throw new AgentCredentialError(`Unsupported agent credential provider: ${provider}`);
  }

  if (!looksLikeOpenAIApiKey(input.apiKey)) {
    throw new AgentCredentialError(
      "Agent credential validation failed: expected an OpenAI-style API key."
    );
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${(input.apiBaseUrl ?? DEFAULT_OPENAI_API_BASE_URL).replace(/\/+$/, "")}/models`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${input.apiKey}`
      }
    }
  );

  if (!response.ok) {
    const payload = await safeReadJson(response);
    throw new AgentCredentialError(
      payload?.error ??
        `Agent credential validation failed with status ${response.status}.`
    );
  }

  return {
    provider,
    fingerprint,
    status: AgentCredentialStatus.ready,
    checkedAt: new Date().toISOString()
  };
}

export async function createAgentCredential(
  input: CreateAgentCredentialInput,
  dependencies: {
    db?: AgentCredentialDatabase;
    fetchImpl?: typeof fetch;
    apiBaseUrl?: string;
  } = {}
) {
  const database = dependencies.db ?? db;
  const validation = await validateAgentCredential({
    provider: input.provider,
    apiKey: input.apiKey,
    fetchImpl: dependencies.fetchImpl,
    apiBaseUrl: dependencies.apiBaseUrl
  });
  const secretProtector = loadPlatformSecretProtectorFromEnv();

  const created = await database.agentCredential.create({
    data: {
      label: input.label,
      provider: input.provider,
      encryptedSecret: secretProtector.encrypt(input.apiKey),
      secretFingerprint: validation.fingerprint,
      status: AgentCredentialStatus.ready,
      lastValidatedAt: new Date(validation.checkedAt),
      degradedReason: null
    }
  });

  return serializeAgentCredential(created, false);
}

export async function rotateAgentCredential(
  input: RotateAgentCredentialInput,
  dependencies: {
    db?: AgentCredentialDatabase;
    fetchImpl?: typeof fetch;
    apiBaseUrl?: string;
  } = {}
) {
  const database = dependencies.db ?? db;
  const existing = await database.agentCredential.findUnique({
    where: {
      id: input.credentialId
    }
  });

  if (!existing) {
    throw new AgentCredentialError("Agent credential was not found.");
  }

  const validation = await validateAgentCredential({
    provider: existing.provider,
    apiKey: input.apiKey,
    fetchImpl: dependencies.fetchImpl,
    apiBaseUrl: dependencies.apiBaseUrl
  });
  const secretProtector = loadPlatformSecretProtectorFromEnv();

  const updated = await database.agentCredential.update({
    where: {
      id: input.credentialId
    },
    data: {
      encryptedSecret: secretProtector.encrypt(input.apiKey),
      secretFingerprint: validation.fingerprint,
      status: AgentCredentialStatus.ready,
      lastValidatedAt: new Date(validation.checkedAt),
      degradedReason: null
    }
  });

  const platformDefault = await database.platformAgentCredentialConfig.findUnique({
    where: {
      singletonKey: PLATFORM_DEFAULT_SINGLETON_KEY
    }
  });

  return serializeAgentCredential(
    updated,
    platformDefault?.defaultAgentCredentialId === updated.id
  );
}

export async function listAgentCredentials(
  database: AgentCredentialDatabase = db
): Promise<{
  credentials: AgentCredentialSummary[];
  platformDefaultCredentialId: string | null;
  hasReadyPlatformDefault: boolean;
  hasReadyOverrideCandidates: boolean;
}> {
  const [credentials, defaultConfig] = await Promise.all([
    database.agentCredential.findMany({
      orderBy: {
        createdAt: "asc"
      }
    }),
    database.platformAgentCredentialConfig.findUnique({
      where: {
        singletonKey: PLATFORM_DEFAULT_SINGLETON_KEY
      }
    })
  ]);

  return {
    credentials: credentials.map((credential) =>
      serializeAgentCredential(
        credential,
        defaultConfig?.defaultAgentCredentialId === credential.id
      )
    ),
    platformDefaultCredentialId: defaultConfig?.defaultAgentCredentialId ?? null,
    hasReadyPlatformDefault: credentials.some(
      (credential) =>
        credential.id === defaultConfig?.defaultAgentCredentialId &&
        credential.status === AgentCredentialStatus.ready
    ),
    hasReadyOverrideCandidates: credentials.some(
      (credential) => credential.status === AgentCredentialStatus.ready
    )
  };
}

export async function setPlatformDefaultAgentCredential(
  credentialId: string,
  database: AgentCredentialDatabase = db
) {
  const credential = await database.agentCredential.findUnique({
    where: {
      id: credentialId
    }
  });

  if (!credential) {
    throw new AgentCredentialError("Agent credential was not found.");
  }

  if (credential.status !== AgentCredentialStatus.ready) {
    throw new AgentCredentialError(
      "Only ready agent credentials can be selected as the platform default."
    );
  }

  await database.platformAgentCredentialConfig.upsert({
    where: {
      singletonKey: PLATFORM_DEFAULT_SINGLETON_KEY
    },
    update: {
      defaultAgentCredentialId: credential.id
    },
    create: {
      singletonKey: PLATFORM_DEFAULT_SINGLETON_KEY,
      defaultAgentCredentialId: credential.id
    }
  });

  return serializeAgentCredential(credential, true);
}

export async function ensureWorkspaceHasUsableAgentCredential(
  input: {
    workspaceId?: string;
    agentCredentialSource: WorkspaceAgentCredentialSource;
    agentCredentialId?: string;
  },
  database: AgentCredentialDatabase = db
): Promise<void> {
  if (input.agentCredentialSource === WorkspaceAgentCredentialSource.workspace_override) {
    if (!input.agentCredentialId) {
      throw new AgentCredentialError(
        "A workspace-specific agent credential must be selected."
      );
    }

    const credential = await database.agentCredential.findUnique({
      where: {
        id: input.agentCredentialId
      }
    });

    if (!credential || credential.status !== AgentCredentialStatus.ready) {
      throw new AgentCredentialError(
        "The selected workspace-specific agent credential is not ready."
      );
    }

    return;
  }

  const defaultConfig = await database.platformAgentCredentialConfig.findUnique({
    where: {
      singletonKey: PLATFORM_DEFAULT_SINGLETON_KEY
    },
    include: {
      defaultAgentCredential: true
    }
  });

  if (
    !defaultConfig?.defaultAgentCredential ||
    defaultConfig.defaultAgentCredential.status !== AgentCredentialStatus.ready
  ) {
    throw new AgentCredentialError(
      "A ready platform-default agent credential is required before this workspace can be created."
    );
  }
}

export async function readWorkspaceAgentCredentialStatus(
  workspaceId: string,
  database: AgentCredentialDatabase = db
): Promise<{
  source: WorkspaceAgentCredentialSource;
  status: "ready" | "missing" | "degraded";
  label: string | null;
  message: string;
  credentialId: string | null;
  provider: AgentCredentialProvider | null;
}> {
  const resolved = await resolveEffectiveAgentCredentialRecord(workspaceId, database, true);

  if (resolved.kind === "missing") {
    return {
      source: resolved.source,
      status: "missing",
      label: null,
      message: resolved.message,
      credentialId: null,
      provider: null
    };
  }

  if (resolved.kind === "degraded") {
    return {
      source: resolved.source,
      status: "degraded",
      label: resolved.credential.label,
      message: resolved.message,
      credentialId: resolved.credential.id,
      provider: resolved.credential.provider
    };
  }

  return {
    source: resolved.source,
    status: "ready",
    label: resolved.credential.label,
    message:
      resolved.source === WorkspaceAgentCredentialSource.platform_default
        ? "Using the ready platform-default agent credential."
        : "Using the ready workspace-specific override credential.",
    credentialId: resolved.credential.id,
    provider: resolved.credential.provider
  };
}

export async function issueWorkspaceAgentRuntimeCredentials(
  workspaceId: string,
  dependencies: {
    db?: AgentCredentialDatabase;
  } = {}
) {
  const database = dependencies.db ?? db;
  const resolved = await resolveEffectiveAgentCredentialRecord(workspaceId, database, false);

  if (resolved.kind !== "ready") {
    throw new AgentCredentialError(resolved.message);
  }

  const secretProtector = loadPlatformSecretProtectorFromEnv();

  return {
    workspaceId,
    source: resolved.source,
    credentialId: resolved.credential.id,
    credentialLabel: resolved.credential.label,
    provider: resolved.credential.provider,
    env: {
      OPENAI_API_KEY: secretProtector.decrypt(resolved.credential.encryptedSecret)
    },
    cache: {
      path: "/workspace-runtime/.agent-runtime-auth.json"
    }
  };
}

export async function markAgentCredentialDegraded(
  input: {
    credentialId: string;
    reason: string;
  },
  database: AgentCredentialDatabase = db
) {
  await database.agentCredential.update({
    where: {
      id: input.credentialId
    },
    data: {
      status: AgentCredentialStatus.degraded,
      degradedReason: input.reason
    }
  });
}

export async function markWorkspaceRuntimeDegradedForAgentCredential(
  input: {
    workspaceId: string;
    reason: string;
  },
  database: AgentCredentialDatabase = db
) {
  await database.symphonyInstance
    .update({
      where: {
        workspaceId: input.workspaceId
      },
      data: {
        status: "degraded",
        degradedReason: input.reason
      }
    })
    .catch(() => undefined);
}

async function resolveEffectiveAgentCredentialRecord(
  workspaceId: string,
  database: AgentCredentialDatabase,
  allowMissing = false
): Promise<
  | {
      kind: "ready";
      source: WorkspaceAgentCredentialSource;
      credential: {
        id: string;
        label: string;
        provider: AgentCredentialProvider;
        encryptedSecret: string;
      };
    }
  | {
      kind: "missing";
      source: WorkspaceAgentCredentialSource;
      message: string;
    }
  | {
      kind: "degraded";
      source: WorkspaceAgentCredentialSource;
      credential: {
        id: string;
        label: string;
        provider: AgentCredentialProvider;
        encryptedSecret: string;
      };
      message: string;
    }
> {
  const workspace = await database.workspace.findUnique({
    where: {
      id: workspaceId
    },
    select: {
      id: true,
      name: true,
      agentCredentialSource: true,
      agentCredential: {
        select: {
          id: true,
          label: true,
          provider: true,
          encryptedSecret: true,
          secretFingerprint: true,
          status: true,
          degradedReason: true,
          lastValidatedAt: true
        }
      }
    }
  });

  if (!workspace) {
    throw new AgentCredentialError("Workspace was not found.");
  }

  if (
    workspace.agentCredentialSource ===
    WorkspaceAgentCredentialSource.workspace_override
  ) {
    return coerceCredentialRecord(
      workspace.agentCredentialSource,
      workspace.agentCredential,
      allowMissing,
      "This workspace requires a workspace-specific agent credential before new runs can start."
    );
  }

  const defaultConfig = await database.platformAgentCredentialConfig.findUnique({
    where: {
      singletonKey: PLATFORM_DEFAULT_SINGLETON_KEY
    },
    include: {
      defaultAgentCredential: {
        select: {
          id: true,
          label: true,
          provider: true,
          encryptedSecret: true,
          secretFingerprint: true,
          status: true,
          degradedReason: true,
          lastValidatedAt: true
        }
      }
    }
  });

  return coerceCredentialRecord(
    WorkspaceAgentCredentialSource.platform_default,
    defaultConfig?.defaultAgentCredential ?? null,
    allowMissing,
    "A ready platform-default agent credential must be configured before this workspace can run."
  );
}

function coerceCredentialRecord(
  source: WorkspaceAgentCredentialSource,
  credential:
    | EffectiveAgentCredentialRecord["agentCredential"]
    | {
        id: string;
        label: string;
        provider: AgentCredentialProvider;
        encryptedSecret: string;
        secretFingerprint: string;
        status: AgentCredentialStatus;
        degradedReason: string | null;
        lastValidatedAt: Date | null;
      }
    | null,
  allowMissing: boolean,
  missingMessage: string
) {
  if (!credential) {
    if (allowMissing) {
      return {
        kind: "missing" as const,
        source,
        message: missingMessage
      };
    }

    throw new AgentCredentialError(missingMessage);
  }

  if (credential.status !== AgentCredentialStatus.ready) {
    return {
      kind: "degraded" as const,
      source,
      credential: {
        id: credential.id,
        label: credential.label,
        provider: credential.provider,
        encryptedSecret: credential.encryptedSecret
      },
      message:
        credential.degradedReason ??
        "The effective agent credential is degraded and must be recovered before new runs can start."
    };
  }

  return {
    kind: "ready" as const,
    source,
    credential: {
      id: credential.id,
      label: credential.label,
      provider: credential.provider,
      encryptedSecret: credential.encryptedSecret
    }
  };
}

function serializeAgentCredential(
  credential: AgentCredentialRecord,
  isPlatformDefault: boolean
): AgentCredentialSummary {
  return {
    id: credential.id,
    label: credential.label,
    provider: credential.provider,
    status: credential.status,
    fingerprint: credential.secretFingerprint,
    isPlatformDefault,
    lastValidatedAt: credential.lastValidatedAt?.toISOString() ?? null,
    degradedReason: credential.degradedReason,
    createdAt: credential.createdAt.toISOString(),
    updatedAt: credential.updatedAt.toISOString()
  };
}

function parseProvider(value: unknown): AgentCredentialProvider {
  if (value === undefined || value === null || value === "") {
    return AgentCredentialProvider.openai;
  }

  if (value === AgentCredentialProvider.openai) {
    return value;
  }

  throw new AgentCredentialError("provider must be a supported provider.");
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentCredentialError(`${field} must be a non-empty string.`);
  }

  return value.trim();
}

function looksLikeOpenAIApiKey(value: string): boolean {
  return /^sk-[a-z0-9_-]{16,}$/i.test(value.trim());
}

async function safeReadJson(response: Response): Promise<{ error?: string } | null> {
  try {
    return (await response.json()) as { error?: string };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
