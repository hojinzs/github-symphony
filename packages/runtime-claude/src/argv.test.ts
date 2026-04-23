import { describe, expect, it } from "vitest";
import { buildClaudePrintArgv, DEFAULT_CLAUDE_PRINT_ARGS } from "./argv.js";

describe("buildClaudePrintArgv", () => {
  it("includes the default claude -p flags", () => {
    const args = buildClaudePrintArgv();

    expect(args).toEqual([...DEFAULT_CLAUDE_PRINT_ARGS]);
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--input-format");
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("--verbose");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("bypassPermissions");
  });

  it("appends a first-turn session id", () => {
    expect(
      buildClaudePrintArgv({
        session: {
          mode: "start",
          sessionId: "session-1",
        },
      })
    ).toEqual([
      ...DEFAULT_CLAUDE_PRINT_ARGS,
      "--session-id",
      "session-1",
    ]);
  });

  it("appends resume and fork-session flags for resumed turns", () => {
    expect(
      buildClaudePrintArgv({
        session: {
          mode: "resume",
          sessionId: "session-2",
          forkSession: true,
        },
      })
    ).toEqual([
      ...DEFAULT_CLAUDE_PRINT_ARGS,
      "--resume",
      "session-2",
      "--fork-session",
    ]);
  });

  it("skips isolation flags when isolation is off", () => {
    expect(
      buildClaudePrintArgv({
        isolation: {
          bare: false,
          strictMcpConfig: false,
        },
      })
    ).toEqual([...DEFAULT_CLAUDE_PRINT_ARGS]);
  });

  it("appends bare and strict mcp config flags when enabled", () => {
    expect(
      buildClaudePrintArgv({
        isolation: {
          bare: true,
          strictMcpConfig: true,
          mcpConfigPath: "/tmp/claude-mcp.json",
        },
      })
    ).toEqual([
      ...DEFAULT_CLAUDE_PRINT_ARGS,
      "--bare",
      "--strict-mcp-config",
      "--mcp-config",
      "/tmp/claude-mcp.json",
    ]);
  });
});
