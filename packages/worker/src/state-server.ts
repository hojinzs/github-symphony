import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseWorkflowMarkdown } from "./workflow-parser.js";

export type WorkerRuntimeState = {
  package: string;
  runtime: "self-hosted-sample";
  status: "idle" | "starting" | "running" | "failed" | "completed";
  projectId: string | null;
  workspaceRuntimeDir: string;
  allowedRepositories: string[];
  run: null | {
    runId: string;
    issueId: string | null;
    issueIdentifier: string | null;
    state: string | null;
    processId: number | null;
    repository: {
      owner: string | null;
      name: string | null;
      cloneUrl: string | null;
      url: string | null;
    };
    lastError: string | null;
  };
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  sessionInfo?: {
    threadId: string | null;
    turnCount: number;
  } | null;
  workflow: null | {
    githubProjectId: string | null;
    agentCommand: string;
    hookPath: string;
    lifecycle: {
      stateFieldName: string;
      activeStates: string[];
      terminalStates: string[];
      blockerCheckStates: string[];
    };
  };
};

export async function buildWorkerRuntimeState(
  env: NodeJS.ProcessEnv,
  readFileImpl: typeof readFile = readFile,
  runtime: Partial<Pick<WorkerRuntimeState, "status" | "run" | "tokenUsage" | "sessionInfo">> = {}
): Promise<WorkerRuntimeState> {
  const workspaceRuntimeDir = env.WORKSPACE_RUNTIME_DIR ?? "/workspace-runtime";
  const workflowPath = join(env.WORKING_DIRECTORY ?? workspaceRuntimeDir, "WORKFLOW.md");
  let workflow: WorkerRuntimeState["workflow"] = null;
  let allowedRepositories = parseAllowedRepositories(env.WORKSPACE_ALLOWED_REPOSITORIES);
  const assignedRun =
    runtime.run ??
    (env.SYMPHONY_RUN_ID
      ? {
          runId: env.SYMPHONY_RUN_ID,
          issueId: env.SYMPHONY_ISSUE_ID ?? null,
          issueIdentifier: env.SYMPHONY_ISSUE_IDENTIFIER ?? null,
          state: env.SYMPHONY_ISSUE_STATE ?? null,
          processId: null,
          repository: {
            owner: env.TARGET_REPOSITORY_OWNER ?? null,
            name: env.TARGET_REPOSITORY_NAME ?? null,
            cloneUrl: env.TARGET_REPOSITORY_CLONE_URL ?? null,
            url: env.TARGET_REPOSITORY_URL ?? null
          },
          lastError: null
        }
      : null);

  try {
    const workflowMarkdown = await readFileImpl(workflowPath, "utf8");
    const parsedWorkflow = parseWorkflowMarkdown(workflowMarkdown);
    allowedRepositories = parsedWorkflow.allowedRepositories;
    workflow = {
      githubProjectId: parsedWorkflow.githubProjectId,
      agentCommand: parsedWorkflow.agentCommand,
      hookPath: parsedWorkflow.hookPath,
      lifecycle: parsedWorkflow.lifecycle
    };
  } catch {
    // Keep serving a minimal state object even when workflow artifacts are not mounted yet.
  }

  return {
    package: "@gh-symphony/worker",
    runtime: "self-hosted-sample",
    status: runtime.status ?? "idle",
    projectId: env.GITHUB_PROJECT_ID ?? workflow?.githubProjectId ?? null,
    workspaceRuntimeDir,
    allowedRepositories,
    run: assignedRun,
    tokenUsage: runtime.tokenUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    sessionInfo: runtime.sessionInfo ?? null,
    workflow
  };
}

export function createWorkerRequestHandler(
  getState: () => Promise<WorkerRuntimeState>
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.url === "/api/v1/state") {
      const state = await getState();
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(state));
      return;
    }

    response.writeHead(404, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify({ error: "Not found" }));
  };
}

export function startWorkerStateServer(options: {
  port: number;
  getState: () => Promise<WorkerRuntimeState>;
}) {
  const server = createServer((request, response) => {
    void createWorkerRequestHandler(options.getState)(request, response);
  });

  server.listen(options.port);
  return server;
}

function parseAllowedRepositories(value: string | undefined): string[] {
  return value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];
}
