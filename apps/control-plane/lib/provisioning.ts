import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "@github-symphony/core";
import { fetchWorkspaceOrchestratorStatus } from "./orchestrator-status-client";
import { type RuntimeDriver, resolveRuntimeDriver } from "./runtime-config";
import {
  buildWorkspaceAgentCredentialBrokerUrl
} from "./runtime-agent-credentials";
import {
  buildWorkspaceRuntimeTokenBrokerUrl,
  deriveWorkspaceRuntimeAuthSecret
} from "./runtime-github-credentials";

const DEFAULT_RUNTIME_ROOT = ".runtime/workspaces";
const DEFAULT_ENDPOINT_HOST = "127.0.0.1";

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
        status: "provisioning" | "stopped";
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
        status: "provisioning" | "stopped";
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

type ProvisionRuntimeOptions = {
  db: PersistenceLike;
  runtimeDriver?: RuntimeDriver;
  runtimeRoot?: string;
  portAllocator?: () => Promise<number>;
  docker?: unknown;
  controlPlaneRuntimeUrl?: string;
  runtimeAuthEnv?: Record<string, string | undefined>;
  workerCommand?: string;
  projectRoot?: string;
  spawnImpl?: unknown;
};

export async function provisionWorkspaceRuntime(
  input: ProvisionWorkspaceInput,
  options: ProvisionRuntimeOptions
): Promise<ProvisionedWorkspaceRuntime> {
  const runtimeRoot = options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT;
  const workspaceRuntimeDir = resolve(runtimeRoot, input.slug);
  const preferredPort = await (options.portAllocator ?? defaultPortAllocator)();
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
    preferredPort,
    runtimeDriver,
    runtimeTokenBrokerUrl,
    runtimeTokenBrokerSecret,
    agentCredentialBrokerUrl
  );
  await writeOrchestratorWorkspaceConfig(
    resolve(runtimeRoot, ".."),
    {
      workspaceId: input.workspaceId,
      slug: input.slug,
      promptGuidelines: input.promptGuidelines,
      repositories: input.repositories,
      tracker: {
        adapter: "github-project",
        bindingId: input.githubProjectId,
        settings: {
          projectId: input.githubProjectId
        }
      },
      runtime: {
        driver: "local",
        workspaceRuntimeDir,
        projectRoot: options.projectRoot ?? process.cwd(),
        workerCommand: options.workerCommand
      }
    }
  );

  const runtimeId = `workspace-${input.workspaceId}`;
  const runtimeName = `orchestrator-${input.slug}`;
  const runtime = {
    runtimeDriver,
    runtimeId,
    runtimeName,
    endpointHost: DEFAULT_ENDPOINT_HOST,
    port: 0,
    workflowPath,
    workspaceRuntimeDir,
    processId: null
  } satisfies ProvisionedWorkspaceRuntime;

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
      status: "stopped"
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
      status: "stopped"
    }
  });

  return runtime;
}

export function renderWorkflowMarkdown(input: ProvisionWorkspaceInput): string {
  return `---
github_project_id: ${input.githubProjectId}
allowed_repositories:
${input.repositories.map((repository) => `  - ${repository.cloneUrl}`).join("\n")}
lifecycle:
  state_field: ${DEFAULT_WORKFLOW_LIFECYCLE.stateFieldName}
  planning_active:
${DEFAULT_WORKFLOW_LIFECYCLE.planningStates.map((state: string) => `    - ${state}`).join("\n")}
  human_review:
${DEFAULT_WORKFLOW_LIFECYCLE.humanReviewStates.map((state: string) => `    - ${state}`).join("\n")}
  implementation_active:
${DEFAULT_WORKFLOW_LIFECYCLE.implementationStates.map((state: string) => `    - ${state}`).join("\n")}
  awaiting_merge:
${DEFAULT_WORKFLOW_LIFECYCLE.awaitingMergeStates.map((state: string) => `    - ${state}`).join("\n")}
  completed:
${DEFAULT_WORKFLOW_LIFECYCLE.completedStates.map((state: string) => `    - ${state}`).join("\n")}
  transitions:
    planning_complete: ${DEFAULT_WORKFLOW_LIFECYCLE.planningCompleteState}
    implementation_complete: ${DEFAULT_WORKFLOW_LIFECYCLE.implementationCompleteState}
    merge_complete: ${DEFAULT_WORKFLOW_LIFECYCLE.mergeCompleteState}
runtime:
  agent_command: bash -lc codex app-server
hooks:
  after_create: hooks/after_create.sh
scheduler:
  poll_interval_ms: 30000
retry:
  base_delay_ms: 1000
  max_delay_ms: 30000
---
${input.promptGuidelines}
`;
}

export async function syncWorkspaceRuntimeStatus(
  input: WorkspaceRuntimeRecord,
  options: {
    db: PersistenceLike;
    fetchImpl?: typeof fetch;
    docker?: unknown;
  }
): Promise<"running" | "stopped" | "failed"> {
  const status = await fetchWorkspaceOrchestratorStatus(input.workspaceId, {
    fetchImpl: options.fetchImpl
  });
  const nextStatus =
    status?.health === "running"
      ? "running"
      : status?.health === "degraded"
        ? "failed"
        : "stopped";

  await options.db.symphonyInstance.update({
    where: {
      workspaceId: input.workspaceId
    },
    data: {
      status: nextStatus,
      degradedReason:
        nextStatus === "failed"
          ? "Orchestrator reported a degraded workspace status."
          : null,
      lastHeartbeat: nextStatus === "running" ? new Date() : undefined
    }
  });

  return nextStatus;
}

export async function teardownWorkspaceRuntime(
  input: WorkspaceRuntimeRecord,
  options: {
    db: PersistenceLike;
    docker?: unknown;
  }
): Promise<void> {
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
  options: {
    db: PersistenceLike;
    docker?: unknown;
  }
): Promise<void> {
  await options.db.symphonyInstance.update({
    where: {
      workspaceId: input.workspaceId
    },
    data: {
      status: "failed",
      degradedReason: "Workspace orchestration metadata failed to initialize."
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
  const envPath = join(workspaceRuntimeDir, "worker.env");
  const hookPath = join(hooksDir, "after_create.sh");

  await mkdir(hooksDir, {
    recursive: true
  });

  await writeFile(
    envPath,
    [
      `GITHUB_PROJECT_ID=${input.githubProjectId}`,
      `GITHUB_TOKEN_BROKER_URL=${runtimeTokenBrokerUrl}`,
      `GITHUB_TOKEN_BROKER_SECRET=${runtimeTokenBrokerSecret}`,
      `AGENT_CREDENTIAL_BROKER_URL=${agentCredentialBrokerUrl}`,
      `AGENT_CREDENTIAL_BROKER_SECRET=${runtimeTokenBrokerSecret}`,
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

mkdir -p "$workspace_dir"
git clone "$target_repo" "$workspace_dir/repository"
`,
    {
      mode: 0o755
    }
  );
}

async function writeOrchestratorWorkspaceConfig(
  runtimeRoot: string,
  config: {
    workspaceId: string;
    slug: string;
    promptGuidelines: string;
    repositories: ProvisionWorkspaceInput["repositories"];
    tracker: {
      adapter: "github-project";
      bindingId: string;
      settings: {
        projectId: string;
      };
    };
    runtime: {
      driver: "local";
      workspaceRuntimeDir: string;
      projectRoot: string;
      workerCommand?: string;
    };
  }
) {
  const path = join(runtimeRoot, "orchestrator", "workspaces", config.workspaceId, "config.json");
  await mkdir(dirname(path), {
    recursive: true
  });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

let nextPort = 4300;

async function defaultPortAllocator(): Promise<number> {
  nextPort += 1;
  return nextPort;
}
