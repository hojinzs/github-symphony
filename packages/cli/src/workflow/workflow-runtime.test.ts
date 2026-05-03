import { describe, expect, it } from "vitest";
import {
  isClaudeRuntime,
  resolveShellAgentCommand,
} from "./workflow-runtime.js";

describe("workflow runtime helpers", () => {
  it("keeps shell-wrapped runtime commands unchanged", () => {
    expect(resolveShellAgentCommand("bash -lc codex app-server")).toBe(
      "bash -lc codex app-server"
    );
  });

  it("wraps supported preset commands for context metadata", () => {
    expect(resolveShellAgentCommand("codex-app-server")).toBe(
      "bash -lc codex app-server"
    );
    expect(resolveShellAgentCommand("claude-print")).toBe(
      "bash -lc claude -p --output-format stream-json --input-format stream-json --include-partial-messages --verbose --permission-mode bypassPermissions"
    );
  });

  it("leaves custom runtime commands unwrapped", () => {
    expect(resolveShellAgentCommand("node worker.js")).toBe("node worker.js");
  });

  it("matches wrapped Claude commands without broad substring matching", () => {
    expect(isClaudeRuntime("bash -lc claude-code")).toBe(true);
    expect(isClaudeRuntime("my-claude-code-wrapper")).toBe(false);
  });
});
