import type Docker from "dockerode";
import { WorkspaceStatus, type Prisma } from "@prisma/client";
import {
  githubProjectTrackerAdapter,
  type WorkspaceProject
} from "./github-project-tracker-adapter";
import { getProjectGitHubCredentials } from "./github-user-broker";
import {
  provisionWorkspaceRuntime,
  type ProvisionedWorkspaceRuntime
} from "./provisioning";
import { type RuntimeDriver } from "./runtime-config";
import { ensureWorkspaceHasUsableAgentCredential } from "./agent-credentials";
import {
  createWorkspace,
  type CreateWorkspaceInput,
  updateWorkspaceProvisioning
} from "./workspace-service";
import { db } from "./db";

type WorkspaceRecord = Prisma.PromiseReturnType<typeof createWorkspace>;

type DatabaseLike = Pick<
  typeof db,
  | "workspace"
  | "symphonyInstance"
  | "agentCredential"
  | "platformAgentCredentialConfig"
>;

export async function provisionWorkspace(
  input: CreateWorkspaceInput,
  dependencies: {
    db?: DatabaseLike;
    fetchImpl?: typeof fetch;
    docker?: Pick<Docker, "createContainer" | "getContainer">;
    runtimeDriver?: RuntimeDriver;
    runtimeRoot?: string;
    portAllocator?: () => Promise<number>;
    controlPlaneRuntimeUrl?: string;
    runtimeAuthEnv?: Record<string, string | undefined>;
    workerCommand?: string;
    projectRoot?: string;
    credentialBroker?: typeof getProjectGitHubCredentials;
  } = {}
): Promise<{
  workspace: WorkspaceRecord;
  project: WorkspaceProject;
  runtime: ProvisionedWorkspaceRuntime;
}> {
  const database = dependencies.db ?? db;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  await ensureWorkspaceHasUsableAgentCredential(
    {
      agentCredentialSource: input.agentCredentialSource,
      agentCredentialId: input.agentCredentialId
    },
    database as Parameters<typeof ensureWorkspaceHasUsableAgentCredential>[1]
  );

  const workspace = await createWorkspace(
    input,
    input.githubOwnerLogin ?? input.repositories[0]?.owner ?? "github",
    database
  );
  const project = await githubProjectTrackerAdapter.bindWorkspace(
    {
      workspaceName: workspace.name,
      ownerLogin: workspace.githubOwnerLogin
    },
    {
      db: database as never,
      fetchImpl,
      credentialBroker: dependencies.credentialBroker
    }
  );

  await updateWorkspaceProvisioning(
    {
      workspaceId: workspace.id,
      githubProjectId: project.id,
      githubProjectUrl: project.url,
      status: WorkspaceStatus.provisioning
    },
    database
  );

  const runtime = await provisionWorkspaceRuntime(
    {
      workspaceId: workspace.id,
      slug: workspace.slug,
      promptGuidelines: workspace.promptGuidelines ?? "",
      githubProjectId: project.id,
      agentCredentialSource: workspace.agentCredentialSource,
      repositories: workspace.repositories.map((repository: {
        owner: string;
        name: string;
        cloneUrl: string | null;
      }) => ({
        owner: repository.owner,
        name: repository.name,
        cloneUrl:
          repository.cloneUrl ??
          `https://github.com/${repository.owner}/${repository.name}.git`
      }))
    },
    {
      db: database,
      runtimeDriver: dependencies.runtimeDriver,
      runtimeRoot: dependencies.runtimeRoot,
      portAllocator: dependencies.portAllocator,
      controlPlaneRuntimeUrl: dependencies.controlPlaneRuntimeUrl,
      runtimeAuthEnv: dependencies.runtimeAuthEnv,
      workerCommand: dependencies.workerCommand,
      projectRoot: dependencies.projectRoot
    }
  );

  await updateWorkspaceProvisioning(
    {
      workspaceId: workspace.id,
      githubProjectId: project.id,
      githubProjectUrl: project.url,
      status: WorkspaceStatus.active
    },
    database
  );

  return {
    workspace: {
      ...workspace,
      githubProjectId: project.id,
      githubProjectUrl: project.url,
      status: WorkspaceStatus.active
    },
    project,
    runtime
  };
}
