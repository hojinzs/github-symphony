import {
  Prisma,
  WorkspaceAgentCredentialSource,
  WorkspaceStatus,
} from "@prisma/client";
import { db } from "./db";

export type WorkspaceRepositoryInput = {
  owner: string;
  name: string;
  cloneUrl: string;
};

export type CreateWorkspaceInput = {
  name: string;
  promptGuidelines: string;
  repositories: WorkspaceRepositoryInput[];
  githubOwnerLogin?: string;
  agentCredentialSource: WorkspaceAgentCredentialSource;
  agentCredentialId?: string;
};

export type CreateWorkspaceSubmission = {
  name: string;
  promptGuidelines: string;
  repositoryIds: string[];
  githubOwnerLogin?: string;
  agentCredentialSource: WorkspaceAgentCredentialSource;
  agentCredentialId?: string;
};

export function parseCreateWorkspaceInput(value: unknown): CreateWorkspaceInput {
  if (!isRecord(value)) {
    throw new Error("Workspace payload must be an object.");
  }

  const name = requireNonEmptyString(value.name, "name");
  const promptGuidelines = requireNonEmptyString(
    value.promptGuidelines,
    "promptGuidelines"
  );
  const repositories = parseRepositories(value.repositories);
  const githubOwnerLogin = value.githubOwnerLogin
    ? requireNonEmptyString(value.githubOwnerLogin, "githubOwnerLogin")
    : undefined;
  const agentCredentialSource = parseAgentCredentialSource(
    value.agentCredentialSource
  );
  const agentCredentialId =
    value.agentCredentialId === undefined || value.agentCredentialId === null
      ? undefined
      : requireNonEmptyString(value.agentCredentialId, "agentCredentialId");

  return {
    name,
    promptGuidelines,
    repositories,
    githubOwnerLogin,
    agentCredentialSource,
    agentCredentialId
  };
}

export function parseCreateWorkspaceSubmission(
  value: unknown
): CreateWorkspaceSubmission {
  if (!isRecord(value)) {
    throw new Error("Workspace payload must be an object.");
  }

  const name = requireNonEmptyString(value.name, "name");
  const promptGuidelines = requireNonEmptyString(
    value.promptGuidelines,
    "promptGuidelines"
  );
  const repositoryIds = parseRepositoryIds(value.repositoryIds);
  const githubOwnerLogin = value.githubOwnerLogin
    ? requireNonEmptyString(value.githubOwnerLogin, "githubOwnerLogin")
    : undefined;
  const agentCredentialSource = parseAgentCredentialSource(
    value.agentCredentialSource
  );
  const agentCredentialId =
    value.agentCredentialId === undefined || value.agentCredentialId === null
      ? undefined
      : requireNonEmptyString(value.agentCredentialId, "agentCredentialId");

  return {
    name,
    promptGuidelines,
    repositoryIds,
    githubOwnerLogin,
    agentCredentialSource,
    agentCredentialId
  };
}

export function createWorkspaceInputFromSubmission(
  submission: CreateWorkspaceSubmission,
  repositories: WorkspaceRepositoryInput[]
): CreateWorkspaceInput {
  return {
    name: submission.name,
    promptGuidelines: submission.promptGuidelines,
    repositories: repositories.map((repository) => ({
      owner: repository.owner,
      name: repository.name,
      cloneUrl: repository.cloneUrl
    })),
    githubOwnerLogin: submission.githubOwnerLogin,
    agentCredentialSource: submission.agentCredentialSource,
    agentCredentialId: submission.agentCredentialId
  };
}

export function slugifyWorkspaceName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function buildWorkspaceSlugCandidate(name: string, collisionCount = 0): string {
  const baseSlug = slugifyWorkspaceName(name) || "workspace";

  if (collisionCount === 0) {
    return baseSlug;
  }

  const suffix = `-${collisionCount + 1}`;
  const maxBaseLength = Math.max(1, 48 - suffix.length);

  return `${baseSlug.slice(0, maxBaseLength).replace(/-+$/g, "")}${suffix}`;
}

export function buildWorkspaceCreateData(
  input: CreateWorkspaceInput,
  githubOwnerLogin: string,
  slug = buildWorkspaceSlugCandidate(input.name)
): Prisma.WorkspaceCreateInput {
  return {
    slug,
    name: input.name,
    promptGuidelines: input.promptGuidelines,
    status: WorkspaceStatus.draft,
    githubOwnerLogin: input.githubOwnerLogin ?? githubOwnerLogin,
    agentCredentialSource: input.agentCredentialSource,
    ...(input.agentCredentialSource ===
    WorkspaceAgentCredentialSource.workspace_override
      ? {
          agentCredential: {
            connect: {
              id: input.agentCredentialId
            }
          }
        }
      : {}),
    repositories: {
      create: input.repositories.map((repository) => ({
        owner: repository.owner,
        name: repository.name,
        cloneUrl: repository.cloneUrl
      }))
    }
  };
}

export async function createWorkspace(
  input: CreateWorkspaceInput,
  githubOwnerLogin: string,
  database: Pick<typeof db, "workspace"> = db
) {
  let collisionCount = 0;

  while (collisionCount < 100) {
    try {
      return await database.workspace.create({
        data: buildWorkspaceCreateData(
          input,
          githubOwnerLogin,
          buildWorkspaceSlugCandidate(input.name, collisionCount)
        ),
        include: {
          repositories: true
        }
      });
    } catch (error) {
      if (!isWorkspaceSlugUniqueConstraintError(error)) {
        throw error;
      }

      collisionCount += 1;
    }
  }

  throw new Error("Could not allocate a unique workspace slug.");
}

export async function updateWorkspaceProvisioning(
  input: {
    workspaceId: string;
    githubProjectId: string;
    githubProjectUrl: string;
    status: WorkspaceStatus;
  },
  database: Pick<typeof db, "workspace"> = db
) {
  return database.workspace.update({
    where: {
      id: input.workspaceId
    },
    data: {
      githubProjectId: input.githubProjectId,
      githubProjectUrl: input.githubProjectUrl,
      status: input.status
    }
  });
}

function parseRepositories(value: unknown): WorkspaceRepositoryInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("repositories must contain at least one repository.");
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`repositories[${index}] must be an object.`);
    }

    return {
      owner: requireNonEmptyString(item.owner, `repositories[${index}].owner`),
      name: requireNonEmptyString(item.name, `repositories[${index}].name`),
      cloneUrl: requireNonEmptyString(
        item.cloneUrl,
        `repositories[${index}].cloneUrl`
      )
    };
  });
}

function parseRepositoryIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("repositoryIds must contain at least one repository.");
  }

  return [...new Set(value.map((item, index) => requireNonEmptyString(item, `repositoryIds[${index}]`)))];
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAgentCredentialSource(
  value: unknown
): WorkspaceAgentCredentialSource {
  if (
    value === undefined ||
    value === null ||
    value === WorkspaceAgentCredentialSource.platform_default
  ) {
    return WorkspaceAgentCredentialSource.platform_default;
  }

  if (value === WorkspaceAgentCredentialSource.workspace_override) {
    return value;
  }

  throw new Error(
    "agentCredentialSource must be either platform_default or workspace_override."
  );
}

function isWorkspaceSlugUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  if (error.code !== "P2002") {
    return false;
  }

  const target = error.meta?.target;

  if (!Array.isArray(target)) {
    return false;
  }

  return target.includes("slug");
}
