import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseWorkflowMarkdown } from "./workflow-parser.js";

export type WorkerRuntimeState = {
  package: string;
  runtime: "self-hosted-sample";
  status: "idle";
  projectId: string | null;
  workspaceRuntimeDir: string;
  allowedRepositories: string[];
  workflow: null | {
    githubProjectId: string;
    agentCommand: string;
    hookPath: string;
    lifecycle: {
      stateFieldName: string;
      planningStates: string[];
      humanReviewStates: string[];
      implementationStates: string[];
      awaitingMergeStates: string[];
      completedStates: string[];
      planningCompleteState: string;
      implementationCompleteState: string;
      mergeCompleteState: string;
    };
  };
};

export async function buildWorkerRuntimeState(
  env: NodeJS.ProcessEnv,
  readFileImpl: typeof readFile = readFile
): Promise<WorkerRuntimeState> {
  const workspaceRuntimeDir = env.WORKSPACE_RUNTIME_DIR ?? "/workspace-runtime";
  const workflowPath = join(workspaceRuntimeDir, "WORKFLOW.md");
  let workflow: WorkerRuntimeState["workflow"] = null;
  let allowedRepositories = parseAllowedRepositories(env.WORKSPACE_ALLOWED_REPOSITORIES);

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
    package: "@github-symphony/worker",
    runtime: "self-hosted-sample",
    status: "idle",
    projectId: env.GITHUB_PROJECT_ID ?? workflow?.githubProjectId ?? null,
    workspaceRuntimeDir,
    allowedRepositories,
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
