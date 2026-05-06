import type { WorkflowDefinition } from "@gh-symphony/core";

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
