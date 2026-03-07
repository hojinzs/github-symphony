import { WorkspaceStatus, type Prisma } from "@prisma/client";
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

  return {
    name,
    promptGuidelines,
    repositories,
    githubOwnerLogin
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

export function buildWorkspaceCreateData(
  input: CreateWorkspaceInput,
  githubOwnerLogin: string
): Prisma.WorkspaceCreateInput {
  return {
    slug: slugifyWorkspaceName(input.name),
    name: input.name,
    promptGuidelines: input.promptGuidelines,
    status: WorkspaceStatus.draft,
    githubOwnerLogin: input.githubOwnerLogin ?? githubOwnerLogin,
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
  return database.workspace.create({
    data: buildWorkspaceCreateData(input, githubOwnerLogin),
    include: {
      repositories: true
    }
  });
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

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
