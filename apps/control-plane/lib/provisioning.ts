import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type Docker from "dockerode";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "../../../packages/worker/src/workflow-lifecycle";
import {
  buildWorkspaceAgentCredentialBrokerUrl
} from "./runtime-agent-credentials";
import {
  buildWorkspaceRuntimeTokenBrokerUrl,
  deriveWorkspaceRuntimeAuthSecret
} from "./runtime-github-credentials";
import { type RuntimeDriver, resolveRuntimeDriver } from "./runtime-config";

const DEFAULT_RUNTIME_ROOT = ".runtime/workspaces";
const DEFAULT_SYMPHONY_IMAGE = "ghcr.io/openai/symphony:latest";
const DEFAULT_INTERNAL_PORT = 4141;
const DEFAULT_LOCAL_WORKER_COMMAND =
  "pnpm --filter @github-symphony/worker build && node packages/worker/dist/index.js";
const DEFAULT_ENDPOINT_HOST = "127.0.0.1";
const WORKSPACE_RUNTIME_DIR = "/workspace-runtime";
const WORKSPACE_RUNTIME_TOKEN_CACHE_PATH =
  `${WORKSPACE_RUNTIME_DIR}/.github-token.json`;
const WORKSPACE_RUNTIME_AGENT_CACHE_PATH =
  `${WORKSPACE_RUNTIME_DIR}/.agent-runtime-auth.json`;

export type ProvisionWorkspaceInput = {
  workspaceId: string;
  slug: string;
  promptGuidelines: string;
  githubProjectId: string;
  agentCredentialSource: "platform_default" | "workspace_override";
  repositories: Array<{
    owner: string;
    name: string;
    cloneUrl: string;
  }>;
};

export type ProvisionedWorkspaceRuntime = {
  runtimeDriver: RuntimeDriver;
  runtimeId: string;
  runtimeName: string;
  endpointHost: string;
  port: number;
  workflowPath: string;
  workspaceRuntimeDir: string;
  processId: number | null;
};

export type WorkspaceRuntimeRecord = {
  workspaceId: string;
  runtimeDriver: RuntimeDriver;
  runtimeId: string;
  processId?: number | null;
};

type DockerContainerLike = {
  id?: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  remove(options?: { force?: boolean }): Promise<void>;
  inspect(): Promise<{
    State?: {
      Running?: boolean;
      Status?: string;
    };
  }>;
};

type DockerClientLike = Pick<Docker, "createContainer" | "getContainer">;

type LocalSpawnLike = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
) => ChildProcess;

type PersistenceLike = {
  symphonyInstance: {
    upsert(args: {
      where: { workspaceId: string };
      update: {
        runtimeDriver: RuntimeDriver;
        runtimeId: string;
        runtimeName: string;
        endpointHost: string;
        port: number;
        workflowPath: string;
        runtimePath: string;
        processId: number | null;
        status: "provisioning";
      };
      create: {
        workspaceId: string;
        runtimeDriver: RuntimeDriver;
        runtimeId: string;
        runtimeName: string;
        endpointHost: string;
        port: number;
        workflowPath: string;
        runtimePath: string;
        processId: number | null;
        status: "provisioning";
      };
    }): Promise<unknown>;
    update(args: {
      where: { workspaceId: string };
      data: {
        status?: "running" | "stopped" | "failed" | "degraded";
        degradedReason?: string | null;
        lastHeartbeat?: Date;
      };
    }): Promise<unknown>;
  };
};

type RuntimeLaunchContext = {
  input: ProvisionWorkspaceInput;
  runtimeRoot: string;
  workspaceRuntimeDir: string;
  workflowPath: string;
  port: number;
  runtimeEnvironment: Record<string, string | undefined>;
  runtimeTokenBrokerUrl: string;
  runtimeTokenBrokerSecret: string;
  agentCredentialBrokerUrl: string;
  db: PersistenceLike;
};

type RuntimeProviderOptions = {
  docker?: DockerClientLike;
  symphonyImage?: string;
  projectRoot?: string;
  workerCommand?: string;
  spawnImpl?: LocalSpawnLike;
};

type RuntimeProvider = {
  provision(
    context: RuntimeLaunchContext,
    options: RuntimeProviderOptions
  ): Promise<ProvisionedWorkspaceRuntime>;
  syncStatus(
    input: WorkspaceRuntimeRecord,
    options: RuntimeProviderOptions
  ): Promise<"running" | "stopped" | "failed">;
  teardown(
    input: WorkspaceRuntimeRecord,
    options: RuntimeProviderOptions
  ): Promise<void>;
  reconcileFailure(
    input: WorkspaceRuntimeRecord,
    options: RuntimeProviderOptions
  ): Promise<void>;
};

type ProvisionRuntimeOptions = RuntimeProviderOptions & {
  db: PersistenceLike;
  runtimeDriver?: RuntimeDriver;
  runtimeRoot?: string;
  portAllocator?: () => Promise<number>;
  controlPlaneRuntimeUrl?: string;
  runtimeAuthEnv?: Record<string, string | undefined>;
};

// Load dockerode at call time so Next does not try to bundle optional SSH/native paths.
async function createDockerClient(): Promise<DockerClientLike> {
  const { default: Docker } = await import("dockerode");
  return new Docker();
}

export async function provisionWorkspaceRuntime(
  input: ProvisionWorkspaceInput,
  options: ProvisionRuntimeOptions
): Promise<ProvisionedWorkspaceRuntime> {
  const runtimeRoot = options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT;
  const workspaceRuntimeDir = resolve(runtimeRoot, input.slug);
  const port = await (options.portAllocator ?? defaultPortAllocator)();
  const workflowPath = join(workspaceRuntimeDir, "WORKFLOW.md");
  const runtimeEnvironment = {
    ...process.env,
    ...options.runtimeAuthEnv,
    ...(options.controlPlaneRuntimeUrl
      ? {
          CONTROL_PLANE_RUNTIME_URL: options.controlPlaneRuntimeUrl
        }
      : {})
  };
  const runtimeDriver = options.runtimeDriver ?? resolveRuntimeDriver(runtimeEnvironment);
  const runtimeTokenBrokerUrl = buildWorkspaceRuntimeTokenBrokerUrl(
    input.workspaceId,
    runtimeEnvironment
  );
  const agentCredentialBrokerUrl = buildWorkspaceAgentCredentialBrokerUrl(
    input.workspaceId,
    runtimeEnvironment
  );
  const runtimeTokenBrokerSecret = deriveWorkspaceRuntimeAuthSecret(
    input.workspaceId,
    runtimeEnvironment
  );

  await writeWorkspaceRuntimeArtifacts(
    workspaceRuntimeDir,
    input,
    port,
    runtimeDriver,
    runtimeTokenBrokerUrl,
    runtimeTokenBrokerSecret,
    agentCredentialBrokerUrl
  );

  const runtime = await runtimeProviders[runtimeDriver].provision(
    {
      input,
      runtimeRoot,
      workspaceRuntimeDir,
      workflowPath,
      port,
      runtimeEnvironment,
      runtimeTokenBrokerUrl,
      runtimeTokenBrokerSecret,
      agentCredentialBrokerUrl,
      db: options.db
    },
    options
  );

  await options.db.symphonyInstance.upsert({
    where: {
      workspaceId: input.workspaceId
    },
    update: {
      runtimeDriver: runtime.runtimeDriver,
      runtimeId: runtime.runtimeId,
      runtimeName: runtime.runtimeName,
      endpointHost: runtime.endpointHost,
      port: runtime.port,
      workflowPath: runtime.workflowPath,
      runtimePath: runtime.workspaceRuntimeDir,
      processId: runtime.processId,
      status: "provisioning"
    },
    create: {
      workspaceId: input.workspaceId,
      runtimeDriver: runtime.runtimeDriver,
      runtimeId: runtime.runtimeId,
      runtimeName: runtime.runtimeName,
      endpointHost: runtime.endpointHost,
      port: runtime.port,
      workflowPath: runtime.workflowPath,
      runtimePath: runtime.workspaceRuntimeDir,
      processId: runtime.processId,
      status: "provisioning"
    }
  });

  return runtime;
}

export function renderWorkflowMarkdown(input: ProvisionWorkspaceInput): string {
  return `# Symphony Workspace

## GitHub Project

- Project ID: ${input.githubProjectId}

## Prompt Guidelines

${input.promptGuidelines}

## Repository Allowlist

${input.repositories.map((repository) => `- ${repository.cloneUrl}`).join("\n")}

## Approval Lifecycle

- State field: ${DEFAULT_WORKFLOW_LIFECYCLE.stateFieldName}
- Planning-active states:
  ${DEFAULT_WORKFLOW_LIFECYCLE.planningStates.map((state) => `- ${state}`).join("\n  ")}
- Human-review states:
  ${DEFAULT_WORKFLOW_LIFECYCLE.humanReviewStates.map((state) => `- ${state}`).join("\n  ")}
- Implementation-active states:
  ${DEFAULT_WORKFLOW_LIFECYCLE.implementationStates.map((state) => `- ${state}`).join("\n  ")}
- Awaiting-merge states:
  ${DEFAULT_WORKFLOW_LIFECYCLE.awaitingMergeStates.map((state) => `- ${state}`).join("\n  ")}
- Completed states:
  ${DEFAULT_WORKFLOW_LIFECYCLE.completedStates.map((state) => `- ${state}`).join("\n  ")}
- Planning complete -> ${DEFAULT_WORKFLOW_LIFECYCLE.planningCompleteState}
- Implementation complete -> ${DEFAULT_WORKFLOW_LIFECYCLE.implementationCompleteState}
- Merge complete -> ${DEFAULT_WORKFLOW_LIFECYCLE.mergeCompleteState}

## Runtime

- Agent command: \`bash -lc codex app-server\`
- Hook: \`hooks/after_create.sh\`
`;
}

export async function syncWorkspaceRuntimeStatus(
  input: WorkspaceRuntimeRecord,
  options: RuntimeProviderOptions & {
    db: PersistenceLike;
  }
): Promise<"running" | "stopped" | "failed"> {
  const nextStatus = await runtimeProviders[input.runtimeDriver].syncStatus(input, options);

  await options.db.symphonyInstance.update({
    where: {
      workspaceId: input.workspaceId
    },
    data: {
      status: nextStatus,
      degradedReason: nextStatus === "failed" ? "Runtime health reconciliation failed." : null,
      lastHeartbeat: nextStatus === "running" ? new Date() : undefined
    }
  });

  return nextStatus;
}

export async function teardownWorkspaceRuntime(
  input: WorkspaceRuntimeRecord,
  options: RuntimeProviderOptions & {
    db: PersistenceLike;
  }
): Promise<void> {
  await runtimeProviders[input.runtimeDriver].teardown(input, options);

  await options.db.symphonyInstance.update({
    where: {
      workspaceId: input.workspaceId
    },
    data: {
      status: "stopped",
      degradedReason: null
    }
  });
}

export async function reconcileProvisioningFailure(
  input: WorkspaceRuntimeRecord,
  options: RuntimeProviderOptions & {
    db: PersistenceLike;
  }
): Promise<void> {
  await runtimeProviders[input.runtimeDriver].reconcileFailure(input, options);

  await options.db.symphonyInstance.update({
    where: {
      workspaceId: input.workspaceId
    },
    data: {
      status: "failed"
    }
  });
}

async function writeWorkspaceRuntimeArtifacts(
  workspaceRuntimeDir: string,
  input: ProvisionWorkspaceInput,
  port: number,
  runtimeDriver: RuntimeDriver,
  runtimeTokenBrokerUrl: string,
  runtimeTokenBrokerSecret: string,
  agentCredentialBrokerUrl: string
): Promise<void> {
  const hooksDir = join(workspaceRuntimeDir, "hooks");
  const workflowPath = join(workspaceRuntimeDir, "WORKFLOW.md");
  const envPath = join(workspaceRuntimeDir, "worker.env");
  const hookPath = join(hooksDir, "after_create.sh");

  await mkdir(hooksDir, {
    recursive: true
  });

  await writeFile(workflowPath, renderWorkflowMarkdown(input), "utf8");
  await writeFile(
    envPath,
    [
      `GITHUB_PROJECT_ID=${input.githubProjectId}`,
      `GITHUB_TOKEN_BROKER_URL=${runtimeTokenBrokerUrl}`,
      `GITHUB_TOKEN_BROKER_SECRET=${runtimeTokenBrokerSecret}`,
      `GITHUB_TOKEN_CACHE_PATH=${WORKSPACE_RUNTIME_TOKEN_CACHE_PATH}`,
      `AGENT_CREDENTIAL_BROKER_URL=${agentCredentialBrokerUrl}`,
      `AGENT_CREDENTIAL_BROKER_SECRET=${runtimeTokenBrokerSecret}`,
      `AGENT_CREDENTIAL_CACHE_PATH=${WORKSPACE_RUNTIME_AGENT_CACHE_PATH}`,
      `SYMPHONY_PORT=${port}`,
      `WORKSPACE_RUNTIME_DIR=${workspaceRuntimeDir}`,
      `SYMPHONY_RUNTIME_DRIVER=${runtimeDriver}`,
      `WORKSPACE_ALLOWED_REPOSITORIES=${input.repositories
        .map((repository) => repository.cloneUrl)
        .join(",")}`
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    hookPath,
    `#!/usr/bin/env bash
set -euo pipefail

workspace_dir="\${WORKSPACE_DIR:?WORKSPACE_DIR is required}"
target_repo="\${TARGET_REPOSITORY_CLONE_URL:?TARGET_REPOSITORY_CLONE_URL is required}"
allowed_repos="\${WORKSPACE_ALLOWED_REPOSITORIES:?WORKSPACE_ALLOWED_REPOSITORIES is required}"

case ",$allowed_repos," in
  *,"$target_repo",*) ;;
  *)
    echo "Repository is not allowed: $target_repo" >&2
    exit 1
    ;;
esac

mkdir -p "$workspace_dir"
git clone "$target_repo" "$workspace_dir/repository"
`,
    {
      mode: 0o755
    }
  );
}

const runtimeProviders: Record<RuntimeDriver, RuntimeProvider> = {
  docker: {
    async provision(context, options) {
      const containerName = `symphony-${context.input.slug}`;
      const dockerClient = options.docker ?? (await createDockerClient());
      const container = (await dockerClient.createContainer({
        Image: options.symphonyImage ?? DEFAULT_SYMPHONY_IMAGE,
        name: containerName,
        Env: [
          `GITHUB_PROJECT_ID=${context.input.githubProjectId}`,
          `GITHUB_TOKEN_BROKER_URL=${context.runtimeTokenBrokerUrl}`,
          `GITHUB_TOKEN_BROKER_SECRET=${context.runtimeTokenBrokerSecret}`,
          `GITHUB_TOKEN_CACHE_PATH=${WORKSPACE_RUNTIME_TOKEN_CACHE_PATH}`,
          `AGENT_CREDENTIAL_BROKER_URL=${context.agentCredentialBrokerUrl}`,
          `AGENT_CREDENTIAL_BROKER_SECRET=${context.runtimeTokenBrokerSecret}`,
          `AGENT_CREDENTIAL_CACHE_PATH=${WORKSPACE_RUNTIME_AGENT_CACHE_PATH}`,
          `WORKSPACE_ALLOWED_REPOSITORIES=${context.input.repositories
            .map((repository) => repository.cloneUrl)
            .join(",")}`,
          `WORKSPACE_RUNTIME_DIR=${WORKSPACE_RUNTIME_DIR}`
        ],
        ExposedPorts: {
          [`${DEFAULT_INTERNAL_PORT}/tcp`]: {}
        },
        HostConfig: {
          Binds: [`${context.workspaceRuntimeDir}:${WORKSPACE_RUNTIME_DIR}`],
          ExtraHosts: ["host.docker.internal:host-gateway"],
          PortBindings: {
            [`${DEFAULT_INTERNAL_PORT}/tcp`]: [{ HostPort: String(context.port) }]
          }
        } as {
          Binds: string[];
          ExtraHosts: string[];
          PortBindings: Record<string, Array<{ HostPort: string }>>;
        }
      })) as DockerContainerLike;

      await container.start();

      const runtimeId = container.id ?? containerName;

      return {
        runtimeDriver: "docker",
        runtimeId,
        runtimeName: containerName,
        endpointHost: DEFAULT_ENDPOINT_HOST,
        port: context.port,
        workflowPath: context.workflowPath,
        workspaceRuntimeDir: context.workspaceRuntimeDir,
        processId: null
      };
    },
    async syncStatus(input, options) {
      const dockerClient = options.docker ?? (await createDockerClient());
      const container = dockerClient.getContainer(input.runtimeId) as DockerContainerLike;
      const inspection = await container.inspect();

      return inspection.State?.Running
        ? "running"
        : inspection.State?.Status === "exited"
          ? "stopped"
          : "failed";
    },
    async teardown(input, options) {
      const dockerClient = options.docker ?? (await createDockerClient());
      const container = dockerClient.getContainer(input.runtimeId) as DockerContainerLike;

      await container.stop();
      await container.remove({
        force: true
      });
    },
    async reconcileFailure(input, options) {
      const dockerClient = options.docker ?? (await createDockerClient());
      const container = dockerClient.getContainer(input.runtimeId) as DockerContainerLike;

      await container.remove({
        force: true
      });
    }
  },
  local: {
    async provision(context, options) {
      const runtimeName = `symphony-local-${context.input.slug}`;
      const runtimeId = `local-${context.input.workspaceId}`;
      const childProcess = (options.spawnImpl ?? spawn)("bash", ["-lc", resolveLocalWorkerCommand(options)], {
        cwd: options.projectRoot ?? process.cwd(),
        detached: true,
        env: {
          ...process.env,
          ...context.runtimeEnvironment,
          GITHUB_PROJECT_ID: context.input.githubProjectId,
          GITHUB_TOKEN_BROKER_URL: context.runtimeTokenBrokerUrl,
          GITHUB_TOKEN_BROKER_SECRET: context.runtimeTokenBrokerSecret,
          GITHUB_TOKEN_CACHE_PATH: join(
            context.workspaceRuntimeDir,
            ".github-token.json"
          ),
          AGENT_CREDENTIAL_BROKER_URL: context.agentCredentialBrokerUrl,
          AGENT_CREDENTIAL_BROKER_SECRET: context.runtimeTokenBrokerSecret,
          AGENT_CREDENTIAL_CACHE_PATH: join(
            context.workspaceRuntimeDir,
            ".agent-runtime-auth.json"
          ),
          PORT: String(context.port),
          SYMPHONY_PORT: String(context.port),
          WORKSPACE_RUNTIME_DIR: context.workspaceRuntimeDir,
          WORKSPACE_ALLOWED_REPOSITORIES: context.input.repositories
            .map((repository) => repository.cloneUrl)
            .join(",")
        },
        stdio: "ignore"
      });

      childProcess.unref();

      return {
        runtimeDriver: "local",
        runtimeId,
        runtimeName,
        endpointHost: DEFAULT_ENDPOINT_HOST,
        port: context.port,
        workflowPath: context.workflowPath,
        workspaceRuntimeDir: context.workspaceRuntimeDir,
        processId: childProcess.pid ?? null
      };
    },
    async syncStatus(input) {
      return isLocalProcessRunning(input.processId) ? "running" : "stopped";
    },
    async teardown(input) {
      terminateLocalProcess(input.processId, "SIGTERM");
    },
    async reconcileFailure(input) {
      terminateLocalProcess(input.processId, "SIGTERM");
    }
  }
};

function resolveLocalWorkerCommand(options: RuntimeProviderOptions): string {
  return options.workerCommand ?? DEFAULT_LOCAL_WORKER_COMMAND;
}

function isLocalProcessRunning(processId: number | null | undefined): boolean {
  if (!processId) {
    return false;
  }

  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "EPERM" || error.code === "EINVAL")
    ) {
      return true;
    }

    return false;
  }
}

function terminateLocalProcess(
  processId: number | null | undefined,
  signal: NodeJS.Signals
) {
  if (!processId) {
    return;
  }

  try {
    process.kill(processId, signal);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return;
    }

    throw error;
  }
}

let nextPort = 4300;

async function defaultPortAllocator(): Promise<number> {
  nextPort += 1;
  return nextPort;
}
