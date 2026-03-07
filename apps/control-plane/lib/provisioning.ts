import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Docker from "dockerode";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "../../../packages/worker/src/workflow-lifecycle";
import {
  buildWorkspaceRuntimeTokenBrokerUrl,
  deriveWorkspaceRuntimeAuthSecret
} from "./runtime-github-credentials";

const DEFAULT_RUNTIME_ROOT = ".runtime/workspaces";
const DEFAULT_SYMPHONY_IMAGE = "ghcr.io/openai/symphony:latest";
const DEFAULT_INTERNAL_PORT = 4141;
const WORKSPACE_RUNTIME_DIR = "/workspace-runtime";
const WORKSPACE_RUNTIME_TOKEN_CACHE_PATH =
  `${WORKSPACE_RUNTIME_DIR}/.github-installation-token.json`;

export type ProvisionWorkspaceInput = {
  workspaceId: string;
  slug: string;
  promptGuidelines: string;
  githubProjectId: string;
  repositories: Array<{
    owner: string;
    name: string;
    cloneUrl: string;
  }>;
};

export type ProvisionedWorkspaceRuntime = {
  containerId: string;
  containerName: string;
  port: number;
  workflowPath: string;
  workspaceRuntimeDir: string;
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

type PersistenceLike = {
  symphonyInstance: {
    upsert(args: {
      where: { workspaceId: string };
      update: {
        containerId: string;
        containerName: string;
        port: number;
        workflowPath: string;
        status: "provisioning";
      };
      create: {
        workspaceId: string;
        containerId: string;
        containerName: string;
        port: number;
        workflowPath: string;
        status: "provisioning";
      };
    }): Promise<unknown>;
    update(args: {
      where: { workspaceId: string };
      data: {
        status: "running" | "stopped" | "failed" | "degraded";
        lastHeartbeat?: Date;
      };
    }): Promise<unknown>;
  };
};

export async function provisionWorkspaceRuntime(
  input: ProvisionWorkspaceInput,
  options: {
    db: PersistenceLike;
    docker?: DockerClientLike;
    runtimeRoot?: string;
    symphonyImage?: string;
    portAllocator?: () => Promise<number>;
    controlPlaneRuntimeUrl?: string;
    runtimeAuthEnv?: Record<string, string | undefined>;
  }
): Promise<ProvisionedWorkspaceRuntime> {
  const runtimeRoot = options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT;
  const workspaceRuntimeDir = resolve(runtimeRoot, input.slug);
  const containerName = `symphony-${input.slug}`;
  const port = await (options.portAllocator ?? defaultPortAllocator)();
  const workflowPath = join(workspaceRuntimeDir, "WORKFLOW.md");
  const runtimeAuthEnv = {
    ...process.env,
    ...options.runtimeAuthEnv,
    ...(options.controlPlaneRuntimeUrl
      ? {
          CONTROL_PLANE_RUNTIME_URL: options.controlPlaneRuntimeUrl
        }
      : {})
  };
  const runtimeTokenBrokerUrl = buildWorkspaceRuntimeTokenBrokerUrl(
    input.workspaceId,
    runtimeAuthEnv
  );
  const runtimeTokenBrokerSecret = deriveWorkspaceRuntimeAuthSecret(
    input.workspaceId,
    runtimeAuthEnv
  );

  await writeWorkspaceRuntimeArtifacts(
    workspaceRuntimeDir,
    input,
    port,
    runtimeTokenBrokerUrl,
    runtimeTokenBrokerSecret
  );

  const dockerClient = options.docker ?? new Docker();
  const container = (await dockerClient.createContainer({
    Image: options.symphonyImage ?? DEFAULT_SYMPHONY_IMAGE,
    name: containerName,
    Env: [
      `GITHUB_PROJECT_ID=${input.githubProjectId}`,
      `GITHUB_TOKEN_BROKER_URL=${runtimeTokenBrokerUrl}`,
      `GITHUB_TOKEN_BROKER_SECRET=${runtimeTokenBrokerSecret}`,
      `GITHUB_TOKEN_CACHE_PATH=${WORKSPACE_RUNTIME_TOKEN_CACHE_PATH}`,
      `WORKSPACE_ALLOWED_REPOSITORIES=${input.repositories
        .map((repository) => repository.cloneUrl)
        .join(",")}`
    ],
    ExposedPorts: {
      [`${DEFAULT_INTERNAL_PORT}/tcp`]: {}
    },
    HostConfig: {
      Binds: [`${workspaceRuntimeDir}:/workspace-runtime`],
      ExtraHosts: ["host.docker.internal:host-gateway"],
      PortBindings: {
        [`${DEFAULT_INTERNAL_PORT}/tcp`]: [{ HostPort: String(port) }]
      }
    } as {
      Binds: string[];
      ExtraHosts: string[];
      PortBindings: Record<string, Array<{ HostPort: string }>>;
    }
  })) as DockerContainerLike;

  await container.start();

  const containerId = container.id ?? containerName;

  await options.db.symphonyInstance.upsert({
    where: {
      workspaceId: input.workspaceId
    },
    update: {
      containerId,
      containerName,
      port,
      workflowPath,
      status: "provisioning"
    },
    create: {
      workspaceId: input.workspaceId,
      containerId,
      containerName,
      port,
      workflowPath,
      status: "provisioning"
    }
  });

  return {
    containerId,
    containerName,
    port,
    workflowPath,
    workspaceRuntimeDir
  };
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
  input: {
    workspaceId: string;
    containerId: string;
  },
  options: {
    db: PersistenceLike;
    docker?: DockerClientLike;
  }
): Promise<"running" | "stopped" | "failed"> {
  const dockerClient = options.docker ?? new Docker();
  const container = dockerClient.getContainer(input.containerId) as DockerContainerLike;
  const inspection = await container.inspect();
  const nextStatus = inspection.State?.Running
    ? "running"
    : inspection.State?.Status === "exited"
      ? "stopped"
      : "failed";

  await options.db.symphonyInstance.update({
    where: {
      workspaceId: input.workspaceId
    },
    data: {
      status: nextStatus,
      lastHeartbeat: nextStatus === "running" ? new Date() : undefined
    }
  });

  return nextStatus;
}

export async function teardownWorkspaceRuntime(
  input: {
    workspaceId: string;
    containerId: string;
  },
  options: {
    db: PersistenceLike;
    docker?: DockerClientLike;
  }
): Promise<void> {
  const dockerClient = options.docker ?? new Docker();
  const container = dockerClient.getContainer(input.containerId) as DockerContainerLike;

  await container.stop();
  await container.remove({
    force: true
  });

  await options.db.symphonyInstance.update({
    where: {
      workspaceId: input.workspaceId
    },
    data: {
      status: "stopped"
    }
  });
}

export async function reconcileProvisioningFailure(
  input: {
    workspaceId: string;
    containerId?: string;
  },
  options: {
    db: PersistenceLike;
    docker?: DockerClientLike;
  }
): Promise<void> {
  if (input.containerId) {
    const dockerClient = options.docker ?? new Docker();
    const container = dockerClient.getContainer(input.containerId) as DockerContainerLike;

    await container.remove({
      force: true
    });
  }

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
  runtimeTokenBrokerUrl: string,
  runtimeTokenBrokerSecret: string
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
      `SYMPHONY_PORT=${port}`,
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

let nextPort = 4300;

async function defaultPortAllocator(): Promise<number> {
  nextPort += 1;
  return nextPort;
}
