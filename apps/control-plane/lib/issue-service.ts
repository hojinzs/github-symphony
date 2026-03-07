import { db } from "./db";
import { createWorkspaceIssue } from "./github-projects";
import { getBrokeredGitHubCredentials } from "./github-installation-broker";

export type CreateIssueInput = {
  workspaceId: string;
  repositoryOwner: string;
  repositoryName: string;
  title: string;
  body: string;
};

export function parseCreateIssueInput(value: unknown): CreateIssueInput {
  if (!isRecord(value)) {
    throw new Error("Issue payload must be an object.");
  }

  return {
    workspaceId: requireNonEmptyString(value.workspaceId, "workspaceId"),
    repositoryOwner: requireNonEmptyString(value.repositoryOwner, "repositoryOwner"),
    repositoryName: requireNonEmptyString(value.repositoryName, "repositoryName"),
    title: requireNonEmptyString(value.title, "title"),
    body: requireNonEmptyString(value.body, "body")
  };
}

export async function createIssueForWorkspace(
  input: CreateIssueInput,
  dependencies: {
    db?: Pick<typeof db, "workspace">;
    createWorkspaceIssueImpl?: typeof createWorkspaceIssue;
    credentialBroker?: typeof getBrokeredGitHubCredentials;
  } = {}
) {
  const database = dependencies.db ?? db;
  const createWorkspaceIssueImpl =
    dependencies.createWorkspaceIssueImpl ?? createWorkspaceIssue;
  const credentialBroker =
    dependencies.credentialBroker ?? getBrokeredGitHubCredentials;

  const workspace = await database.workspace.findUnique({
    where: {
      id: input.workspaceId
    },
    include: {
      repositories: true
    }
  });

  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  if (!workspace.githubProjectId) {
    throw new Error("Workspace is not provisioned with a GitHub Project yet.");
  }

  const repository = workspace.repositories.find(
    (entry) =>
      entry.owner === input.repositoryOwner && entry.name === input.repositoryName
  );

  if (!repository) {
    throw new Error("Repository does not belong to the selected workspace.");
  }

  const credentials = await credentialBroker();

  return createWorkspaceIssueImpl(credentials.token, {
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    projectId: workspace.githubProjectId,
    title: input.title,
    body: input.body
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
