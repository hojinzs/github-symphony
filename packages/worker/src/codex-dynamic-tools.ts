import type {
  AgentToolExecutionContext,
  JsonValue,
  OrchestratorTrackerAdapter,
} from "@gh-symphony/core";
import { githubProjectTrackerAdapter } from "@gh-symphony/tracker-github";
import { linearTrackerAdapter } from "@gh-symphony/tracker-linear";

export type TrackerToolContext = AgentToolExecutionContext;

export type CodexDynamicToolCallResponse = {
  success: boolean;
  contentItems: Array<{ type: "inputText"; text: string }>;
};

type HostToolDependencies = {
  adapter?: Pick<
    OrchestratorTrackerAdapter,
    "agentToolSpecs" | "executeAgentTool"
  >;
};

export function createTrackerToolContext(
  env: NodeJS.ProcessEnv
): TrackerToolContext {
  return {
    issue: {
      id: env.SYMPHONY_ISSUE_ID ?? "",
      identifier: env.SYMPHONY_ISSUE_IDENTIFIER ?? "",
      nativeRef: parseNativeRef(env.SYMPHONY_ISSUE_NATIVE_REF),
    },
  };
}

export async function executeCodexDynamicToolCall(
  toolName: string,
  argumentsValue: unknown,
  context: TrackerToolContext,
  env: NodeJS.ProcessEnv,
  dependencies: HostToolDependencies = {},
  allowedToolNames: readonly string[] = resolveTrackerToolAdapter(env)
    .agentToolSpecs?.()
    .map((tool) => tool.name) ?? []
): Promise<CodexDynamicToolCallResponse> {
  if (!isRecord(argumentsValue)) {
    return failure("invalid_arguments", "Tool arguments must be an object.");
  }
  if (!allowedToolNames.includes(toolName)) {
    return failure("unknown_tool", `Tool "${toolName}" is not supported.`);
  }

  try {
    const adapter = dependencies.adapter ?? resolveTrackerToolAdapter(env);
    if (!adapter.executeAgentTool) {
      return failure("unknown_tool", `Tool "${toolName}" is not supported.`);
    }
    const result = await adapter.executeAgentTool(
      toolName,
      argumentsValue,
      context
    );
    return success(result);
  } catch (error) {
    return failure(
      "tool_execution_failed",
      error instanceof Error ? error.message : String(error)
    );
  }
}

function resolveTrackerToolAdapter(
  env: NodeJS.ProcessEnv
): OrchestratorTrackerAdapter {
  return env.SYMPHONY_TRACKER_KIND === "linear"
    ? linearTrackerAdapter
    : githubProjectTrackerAdapter;
}

function parseNativeRef(
  value: string | undefined
): AgentToolExecutionContext["issue"]["nativeRef"] {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed)
      ? (parsed as Record<string, JsonValue>)
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function success(result: unknown): CodexDynamicToolCallResponse {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
  };
}

function failure(code: string, message: string): CodexDynamicToolCallResponse {
  return {
    success: false,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({ error: { code, message } }),
      },
    ],
  };
}
