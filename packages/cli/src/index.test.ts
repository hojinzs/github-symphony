import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";
import {
  saveGlobalConfig,
  saveProjectConfig,
  type CliProjectConfig,
} from "./config.js";

function captureWrites(stream: NodeJS.WriteStream): {
  output: () => string;
  restore: () => void;
} {
  let buffer = "";
  const spy = vi.spyOn(stream, "write").mockImplementation(((
    chunk: string | Uint8Array
  ) => {
    buffer +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof stream.write);

  return {
    output: () => buffer,
    restore: () => spy.mockRestore(),
  };
}

function createProject(projectId: string): CliProjectConfig {
  return {
    projectId,
    slug: projectId,
    workspaceDir: join("/tmp", projectId),
    repositories: [
      {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
    ],
    tracker: {
      adapter: "github-project",
      bindingId: `${projectId}-binding`,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("Commander CLI entrypoint", () => {
  it("supports global options after subcommands", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-index-"));
    const stdout = captureWrites(process.stdout);

    await saveGlobalConfig(configDir, {
      activeProject: "tenant-a",
      projects: ["tenant-a"],
    });
    await saveProjectConfig(configDir, "tenant-a", createProject("tenant-a"));

    try {
      await runCli(["repo", "list", "--json", "--config", configDir]);
    } finally {
      stdout.restore();
    }

    const output = JSON.parse(stdout.output()) as Array<Record<string, string>>;
    expect(output).toEqual([
      {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
    ]);
  });

  it("prints JSON version output for global --version", async () => {
    const stdout = captureWrites(process.stdout);

    try {
      await runCli(["--json", "--version"]);
    } finally {
      stdout.restore();
    }

    expect(JSON.parse(stdout.output())).toEqual({
      version: expect.any(String),
    });
  });

  it("prints version even when --version follows a subcommand", async () => {
    const stdout = captureWrites(process.stdout);

    try {
      await runCli(["repo", "list", "--version"]);
    } finally {
      stdout.restore();
    }

    expect(stdout.output()).toContain("gh-symphony v");
  });

  it("prints completion scripts from the CLI", async () => {
    const stdout = captureWrites(process.stdout);

    try {
      await runCli(["completion", "bash"]);
    } finally {
      stdout.restore();
    }

    const output = stdout.output();
    expect(output).toContain("complete -F _gh_symphony_completion gh-symphony");
    expect(output).toContain("workflow doctor upgrade start stop status");
  });

  it("reports a missing root config argument", async () => {
    const stderr = captureWrites(process.stderr);

    try {
      await runCli(["--config"]);
    } finally {
      stderr.restore();
    }

    expect(process.exitCode).toBe(1);
    expect(stderr.output()).toContain("option '--config <dir>' argument missing");
  });

  it("falls back to root help when no command is provided", async () => {
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);

    try {
      await runCli([]);
    } finally {
      stdout.restore();
      stderr.restore();
    }

    const output = stdout.output() + stderr.output();
    expect(output).toContain("Usage: gh-symphony");
    expect(output).toContain("workflow");
    expect(output).toContain("doctor");
    expect(output).toContain("upgrade");
    expect(output).toContain("completion");
  });

  it("shows workflow init dry-run in command help", async () => {
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);

    try {
      await runCli(["workflow", "init", "--help"]);
    } finally {
      stdout.restore();
      stderr.restore();
    }

    const output = stdout.output() + stderr.output();
    expect(output).toContain("--dry-run");
    expect(output).toContain("--skip-skills");
    expect(output).toContain("--skip-context");
  });
});
