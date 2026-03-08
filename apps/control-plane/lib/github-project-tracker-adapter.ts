import { db } from "./db";
import {
  createWorkspaceIssue,
  createWorkspaceProject,
  type WorkspaceIssue,
  type WorkspaceProject
} from "./github-projects";
import { getProjectGitHubCredentials } from "./github-user-broker";

export type { WorkspaceIssue, WorkspaceProject } from "./github-projects";

type DatabaseLike = Partial<Pick<typeof db, "gitHubIntegration">>;

export type GitHubProjectTrackerAdapter = {
  kind: "github-project";
  bindWorkspace(
    input: {
      workspaceName: string;
      ownerLogin: string;
    },
    dependencies?: {
      db?: DatabaseLike;
      fetchImpl?: typeof fetch;
      credentialBroker?: typeof getProjectGitHubCredentials;
    }
  ): Promise<WorkspaceProject>;
  createIssue(
    input: {
      workspaceId: string;
      repositoryOwner: string;
      repositoryName: string;
      projectId: string;
      title: string;
      body: string;
    },
    dependencies?: {
      db?: DatabaseLike;
      fetchImpl?: typeof fetch;
      credentialBroker?: typeof getProjectGitHubCredentials;
    }
  ): Promise<WorkspaceIssue>;
};

export const githubProjectTrackerAdapter: GitHubProjectTrackerAdapter = {
  kind: "github-project",

  async bindWorkspace(input, dependencies = {}) {
    const credentialBroker =
      dependencies.credentialBroker ?? getProjectGitHubCredentials;
    const credentials = await credentialBroker({
      db: dependencies.db as never,
      fetchImpl: dependencies.fetchImpl
    });

    return createWorkspaceProject(
      credentials.token,
      {
        ownerLogin: input.ownerLogin,
        ownerType: credentials.ownerType,
        title: `${input.workspaceName} Workspace`
      },
      dependencies.fetchImpl
    );
  },

  async createIssue(input, dependencies = {}) {
    const credentialBroker =
      dependencies.credentialBroker ?? getProjectGitHubCredentials;
    const credentials = await credentialBroker({
      db: dependencies.db as never,
      fetchImpl: dependencies.fetchImpl
    });

    return createWorkspaceIssue(
      credentials.token,
      {
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        projectId: input.projectId,
        title: input.title,
        body: input.body
      },
      dependencies.fetchImpl
    );
  }
};
