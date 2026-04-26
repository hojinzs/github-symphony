import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  formatClaudePreflightText,
  isClaudeRuntimeCommand,
  resolveClaudeCommandBinary,
  runClaudePreflight,
} from "./preflight.js";

function execSuccess(command: string, args: readonly string[] = []): Buffer {
  if (command === "which" || command === "where") {
    return Buffer.from(`/usr/bin/${args[0] ?? "claude"}\n`);
  }
  if (args[0] === "--version") {
    return Buffer.from(`${command} 1.2.3\n`);
  }
  if (command === "gh") {
    return Buffer.from("Logged in\n");
  }
  return Buffer.from("");
}

describe("Claude runtime preflight", () => {
  it("reports a clear missing binary failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "claude-preflight-bin-"));
    const report = await runClaudePreflight(
      {
        cwd,
        env: { ANTHROPIC_API_KEY: "sk-test" },
        command: "claude",
      },
      {
        execFileSync: vi.fn(() => {
          throw new Error("not found");
        }) as never,
      }
    );

    const binary = report.checks.find((check) => check.id === "claude_binary");
    expect(binary).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("claude could not be found"),
      remediation: expect.stringContaining("Install Claude Code"),
    });
  });

  it("reports missing ANTHROPIC_API_KEY with broker guidance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "claude-preflight-key-"));
    const report = await runClaudePreflight(
      { cwd, env: {}, command: "claude" },
      { execFileSync: vi.fn(execSuccess) as never }
    );

    const apiKey = report.checks.find(
      (check) => check.id === "anthropic_api_key"
    );
    expect(apiKey).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("Neither ANTHROPIC_API_KEY"),
      remediation: expect.stringContaining(
        "Set ANTHROPIC_API_KEY or configure"
      ),
    });
  });

  it("reports gh authentication failure when requested", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "claude-preflight-gh-"));
    const execFileSync = vi.fn(
      (command: string, args: readonly string[] = []) => {
        if (command === "gh" && args[0] === "auth") {
          throw new Error("not logged in");
        }
        return execSuccess(command, args);
      }
    );

    const report = await runClaudePreflight(
      {
        cwd,
        env: { ANTHROPIC_API_KEY: "sk-test" },
        command: "claude",
        includeGhAuth: true,
      },
      { execFileSync: execFileSync as never }
    );

    const gh = report.checks.find((check) => check.id === "gh_authentication");
    expect(gh).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("gh auth status failed"),
      remediation: expect.stringContaining("gh auth login"),
    });
  });

  it("warns when .mcp.json is missing and fails when it is invalid JSON", async () => {
    const missingCwd = await mkdtemp(
      join(tmpdir(), "claude-preflight-mcp-missing-")
    );
    const missing = await runClaudePreflight(
      {
        cwd: missingCwd,
        env: { ANTHROPIC_API_KEY: "sk-test" },
        command: "claude",
      },
      { execFileSync: vi.fn(execSuccess) as never }
    );
    expect(
      missing.checks.find((check) => check.id === "claude_mcp_config")
    ).toMatchObject({ status: "warn" });

    const invalidCwd = await mkdtemp(
      join(tmpdir(), "claude-preflight-mcp-invalid-")
    );
    await writeFile(join(invalidCwd, ".mcp.json"), "{", "utf8");
    const invalid = await runClaudePreflight(
      {
        cwd: invalidCwd,
        env: { ANTHROPIC_API_KEY: "sk-test" },
        command: "claude",
      },
      { execFileSync: vi.fn(execSuccess) as never }
    );
    expect(
      invalid.checks.find((check) => check.id === "claude_mcp_config")
    ).toMatchObject({ status: "fail" });
  });

  it("accepts brokered Anthropic credentials", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "claude-preflight-broker-"));
    const report = await runClaudePreflight(
      {
        cwd,
        env: {
          AGENT_CREDENTIAL_BROKER_URL: "https://broker.test/agent",
          AGENT_CREDENTIAL_BROKER_SECRET: "secret",
        },
        command: "claude",
      },
      {
        execFileSync: vi.fn(execSuccess) as never,
        fetchImpl: vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ env: { ANTHROPIC_API_KEY: "sk-brokered" } }),
        })) as never,
      }
    );

    expect(
      report.checks.find((check) => check.id === "anthropic_api_key")
    ).toMatchObject({ status: "pass", details: { source: "broker" } });
  });

  it("formats readable output and detects shell-wrapped Claude commands", () => {
    expect(isClaudeRuntimeCommand("bash -lc 'claude -p'")).toBe(true);
    expect(isClaudeRuntimeCommand("/usr/local/bin/claude --print")).toBe(true);
    expect(isClaudeRuntimeCommand("./bin/claude-code --print")).toBe(true);
    expect(isClaudeRuntimeCommand("codex app-server")).toBe(false);
    expect(resolveClaudeCommandBinary("bash -lc 'claude -p'")).toBe("claude");
    expect(resolveClaudeCommandBinary("/usr/local/bin/claude --print")).toBe(
      "/usr/local/bin/claude"
    );
    expect(
      formatClaudePreflightText({
        ok: false,
        checks: [
          {
            id: "anthropic_api_key",
            title: "Anthropic API key",
            status: "fail",
            summary: "missing",
            remediation: "Set ANTHROPIC_API_KEY",
          },
        ],
      })
    ).toContain("FAIL Anthropic API key");
  });
});
