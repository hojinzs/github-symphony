import { mkdtemp, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();

  return {
    ...actual,
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    note: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    multiselect: vi.fn(),
    text: vi.fn(),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
    })),
    log: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      step: vi.fn(),
      success: vi.fn(),
      message: vi.fn(),
    },
  };
});

import * as p from "@clack/prompts";
import setupCommand from "./setup.js";
import * as ghAuth from "../github/gh-auth.js";
import * as githubClient from "../github/client.js";
import * as commandExists from "../utils/command-exists-on-path.js";

const MOCK_PROJECT_SUMMARY = {
  id: "PVT_setup_1",
  title: "Setup Project",
  owner: { login: "acme", type: "Organization" as const },
  openItemCount: 7,
  url: "https://github.com/orgs/acme/projects/1",
};

const MOCK_PROJECT_DETAIL = {
  id: "PVT_setup_1",
  title: "Setup Project",
  url: "https://github.com/orgs/acme/projects/1",
  statusFields: [
    {
      id: "status-field",
      name: "Status",
      options: [
        {
          id: "todo",
          name: "Todo",
          description: null,
          color: "GREEN" as string | null,
        },
        {
          id: "progress",
          name: "In Progress",
          description: null,
          color: "YELLOW" as string | null,
        },
        {
          id: "done",
          name: "Done",
          description: null,
          color: "PURPLE" as string | null,
        },
      ],
    },
  ],
  textFields: [],
  linkedRepositories: [
    {
      owner: "acme",
      name: "repo-a",
      url: "https://github.com/acme/repo-a",
      cloneUrl: "https://github.com/acme/repo-a.git",
    },
    {
      owner: "acme",
      name: "repo-b",
      url: "https://github.com/acme/repo-b",
      cloneUrl: "https://github.com/acme/repo-b.git",
    },
  ],
};

const MOCK_PROJECT_DETAIL_WITH_AMBIGUOUS_PRIORITY = {
  ...MOCK_PROJECT_DETAIL,
  statusFields: [
    ...MOCK_PROJECT_DETAIL.statusFields,
    {
      id: "priority-team",
      name: "Priority (Team)",
      options: [
        {
          id: "p1",
          name: "P1",
          description: null,
          color: "RED" as string | null,
        },
      ],
    },
    {
      id: "priority-severity",
      name: "Priority (Severity)",
      options: [
        {
          id: "high",
          name: "High",
          description: null,
          color: "ORANGE" as string | null,
        },
      ],
    },
  ],
};

function initializeGitRemote(
  cwd: string,
  remote = "https://github.com/acme/repo-a.git"
): void {
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], {
    cwd,
    stdio: "ignore",
  });
}

describe("setup command", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    vi.mocked(p.intro).mockImplementation(() => undefined);
    vi.mocked(p.outro).mockImplementation(() => undefined);
    vi.mocked(p.cancel).mockImplementation(() => undefined);
    vi.mocked(p.note).mockImplementation(() => undefined);
    vi.mocked(p.spinner).mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn(),
    }));
    vi.mocked(p.log.error).mockImplementation(() => undefined);
    vi.mocked(p.log.warn).mockImplementation(() => undefined);
    vi.mocked(p.log.info).mockImplementation(() => undefined);
    vi.spyOn(ghAuth, "getGhToken").mockReturnValue("token");
    vi.spyOn(ghAuth, "ensureGhAuth").mockReturnValue({
      login: "moncher-dev",
      token: "token",
    });
    vi.spyOn(githubClient, "createClient").mockReturnValue({} as never);
    vi.spyOn(githubClient, "validateToken").mockResolvedValue({
      login: "moncher-dev",
      scopes: ["repo", "read:org", "project"],
    });
    vi.spyOn(githubClient, "listUserProjects").mockResolvedValue([
      MOCK_PROJECT_SUMMARY,
    ]);
    vi.spyOn(githubClient, "getProjectDetail").mockResolvedValue(
      MOCK_PROJECT_DETAIL
    );
    vi.spyOn(commandExists, "commandExistsOnPath").mockResolvedValue(true);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
  });

  it("reports removed project/workspace setup flags with migration guidance", async () => {
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await setupCommand(["--project", "PVT_removed"], {
      configDir: "/tmp/unused",
      verbose: false,
      json: false,
      noColor: true,
    });

    expect(process.exitCode).toBe(2);
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining(
        "Removed project/workspace flags are no longer supported"
      )
    );
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining(
        "Supported flags: --non-interactive, --output, --runtime, --skip-skills. Deprecated no-op: --skip-context."
      )
    );
  });

  it.each([
    [
      "not_installed",
      "gh CLI is not installed.",
      "Install gh CLI from https://cli.github.com or set GITHUB_GRAPHQL_TOKEN.",
      false,
    ],
    [
      "not_authenticated",
      "gh CLI is not authenticated.",
      "Run 'gh auth login --scopes repo,read:org,project', then re-run 'gh-symphony setup'.",
      true,
    ],
    [
      "missing_scopes",
      "Run 'gh auth refresh --scopes repo,read:org,project'. Missing scopes: project",
      "Run 'gh auth refresh --scopes project', then re-run 'gh-symphony setup'.",
      true,
    ],
    [
      "invalid_token",
      "GITHUB_GRAPHQL_TOKEN is invalid or expired.",
      "Run 'gh auth login --scopes repo,read:org,project' to re-authenticate, then re-run 'gh-symphony setup'.",
      true,
    ],
    [
      "token_failed",
      "gh CLI token could not be validated.",
      "Run 'gh auth login --scopes repo,read:org,project' to re-authenticate, then re-run 'gh-symphony setup'.",
      true,
    ],
  ] as const)(
    "reports shared English gh auth remediation for interactive setup %s failures",
    async (code, message, expectedHint, expectsRetryCommand) => {
      vi.mocked(ghAuth.ensureGhAuth).mockImplementation(() => {
        throw new ghAuth.GhAuthError(code, message, {
          missingScopes: code === "missing_scopes" ? ["project"] : undefined,
          currentScopes:
            code === "missing_scopes" ? ["repo", "read:org"] : undefined,
        });
      });

      await setupCommand([], {
        configDir: "/tmp/unused",
        verbose: false,
        json: false,
        noColor: true,
      });

      const errorOutput = vi
        .mocked(p.log.error)
        .mock.calls.map(([line]) => line)
        .join("\n");

      expect(errorOutput).toContain(message);
      expect(errorOutput).toContain(expectedHint);
      if (expectsRetryCommand) {
        expect(errorOutput).toContain("gh-symphony setup");
      }
      expect(errorOutput).not.toMatch(/[가-힣]/);
      expect(p.select).not.toHaveBeenCalled();
      expect(githubClient.listUserProjects).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    }
  );

  it("writes workflow files and managed-project config in non-interactive mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "setup-non-interactive-cwd-"));
    const configDir = await mkdtemp(
      join(tmpdir(), "setup-non-interactive-config-")
    );
    initializeGitRemote(cwd);
    process.chdir(cwd);

    await setupCommand(["--non-interactive"], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    const workflow = await readFile(join(cwd, "WORKFLOW.md"), "utf8");
    const project = JSON.parse(
      await readFile(
        join(cwd, ".runtime", "orchestrator", "project.json"),
        "utf8"
      )
    );

    expect(workflow).toContain("project_id: PVT_setup_1");
    expect(workflow).toContain("source: disabled");
    expect(workflow).toContain(
      "# Optional template: project-field priority source."
    );
    expect(workflow).toContain("# Optional template: labels priority source.");
    expect(workflow).not.toContain("priority_field:");
    await expect(
      readFile(join(cwd, ".gh-symphony", "context.yaml"), "utf8")
    ).rejects.toThrow();
    expect(project.projectId).toBe("repository");
    expect(project.workspaceDir).toBe(process.cwd());
    expect(project.repository).toMatchObject({
      owner: "acme",
      name: "repo-a",
    });
    expect(project).not.toHaveProperty("repositories");
  });

  it("writes Claude runtime config from non-interactive --runtime claude-code", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "setup-non-interactive-claude-"));
    const configDir = await mkdtemp(
      join(tmpdir(), "setup-non-interactive-claude-config-")
    );
    initializeGitRemote(cwd);
    process.chdir(cwd);
    vi.mocked(commandExists.commandExistsOnPath).mockResolvedValueOnce(false);

    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await setupCommand(["--non-interactive", "--runtime", "claude-code"], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    const workflow = await readFile(join(cwd, "WORKFLOW.md"), "utf8");
    const stdout = stdoutWrite.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");

    expect(workflow).toContain("kind: claude-print");
    expect(workflow).toContain("command: claude");
    expect(stdout).toContain("Agent runtime    claude-print");
    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Selected runtime 'claude-print' requires the 'claude' command"
      )
    );
  });

  it("keeps non-interactive JSON setup output parseable when the runtime is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "setup-json-runtime-cwd-"));
    const configDir = await mkdtemp(
      join(tmpdir(), "setup-json-runtime-config-")
    );
    initializeGitRemote(cwd);
    process.chdir(cwd);
    vi.mocked(commandExists.commandExistsOnPath).mockResolvedValueOnce(false);

    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await setupCommand(["--non-interactive", "--runtime", "claude-code"], {
      configDir,
      verbose: false,
      json: true,
      noColor: true,
    });

    const stdout = stdoutWrite.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");

    expect(JSON.parse(stdout)).toMatchObject({
      status: "created",
      runtime: "claude-print",
    });
    expect(p.log.warn).not.toHaveBeenCalled();
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining(
        "Warning: Selected runtime 'claude-print' requires the 'claude' command"
      )
    );
  });

  it("rejects unsupported setup runtime presets", async () => {
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await setupCommand(["--non-interactive", "--runtime", "claud-print"], {
      configDir: "/tmp/unused",
      verbose: false,
      json: false,
      noColor: true,
    });

    expect(process.exitCode).toBe(1);
    expect(stderrWrite).toHaveBeenCalledWith(
      "Error: Unsupported runtime 'claud-print'. Choose one of: codex-app-server, claude-print.\n"
    );
    expect(githubClient.listUserProjects).not.toHaveBeenCalled();
  });

  it("shows a final summary and writes the selected repositories in interactive mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "setup-interactive-cwd-"));
    const configDir = await mkdtemp(
      join(tmpdir(), "setup-interactive-config-")
    );
    initializeGitRemote(cwd, "https://github.com/acme/repo-b.git");
    process.chdir(cwd);

    vi.mocked(p.select)
      .mockResolvedValueOnce("codex-app-server" as never)
      .mockResolvedValueOnce(MOCK_PROJECT_SUMMARY.id as never)
      .mockResolvedValueOnce("wait" as never)
      .mockResolvedValueOnce("active" as never)
      .mockResolvedValueOnce("terminal" as never)
      .mockResolvedValueOnce("disabled" as never);
    vi.mocked(p.confirm)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(true as never);
    await setupCommand([], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    const project = JSON.parse(
      await readFile(
        join(cwd, ".runtime", "orchestrator", "project.json"),
        "utf8"
      )
    );

    expect(project.workspaceDir).toBe(process.cwd());
    expect(project.repository?.name).toBe("repo-b");
    expect(p.note).toHaveBeenCalledWith(
      expect.stringContaining("Init dry-run preview"),
      "Final summary"
    );
    expect(p.note).toHaveBeenCalledWith(
      expect.stringContaining("Repository:     current working directory"),
      "Final summary"
    );
    expect(p.outro).toHaveBeenCalledWith(
      expect.stringContaining(
        "Repository runtime is ready for codex-app-server."
      )
    );
    const selectMessages = vi
      .mocked(p.select)
      .mock.calls.map(([input]) => input.message);
    expect(selectMessages).toEqual(
      expect.arrayContaining([
        "Step 1/5 — Select the agent runtime:",
        "Step 2/5 — Select a GitHub Project board:",
        expect.stringContaining("Step 3/5 — Map column"),
        expect.stringContaining("Step 5/5 — Choose one priority source:"),
      ])
    );
    expect(vi.mocked(p.confirm).mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringContaining("Step 4/5 — Enable blocker check?"),
    });
  });

  it("validates state mappings before prompting for blocker checks", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "setup-invalid-mapping-cwd-"));
    const configDir = await mkdtemp(
      join(tmpdir(), "setup-invalid-mapping-config-")
    );
    initializeGitRemote(cwd);
    process.chdir(cwd);

    vi.mocked(p.select)
      .mockResolvedValueOnce("codex-app-server" as never)
      .mockResolvedValueOnce(MOCK_PROJECT_SUMMARY.id as never)
      .mockResolvedValueOnce("wait" as never)
      .mockResolvedValueOnce("wait" as never)
      .mockResolvedValueOnce("wait" as never);

    await setupCommand([], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    expect(process.exitCode).toBe(1);
    expect(p.log.error).toHaveBeenCalledWith("Mapping validation failed:");
    expect(p.confirm).not.toHaveBeenCalled();
    expect(p.multiselect).not.toHaveBeenCalled();
  });

  it("lets interactive setup map existing repository labels as the priority source", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "setup-interactive-labels-cwd-"));
    const configDir = await mkdtemp(
      join(tmpdir(), "setup-interactive-labels-config-")
    );
    initializeGitRemote(cwd);
    process.chdir(cwd);

    vi.spyOn(githubClient, "listRepositoryLabels").mockResolvedValue([
      { name: "priority: p0", color: "ff0000", description: null },
      { name: "priority: p1", color: "ffaa00", description: null },
    ]);
    vi.mocked(p.select)
      .mockResolvedValueOnce("codex-app-server" as never)
      .mockResolvedValueOnce(MOCK_PROJECT_SUMMARY.id as never)
      .mockResolvedValueOnce("wait" as never)
      .mockResolvedValueOnce("active" as never)
      .mockResolvedValueOnce("terminal" as never)
      .mockResolvedValueOnce("labels" as never);
    vi.mocked(p.multiselect).mockResolvedValueOnce([
      "priority: p0",
      "priority: p1",
    ] as never);
    vi.mocked(p.text)
      .mockResolvedValueOnce("0" as never)
      .mockResolvedValueOnce("1" as never);
    vi.mocked(p.confirm)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(true as never);

    await setupCommand([], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    const workflow = await readFile(join(cwd, "WORKFLOW.md"), "utf8");
    expect(workflow).toContain("source: labels");
    expect(workflow).toContain('"priority: p0": 0');
    expect(workflow).toContain('"priority: p1": 1');
    expect(workflow).not.toContain("priority_field:");
  });

  it("warns and writes disabled priority scaffold in non-interactive mode when priority fields are ambiguous", async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), "setup-non-interactive-priority-cwd-")
    );
    const configDir = await mkdtemp(
      join(tmpdir(), "setup-non-interactive-priority-config-")
    );
    initializeGitRemote(cwd);
    process.chdir(cwd);

    vi.spyOn(githubClient, "getProjectDetail").mockResolvedValue(
      MOCK_PROJECT_DETAIL_WITH_AMBIGUOUS_PRIORITY
    );
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await setupCommand(["--non-interactive"], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    const workflow = await readFile(join(cwd, "WORKFLOW.md"), "utf8");

    expect(stderrWrite).toHaveBeenCalledWith(
      'Warning: Multiple priority-like single-select fields found ("Priority (Team)", "Priority (Severity)"). Writing disabled priority scaffold in non-interactive mode.\n'
    );
    expect(workflow).not.toContain("priority_field:");
    expect(workflow).toContain("source: disabled");
    expect(workflow).toContain(
      "# Optional template: project-field priority source."
    );
    expect(workflow).toContain("# Optional template: labels priority source.");
  });

  it("rejects the removed --assigned-only setup flag", async () => {
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await setupCommand(["--assigned-only"], {
      configDir: "/tmp/unused",
      verbose: false,
      json: false,
      noColor: true,
    });

    expect(process.exitCode).toBe(2);
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("Unknown option '--assigned-only'")
    );
  });

  it("does not prompt for or persist assigned-only during interactive setup", async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), "setup-interactive-assigned-cwd-")
    );
    const configDir = await mkdtemp(
      join(tmpdir(), "setup-interactive-assigned-config-")
    );
    initializeGitRemote(cwd);
    process.chdir(cwd);

    vi.mocked(p.select)
      .mockResolvedValueOnce("codex-app-server" as never)
      .mockResolvedValueOnce(MOCK_PROJECT_SUMMARY.id as never)
      .mockResolvedValueOnce("wait" as never)
      .mockResolvedValueOnce("active" as never)
      .mockResolvedValueOnce("terminal" as never)
      .mockResolvedValueOnce("disabled" as never);
    vi.mocked(p.confirm)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(true as never);

    await setupCommand([], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    const project = JSON.parse(
      await readFile(
        join(cwd, ".runtime", "orchestrator", "project.json"),
        "utf8"
      )
    );

    expect(project.tracker.settings?.assignedOnly).toBeUndefined();
    expect(vi.mocked(p.confirm)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(p.confirm).mock.calls[1]?.[0]).toMatchObject({
      message: "Write files and register this managed project?",
    });
  });
});
