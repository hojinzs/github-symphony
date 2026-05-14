import type { WorkflowDefinition } from "@gh-symphony/core";
import type { ClaudePreflightAuthMode } from "@gh-symphony/runtime-claude";

export type WorkerRuntimeRoute = "codex-app-server" | "runtime-adapter";

export function resolveWorkerRuntimeRoute(
  workflow: WorkflowDefinition
): WorkerRuntimeRoute {
  const kind = workflow.runtime?.kind;

  if (!kind || kind === "codex-app-server") {
    return "codex-app-server";
  }

  return "runtime-adapter";
}

export function resolveClaudePreflightAuthMode(
  workflow: WorkflowDefinition
): ClaudePreflightAuthMode {
  return workflow.runtime?.isolation.bare === true
    ? "api-key-required"
    : "local-or-api-key";
}

export function shouldExposeLinearGraphQLTool(
  workflow: WorkflowDefinition,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    workflow.tracker.kind === "linear" ||
    env.SYMPHONY_TRACKER_KIND === "linear" ||
    env.SYMPHONY_TRACKER_ADAPTER === "linear"
  );
}
