import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGlobalOptions, runCli } from "./index.js";
import { standaloneProjectId } from "./commands/project.js";
import { saveProjectConfig, type CliProjectConfig } from "./config.js";

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
    repository: {
      owner: "acme",
      name: "platform",
      cloneUrl: "https://github.com/acme/platform.git",
    },
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
  it("marks explicit config sources as config overrides", () => {
    const originalConfigDir = process.env.GH_SYMPHONY_CONFIG_DIR;

    try {
      delete process.env.GH_SYMPHONY_CONFIG_DIR;
      expect(
        resolveGlobalOptions({ config: "/tmp/from-config" }).configDirOverride
      ).toBe(true);
      expect(
        resolveGlobalOptions({ config: "/tmp/from-config" })
      ).toMatchObject({
        configDir: "/tmp/from-config",
        configDirOverride: true,
        configDirSource: "cli",
      });
      expect(
        resolveGlobalOptions({ configDir: "/tmp/from-config-dir" })
          .configDirOverride
      ).toBe(true);
      // An explicit --config is exported to the environment so child processes
      // and the shared bare-clone cache resolve the same directory. Clear it
      // again before asserting the unset-environment defaults.
      delete process.env.GH_SYMPHONY_CONFIG_DIR;
      expect(resolveGlobalOptions({}).configDirOverride).toBe(false);
      expect(resolveGlobalOptions({}).configDirSource).toBe("default");

      process.env.GH_SYMPHONY_CONFIG_DIR = "/tmp/from-env";
      expect(resolveGlobalOptions({}).configDirOverride).toBe(true);
      expect(resolveGlobalOptions({}).configDir).toBe("/tmp/from-env");
      expect(resolveGlobalOptions({}).configDirSource).toBe("env");

      process.env.GH_SYMPHONY_CONFIG_DIR = "/var/lib/gh-symphony";
      expect(resolveGlobalOptions({}).configDirOverride).toBe(false);
      expect(resolveGlobalOptions({}).configDir).toBe("/var/lib/gh-symphony");
      expect(resolveGlobalOptions({}).configDirSource).toBe("env");
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.GH_SYMPHONY_CONFIG_DIR;
      } else {
        process.env.GH_SYMPHONY_CONFIG_DIR = originalConfigDir;
      }
    }
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

  it.each([
    ["init"],
    ["start", "--daemon"],
    ["stop"],
    ["status"],
    ["run", "owner/repo#1"],
    ["recover"],
    ["logs"],
    ["explain", "owner/repo#1"],
    ["anything"],
    ["--help"],
  ])(
    "retires repo %s with the project migration instruction",
    async (...args) => {
      const stderr = captureWrites(process.stderr);
      try {
        await runCli(["repo", ...args]);
      } finally {
        stderr.restore();
      }

      expect(process.exitCode).toBe(2);
      expect(stderr.output()).toBe(
        "The 'repo' command has been removed. Use 'gh-symphony project start --project-dir <path>'.\n" +
          "Migration: packages/cli/README.md#repository-command-migration\n"
      );
    }
  );

  it("prints completion scripts from the CLI", async () => {
    const stdout = captureWrites(process.stdout);

    try {
      await runCli(["completion", "bash"]);
    } finally {
      stdout.restore();
    }

    const output = stdout.output();
    expect(output).toContain("complete -F _gh_symphony_completion gh-symphony");
    expect(output).toContain("workflow setup doctor upgrade project");
  });

  it.each([
    [["init"], "Use 'gh-symphony workflow init'."],
    [["start"], "Use 'gh-symphony project start --project-dir <path>'."],
    [["stop"], "Use 'gh-symphony project stop --project-dir <path>'."],
    [["status"], "Use 'gh-symphony project status --project-dir <path>'."],
    [
      ["run", "owner/repo#1"],
      "The 'run' command has been removed. See packages/cli/README.md#repository-command-migration.",
    ],
    [
      ["recover"],
      "The 'recover' command has been removed. See packages/cli/README.md#repository-command-migration.",
    ],
    [
      ["logs"],
      "The 'logs' command has been removed. See packages/cli/README.md#repository-command-migration.",
    ],
  ])(
    "reports the migration path for removed top-level command %s",
    async (args, message) => {
      const stderr = captureWrites(process.stderr);

      try {
        await runCli(args);
      } finally {
        stderr.restore();
      }

      expect(stderr.output()).toBe(`${message}\n`);
      expect(process.exitCode).toBe(2);
    }
  );

  it("reports a missing root config argument", async () => {
    const stderr = captureWrites(process.stderr);

    try {
      await runCli(["--config"]);
    } finally {
      stderr.restore();
    }

    expect(process.exitCode).toBe(1);
    expect(stderr.output()).toContain(
      "option '--config <dir>' argument missing"
    );
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
    expect(output).toContain("gh-symphony — AI Coding Agent Orchestrator");
    expect(output).toContain("Setup:");
    expect(output).toContain("workflow init");
    expect(output).toContain("setup");
    expect(output).toContain("doctor");
    expect(output).toContain("upgrade");
    expect(output).toContain("completion");
    expect(output).not.toContain("\n  init ");
    expect(output).not.toContain("\n  start ");
    expect(output).not.toContain("\n  stop ");
    expect(output).not.toContain("\n  status ");
    expect(output).not.toContain("\n  run ");
    expect(output).not.toContain("\n  recover ");
    expect(output).not.toContain("\n  logs ");
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

  it("shows standalone project runtime options in command help", async () => {
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);

    try {
      await runCli(["project", "start", "--help"]);
    } finally {
      stdout.restore();
      stderr.restore();
    }

    const output = stdout.output() + stderr.output();
    expect(output).toContain("--daemon");
    expect(output).toContain("--once");
    expect(output).toContain("--assigned-only");
    expect(output).not.toContain("--allow-duplicate");
    expect(output).toContain("--bind-all");
    expect(output).toContain("--port [port]");
    expect(output).toContain("--http [port]");
    expect(output).toContain("--web [port]");
    expect(output).toContain("--log-level <level>");
    expect(output).toContain("--project-dir <path>");
  });

  it("guides users of the removed instances command", async () => {
    const stderr = captureWrites(process.stderr);

    try {
      await runCli(["instances"]);
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toContain(
      "Use 'gh-symphony project list' and 'gh-symphony project status --project-dir <path>'."
    );
    expect(process.exitCode).toBe(2);
  });

  it("rejects misspelled standalone project runtime options", async () => {
    const stderr = captureWrites(process.stderr);

    try {
      await runCli(["project", "start", "--asigned-only"]);
    } finally {
      stderr.restore();
    }

    expect(process.exitCode).toBe(1);
    expect(stderr.output()).toContain("unknown option '--asigned-only'");
  });

  it("does not treat inherited property names as namespace commands", async () => {
    const stderr = captureWrites(process.stderr);

    try {
      await runCli(["toString", "foo"]);
    } finally {
      stderr.restore();
    }

    expect(process.exitCode).toBe(1);
    expect(stderr.output()).toContain("unknown command 'toString'");
  });

  it.each([
    [["project"], undefined, undefined],
    [["project", "add", "./somewhere"], "stderr", "unknown command 'add'"],
  ])("reports project command usage for %s", async (argv, stream, message) => {
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);

    try {
      await runCli(argv);
    } finally {
      stdout.restore();
      stderr.restore();
    }

    expect(process.exitCode).toBe(1);
    if (stream && message) {
      expect(stream === "stdout" ? stdout.output() : stderr.output()).toContain(
        message
      );
    }
    process.exitCode = undefined;
  });

  it("shows doctor remediation help", async () => {
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);

    try {
      await runCli(["doctor", "--help"]);
    } finally {
      stdout.restore();
      stderr.restore();
    }

    const output = stdout.output() + stderr.output();
    expect(output).toContain("--fix");
    expect(output).toContain("--smoke");
    expect(output).toContain("--bundle");
    expect(output).toContain("--issue");
    expect(output).toContain("--project-dir");
    expect(output).toContain("remediation");
  });

  it("forwards doctor --project-dir through the Commander entrypoint", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-doctor-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-doctor-project-"));
    const projectId = standaloneProjectId(projectDir);
    await saveProjectConfig(configDir, projectId, {
      ...createProject(projectId),
      projectDir,
      workflowSource: {
        type: "external",
        path: join(projectDir, "WORKFLOW.md"),
      },
    });
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);

    try {
      await runCli([
        "doctor",
        "--project-dir",
        projectDir,
        "--config",
        configDir,
        "--json",
      ]);
    } finally {
      stdout.restore();
      stderr.restore();
    }

    expect(JSON.parse(stdout.output())).toMatchObject({ projectId });
  }, 15_000);
});

describe("config directory export", () => {
  const originalConfigDir = process.env.GH_SYMPHONY_CONFIG_DIR;

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.GH_SYMPHONY_CONFIG_DIR;
    } else {
      process.env.GH_SYMPHONY_CONFIG_DIR = originalConfigDir;
    }
  });

  it("exports an explicit --config directory so the bare cache honors it", () => {
    delete process.env.GH_SYMPHONY_CONFIG_DIR;

    const options = resolveGlobalOptions({ config: "/tmp/symphony-config" });

    expect(options.configDir).toBe("/tmp/symphony-config");
    expect(process.env.GH_SYMPHONY_CONFIG_DIR).toBe("/tmp/symphony-config");
  });

  it("leaves the environment untouched when no override is given", () => {
    delete process.env.GH_SYMPHONY_CONFIG_DIR;

    resolveGlobalOptions({});

    expect(process.env.GH_SYMPHONY_CONFIG_DIR).toBeUndefined();
  });
});
