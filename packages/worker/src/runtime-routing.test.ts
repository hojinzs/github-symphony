import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_DEFINITION,
  type WorkflowDefinition,
} from "@gh-symphony/core";
import { resolveWorkerRuntimeRoute } from "./runtime-routing.js";

describe("resolveWorkerRuntimeRoute", () => {
  it("keeps legacy codex fallback on the Codex app-server route", () => {
    expect(resolveWorkerRuntimeRoute(workflowWithRuntime(null))).toBe(
      "codex-app-server"
    );
  });

  it("keeps explicit codex-app-server runtime on the Codex route", () => {
    expect(
      resolveWorkerRuntimeRoute(
        workflowWithRuntime({
          kind: "codex-app-server",
          command: "codex",
          args: ["app-server"],
        })
      )
    ).toBe("codex-app-server");
  });

  it.each(["claude-print", "custom"] as const)(
    "routes %s through runtime adapters",
    (kind) => {
      expect(
        resolveWorkerRuntimeRoute(
          workflowWithRuntime({
            kind,
            command: kind === "custom" ? "agent" : "claude",
            args: [],
          })
        )
      ).toBe("runtime-adapter");
    }
  );
});

function workflowWithRuntime(
  runtime: null | {
    kind: "codex-app-server" | "claude-print" | "custom";
    command: string;
    args: readonly string[];
  }
): WorkflowDefinition {
  return {
    ...DEFAULT_WORKFLOW_DEFINITION,
    runtime:
      runtime === null
        ? null
        : {
            kind: runtime.kind,
            command: runtime.command,
            args: runtime.args,
            isolation: {
              bare: false,
              strictMcpConfig: false,
            },
            auth: {
              env: null,
            },
            timeouts: DEFAULT_WORKFLOW_DEFINITION.codex,
          },
  };
}
