import type Docker from "dockerode";
import { WorkspaceStatus, type Prisma } from "@prisma/client";
import {
  createWorkspaceProject,
  type WorkspaceProject
} from "./github-projects";
import { getBrokeredGitHubCredentials } from "./github-installation-broker";
import {
  provisionWorkspaceRuntime,
  type ProvisionedWorkspaceRuntime
} from "./provisioning";
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
  "workspace" | "symphonyInstance" | "agentCredential" | "platformAgentCredentialConfig"
>;

export async function provisionWorkspace(
  input: CreateWorkspaceInput,
  dependencies: {
    db?: DatabaseLike;
    fetchImpl?: typeof fetch;
    docker?: Pick<Docker, "createContainer" | "getContainer">;
    runtimeRoot?: string;
    portAllocator?: () => Promise<number>;
    credentialBroker?: typeof getBrokeredGitHubCredentials;
    controlPlaneRuntimeUrl?: string;
    runtimeAuthEnv?: Record<string, string | undefined>;
  } = {}
): Promise<{
  workspace: WorkspaceRecord;
  project: WorkspaceProject;
  runtime: ProvisionedWorkspaceRuntime;
}> {
  const database = dependencies.db ?? db;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const credentialBroker =
    dependencies.credentialBroker ?? getBrokeredGitHubCredentials;
  await ensureWorkspaceHasUsableAgentCredential(
    {
      agentCredentialSource: input.agentCredentialSource,
      agentCredentialId: input.agentCredentialId
    },
    database as Parameters<typeof ensureWorkspaceHasUsableAgentCredential>[1]
  );
  const credentials = await credentialBroker({
    fetchImpl
  });

  const workspace = await createWorkspace(input, credentials.ownerLogin, database);
  const project = await createWorkspaceProject(
    credentials.token,
    {
      ownerLogin: workspace.githubOwnerLogin,
      title: `${workspace.name} Workspace`
    },
    fetchImpl
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
      promptGuidelines: workspace.promptGuidelines,
      githubProjectId: project.id,
      agentCredentialSource: workspace.agentCredentialSource,
      repositories: workspace.repositories.map((repository) => ({
        owner: repository.owner,
        name: repository.name,
        cloneUrl: repository.cloneUrl
      }))
    },
    {
      db: database,
      docker: dependencies.docker,
      runtimeRoot: dependencies.runtimeRoot,
      portAllocator: dependencies.portAllocator,
      controlPlaneRuntimeUrl: dependencies.controlPlaneRuntimeUrl,
      runtimeAuthEnv: dependencies.runtimeAuthEnv
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
