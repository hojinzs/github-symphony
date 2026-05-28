import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
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
import type { CliProjectConfig } from "../config.js";
import * as ghAuth from "../github/gh-auth.js";
import * as githubClient from "../github/client.js";
import {
  DEFAULT_AFTER_CREATE_HOOK_CONTENT,
  DEFAULT_AFTER_CREATE_HOOK_LABEL,
  DEFAULT_AFTER_CREATE_HOOK_PATH,
} from "../workflow/default-hooks.js";
import initCommand from "./workflow-init.js";
import {
  buildDryRunJsonResult,
  generateProjectId,
  planWorkflowArtifacts,
  planEcosystem,
  promptLegacyGhSymphonyCleanup,
  promptBlockerCheck,
  promptPriorityConfig,
  renderDryRunPreview,
  writeConfig,
  writeEcosystem,
} from "./workflow-init.js";

function mockSpinner() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
  };
}

const originalPath = process.env.PATH;

describe("init interactive auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(p.intro).mockImplementation(() => undefined);
    vi.mocked(p.outro).mockImplementation(() => undefined);
    vi.mocked(p.cancel).mockImplementation(() => undefined);
    vi.mocked(p.note).mockImplementation(() => undefined);
    vi.mocked(p.select).mockResolvedValue("codex-app-server" as never);
    vi.mocked(p.spinner).mockImplementation(mockSpinner);
    vi.mocked(p.log.error).mockImplementation(() => undefined);
    vi.mocked(p.log.warn).mockImplementation(() => undefined);
    vi.mocked(p.log.info).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env.PATH = originalPath;
    process.exitCode = undefined;
  });

  it("reports env auth usage before loading projects", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-init-env-auth-"));
    const authSpinner = mockSpinner();
    vi.mocked(p.spinner)
      .mockReturnValueOnce(authSpinner as never)
      .mockImplementation(mockSpinner);
    vi.spyOn(ghAuth, "resolveGitHubAuth").mockResolvedValue({
      source: "env",
      login: "env-user",
      token: "env-token",
      scopes: ["repo", "read:org", "project"],
    });
    const ensureSpy = vi.spyOn(ghAuth, "ensureGhAuth");
    vi.spyOn(githubClient, "createClient").mockReturnValue({} as never);
    vi.spyOn(githubClient, "discoverUserProjects").mockResolvedValue({
      projects: [],
      partial: false,
      reason: null,
      requests: 1,
    });

    await initCommand([], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    expect(ensureSpy).not.toHaveBeenCalled();
    expect(authSpinner.start).toHaveBeenCalledWith(
      "Checking GitHub authentication..."
    );
    expect(authSpinner.stop).toHaveBeenCalledWith(
      "Authenticated via GITHUB_GRAPHQL_TOKEN as env-user"
    );
    expect(p.log.error).toHaveBeenCalledWith(
      "No GitHub Projects found. Create a project at https://github.com/orgs/YOUR_ORG/projects and re-run."
    );
  });

  it("warns when project discovery hits a safety limit", async () => {
    const configDir = await mkdtemp(
      join(tmpdir(), "cli-init-partial-projects-")
    );
    vi.spyOn(ghAuth, "resolveGitHubAuth").mockResolvedValue({
      source: "env",
      login: "env-user",
      token: "env-token",
      scopes: ["repo", "read:org", "project"],
    });
    vi.spyOn(githubClient, "createClient").mockReturnValue({} as never);
    vi.spyOn(githubClient, "discoverUserProjects").mockResolvedValue({
      projects: [],
      partial: true,
      reason: "request_limit",
      requests: 40,
    });

    await initCommand([], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    expect(p.log.warn).toHaveBeenCalledWith(
      "Project discovery may be incomplete: the GitHub API request budget reached the safety cap. Showing 0 discovered projects after 40 requests."
    );
  });
});

describe("promptBlockerCheck", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(p.confirm).mockReset();
    vi.mocked(p.multiselect).mockReset();
    vi.mocked(p.log.info).mockImplementation(() => undefined);
    vi.mocked(p.log.warn).mockImplementation(() => undefined);
  });

  it("returns the single active state when enabled", async () => {
    vi.mocked(p.confirm).mockResolvedValueOnce(true as never);

    await expect(
      promptBlockerCheck({ activeStates: ["In Progress"] })
    ).resolves.toEqual(["In Progress"]);
    expect(p.multiselect).not.toHaveBeenCalled();
  });

  it("defaults a multi-select to the first active state", async () => {
    vi.mocked(p.confirm).mockResolvedValueOnce(true as never);
    vi.mocked(p.multiselect).mockResolvedValueOnce(["Todo"] as never);

    await expect(
      promptBlockerCheck({ activeStates: ["Todo", "진행 중"] })
    ).resolves.toEqual(["Todo"]);
    expect(p.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValues: ["Todo"],
        options: expect.arrayContaining([
          expect.objectContaining({ value: "Todo" }),
          expect.objectContaining({ value: "진행 중" }),
        ]),
      })
    );
  });

  it("returns an empty list when disabled or no active states exist", async () => {
    vi.mocked(p.confirm).mockResolvedValueOnce(false as never);

    await expect(
      promptBlockerCheck({ activeStates: ["Todo"] })
    ).resolves.toEqual([]);
    await expect(promptBlockerCheck({ activeStates: [] })).resolves.toEqual([]);
    expect(p.log.warn).toHaveBeenCalledWith(
      "No active states; blocker check cannot be enabled."
    );
  });
});

describe("init command config output", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("rejects unsupported runtime presets in non-interactive mode", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true as never);

    await initCommand(["--non-interactive", "--runtime", "claud-print"], {
      configDir: await mkdtemp(join(tmpdir(), "cli-init-runtime-invalid-")),
      verbose: false,
      json: false,
      noColor: true,
    });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      "Error: Unsupported runtime 'claud-print'. Choose one of: codex-app-server, claude-print.\n"
    );
  });

  it("writes the simplified project config", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-init-"));

    await writeConfig(configDir, {
      projectId: "tenant-alpha",
      project: {
        id: "project-123",
        title: "Platform",
        url: "https://github.com/orgs/acme/projects/1",
        statusFields: [],
        textFields: [],
        linkedRepositories: [],
      },
      repos: [
        {
          owner: "acme",
          name: "platform",
          url: "https://github.com/acme/platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
      ],
      workspaceDir: join(configDir, "workspaces"),
    });

    const project = JSON.parse(
      await readFile(
        join(configDir, "projects", "tenant-alpha", "project.json"),
        "utf8"
      )
    ) as CliProjectConfig;
    expect(project.workspaceDir).toBe(join(configDir, "workspaces"));
    expect(project.displayName).toBe("Platform");
    expect(project).not.toHaveProperty("runtime");
    await expect(
      readFile(
        join(configDir, "projects", "tenant-alpha", "workflow-mapping.json"),
        "utf8"
      )
    ).rejects.toThrow();
    await expect(
      readFile(
        join(configDir, "projects", "tenant-alpha", "WORKFLOW.md"),
        "utf8"
      )
    ).rejects.toThrow();
  });

  it("does not persist assignedOnly into project tracker settings", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-init-assigned-"));

    await writeConfig(configDir, {
      projectId: "tenant-assigned",
      project: {
        id: "project-123",
        title: "Platform",
        url: "https://github.com/orgs/acme/projects/1",
        statusFields: [],
        textFields: [],
        linkedRepositories: [],
      },
      repos: [
        {
          owner: "acme",
          name: "platform",
          url: "https://github.com/acme/platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
      ],
      workspaceDir: join(configDir, "workspaces"),
    });

    const project = JSON.parse(
      await readFile(
        join(configDir, "projects", "tenant-assigned", "project.json"),
        "utf8"
      )
    ) as CliProjectConfig;

    expect(project.tracker.settings?.assignedOnly).toBeUndefined();
    expect(project.tracker.settings?.projectId).toBe("project-123");
  });

  it("derives unique project IDs from the project identity, not only the title", () => {
    expect(generateProjectId("Roadmap", "project-a")).not.toBe(
      generateProjectId("Roadmap", "project-b")
    );
  });
});

describe("init priority field detection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(p.intro).mockImplementation(() => undefined);
    vi.mocked(p.outro).mockImplementation(() => undefined);
    vi.mocked(p.cancel).mockImplementation(() => undefined);
    vi.mocked(p.note).mockImplementation(() => undefined);
    vi.mocked(p.spinner).mockImplementation(mockSpinner);
    vi.mocked(p.log.error).mockImplementation(() => undefined);
    vi.mocked(p.log.warn).mockImplementation(() => undefined);
    vi.mocked(p.log.info).mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    process.exitCode = undefined;
  });

  it("adds explicit project-field priority mapping during non-interactive dry-run when Priority exists", async () => {
    const configDir = await mkdtemp(
      join(tmpdir(), "cli-init-priority-nonint-")
    );
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockReturnValue(true as never);
    vi.spyOn(ghAuth, "getGhTokenWithSource").mockReturnValue({
      token: "test-token",
      source: "gh",
    });
    vi.spyOn(githubClient, "createClient").mockReturnValue({} as never);
    vi.spyOn(githubClient, "validateToken").mockResolvedValue({
      login: "tester",
      name: "Tester",
      scopes: ["repo", "read:org", "project"],
    });
    vi.spyOn(githubClient, "listUserProjects").mockResolvedValue([
      {
        id: "project-1",
        title: "Roadmap",
        shortDescription: "",
        url: "https://github.com/users/tester/projects/1",
        openItemCount: 3,
        owner: { login: "tester", type: "User" },
      },
    ]);
    vi.spyOn(githubClient, "getProjectDetail").mockResolvedValue({
      ...MOCK_PROJECT_DETAIL,
      id: "project-1",
      statusFields: [MOCK_STATUS_FIELD, MOCK_PRIORITY_FIELD],
    });

    await initCommand(
      [
        "--non-interactive",
        "--dry-run",
        "--output",
        join(configDir, "WORKFLOW.md"),
      ],
      {
        configDir,
        verbose: false,
        json: true,
        noColor: true,
      }
    );

    const payload = JSON.parse(
      stdout.mock.calls.map(([chunk]) => String(chunk)).join("")
    ) as {
      priority: {
        source: string;
        field?: string;
        values?: Record<string, number>;
      };
    };
    expect(payload.priority).toEqual({
      source: "project-field",
      field: "Priority",
      values: {
        P0: 0,
        P1: 1,
      },
    });
  });

  it("allows Claude preflight for init --runtime claude-code with local auth", async () => {
    const configDir = await mkdtemp(
      join(tmpdir(), "cli-init-claude-preflight-")
    );
    const binDir = join(configDir, "bin");
    await mkdir(binDir, { recursive: true });
    const claude = join(binDir, "claude");
    await writeFile(
      claude,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo \'claude 1.0.0\'; fi\n',
      "utf8"
    );
    await chmod(claude, 0o755);
    const gh = join(binDir, "gh");
    await writeFile(gh, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(gh, 0o755);
    process.env.PATH = `${binDir}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;

    vi.spyOn(ghAuth, "getGhTokenWithSource").mockReturnValue({
      token: "test-token",
      source: "gh",
    });
    vi.spyOn(githubClient, "createClient").mockReturnValue({} as never);
    vi.spyOn(githubClient, "validateToken").mockResolvedValue({
      login: "tester",
      name: "Tester",
      scopes: ["repo", "read:org", "project"],
    });
    vi.spyOn(githubClient, "listUserProjects").mockResolvedValue([
      {
        id: "project-1",
        title: "Roadmap",
        shortDescription: "",
        url: "https://github.com/users/tester/projects/1",
        openItemCount: 3,
        owner: { login: "tester", type: "User" },
      },
    ]);
    vi.spyOn(githubClient, "getProjectDetail").mockResolvedValue({
      ...MOCK_PROJECT_DETAIL,
      id: "project-1",
      statusFields: [MOCK_STATUS_FIELD],
    });

    await initCommand(
      [
        "--non-interactive",
        "--dry-run",
        "--runtime",
        "claude-code",
        "--output",
        join(configDir, "WORKFLOW.md"),
      ],
      {
        configDir,
        verbose: false,
        json: false,
        noColor: true,
      }
    );

    expect(process.exitCode).toBeUndefined();
    expect(p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("WARN Claude authentication")
    );
    expect(p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Claude Code local login")
    );
  });

  it("prompts for a priority field when multiple priority-like fields are present", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-init-priority-int-"));
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockReturnValue(true as never);
    vi.spyOn(ghAuth, "resolveGitHubAuth").mockResolvedValue({
      source: "env",
      login: "env-user",
      token: "env-token",
      scopes: ["repo", "read:org", "project"],
    });
    vi.spyOn(githubClient, "createClient").mockReturnValue({} as never);
    vi.spyOn(githubClient, "discoverUserProjects").mockResolvedValue({
      projects: [
        {
          id: "project-1",
          title: "Roadmap",
          shortDescription: "",
          url: "https://github.com/users/tester/projects/1",
          openItemCount: 3,
          owner: { login: "tester", type: "User" },
        },
      ],
      partial: false,
      reason: null,
      requests: 1,
    });
    vi.spyOn(githubClient, "getProjectDetail").mockResolvedValue({
      ...MOCK_PROJECT_DETAIL,
      id: "project-1",
      statusFields: [
        MOCK_STATUS_FIELD,
        {
          ...MOCK_PRIORITY_FIELD,
          id: "priority-team",
          name: "Priority (Team)",
        },
        {
          ...MOCK_PRIORITY_FIELD,
          id: "priority-severity",
          name: "Priority (Severity)",
        },
      ],
    });
    vi.mocked(p.select)
      .mockResolvedValueOnce("codex-app-server" as never)
      .mockResolvedValueOnce("project-1" as never)
      .mockResolvedValueOnce("active" as never)
      .mockResolvedValueOnce("active" as never)
      .mockResolvedValueOnce("terminal" as never)
      .mockResolvedValueOnce("project-field" as never)
      .mockResolvedValueOnce("priority-severity" as never);
    vi.mocked(p.text)
      .mockResolvedValueOnce("0" as never)
      .mockResolvedValueOnce("1" as never);

    await initCommand(
      ["--dry-run", "--output", join(configDir, "WORKFLOW.md")],
      {
        configDir,
        verbose: false,
        json: false,
        noColor: true,
      }
    );

    const rendered = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(rendered).toContain("Priority source   project-field");
    expect(rendered).toContain(
      "Priority mapping  Priority (Severity): P0=0, P1=1"
    );
    expect(vi.mocked(p.select).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            message: "Step 5/5 — Choose one priority source:",
          }),
        ],
      ])
    );
    expect(vi.mocked(p.text).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            message: 'Priority value for option "P0"',
          }),
        ],
        [
          expect.objectContaining({
            message: 'Priority value for option "P1"',
          }),
        ],
      ])
    );
  });

  it("validates state mappings before prompting for blocker checks", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-init-invalid-map-"));
    vi.spyOn(ghAuth, "resolveGitHubAuth").mockResolvedValue({
      source: "env",
      login: "env-user",
      token: "env-token",
      scopes: ["repo", "read:org", "project"],
    });
    vi.spyOn(githubClient, "createClient").mockReturnValue({} as never);
    vi.spyOn(githubClient, "discoverUserProjects").mockResolvedValue({
      projects: [
        {
          id: "project-1",
          title: "Roadmap",
          shortDescription: "",
          url: "https://github.com/users/tester/projects/1",
          openItemCount: 3,
          owner: { login: "tester", type: "User" },
        },
      ],
      partial: false,
      reason: null,
      requests: 1,
    });
    vi.spyOn(githubClient, "getProjectDetail").mockResolvedValue({
      ...MOCK_PROJECT_DETAIL,
      id: "project-1",
      statusFields: [MOCK_STATUS_FIELD],
    });
    vi.mocked(p.select)
      .mockResolvedValueOnce("codex-app-server" as never)
      .mockResolvedValueOnce("project-1" as never)
      .mockResolvedValueOnce("wait" as never)
      .mockResolvedValueOnce("wait" as never)
      .mockResolvedValueOnce("wait" as never);

    await initCommand(
      ["--dry-run", "--output", join(configDir, "WORKFLOW.md")],
      {
        configDir,
        verbose: false,
        json: false,
        noColor: true,
      }
    );

    expect(process.exitCode).toBe(1);
    expect(p.log.error).toHaveBeenCalledWith("Mapping validation failed:");
    expect(p.confirm).not.toHaveBeenCalled();
    expect(p.multiselect).not.toHaveBeenCalled();
  });

  it("validates interactive priority mapping values as non-empty integers", async () => {
    vi.mocked(p.select).mockResolvedValueOnce("project-field" as never);
    vi.mocked(p.text).mockResolvedValue("2" as never);

    const projectFieldResult = await promptPriorityConfig({
      priorityResolution: { field: MOCK_PRIORITY_FIELD, ambiguous: [] },
      labelNames: [],
    });

    expect(projectFieldResult.priority).toEqual({
      source: "project-field",
      field: "Priority",
      values: {
        P0: 2,
        P1: 2,
      },
    });
    const projectFieldValidate = vi.mocked(p.text).mock.calls[0]?.[0].validate;
    expect(projectFieldValidate?.("")).toBe("Enter an integer.");
    expect(projectFieldValidate?.("2.5")).toBe("Enter an integer.");
    expect(projectFieldValidate?.("-2")).toBeUndefined();

    vi.mocked(p.select).mockReset();
    vi.mocked(p.multiselect).mockReset();
    vi.mocked(p.text).mockReset();
    vi.mocked(p.select).mockResolvedValueOnce("labels" as never);
    vi.mocked(p.multiselect).mockResolvedValueOnce(["priority: p0"] as never);
    vi.mocked(p.text).mockResolvedValue("3" as never);

    const labelResult = await promptPriorityConfig({
      priorityResolution: { field: null, ambiguous: [] },
      labelNames: ["priority: p0"],
    });

    expect(labelResult.priority).toEqual({
      source: "labels",
      labels: {
        "priority: p0": 3,
      },
    });
    const labelValidate = vi.mocked(p.text).mock.calls[0]?.[0].validate;
    expect(labelValidate?.(" ")).toBe("Enter an integer.");
    expect(labelValidate?.("1.5")).toBe("Enter an integer.");
    expect(labelValidate?.("0")).toBeUndefined();
  });
});

const MOCK_PROJECT_DETAIL = {
  id: "PVT_eco1",
  title: "Ecosystem Test",
  url: "https://github.com/orgs/test/projects/1",
  statusFields: [] as Array<{
    id: string;
    name: string;
    options: Array<{
      id: string;
      name: string;
      description: string | null;
      color: string | null;
    }>;
  }>,
  textFields: [] as Array<{ id: string; name: string; dataType: string }>,
  linkedRepositories: [
    {
      owner: "test",
      name: "repo",
      url: "https://github.com/test/repo",
      cloneUrl: "https://github.com/test/repo.git",
    },
  ],
};

const MOCK_STATUS_FIELD = {
  id: "PVTSSF_eco1",
  name: "Status",
  options: [
    {
      id: "opt_todo",
      name: "Todo",
      description: null,
      color: "GREEN" as string | null,
    },
    {
      id: "opt_ip",
      name: "In Progress",
      description: null,
      color: "YELLOW" as string | null,
    },
    {
      id: "opt_done",
      name: "Done",
      description: null,
      color: "PURPLE" as string | null,
    },
  ],
};

const MOCK_PRIORITY_FIELD = {
  id: "PVTSSF_priority",
  name: "Priority",
  options: [
    {
      id: "opt_p0",
      name: "P0",
      description: null,
      color: "RED" as string | null,
    },
    {
      id: "opt_p1",
      name: "P1",
      description: null,
      color: "ORANGE" as string | null,
    },
  ],
};

describe("init ecosystem generation", () => {
  it("plans dry-run output without writing files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-plan-"));

    const plan = await planEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: MOCK_PRIORITY_FIELD,
      runtime: "codex",
      skipSkills: false,
      skipContext: false,
    });

    expect(plan.files.every((file) => file.status === "create")).toBe(true);
    await expect(
      readFile(join(cwd, ".gh-symphony", "context.yaml"), "utf8")
    ).rejects.toThrow();

    const preview = renderDryRunPreview(
      join(cwd, "WORKFLOW.md"),
      {
        path: join(cwd, "WORKFLOW.md"),
        label: "WORKFLOW.md",
        content: "# workflow",
        mode: "overwrite",
        status: "create",
      },
      plan
    );
    expect(preview).toContain("Init dry-run preview");
    expect(preview).toContain("create");
    expect(preview).toContain(DEFAULT_AFTER_CREATE_HOOK_PATH);
    expect(preview).not.toContain(".gh-symphony/context.yaml");
    expect(preview).not.toContain(".gh-symphony/reference-workflow.md");
    expect(preview).toContain("Priority source   project-field");
    expect(preview).toContain("Priority mapping  Priority: P0=0, P1=1");
    expect(preview).toContain("Detected environment inputs");
    expect(preview).toContain("Dry run only. No files were written.");
  });

  it("builds JSON-friendly dry-run results", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-json-"));

    const plan = await planEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: MOCK_PRIORITY_FIELD,
      runtime: "codex",
      skipSkills: false,
      skipContext: false,
    });

    const result = buildDryRunJsonResult(
      join(cwd, "WORKFLOW.md"),
      {
        path: join(cwd, "WORKFLOW.md"),
        label: "WORKFLOW.md",
        content: "# workflow",
        mode: "overwrite",
        status: "create",
      },
      plan
    );

    expect(result.dryRun).toBe(true);
    expect(result.output).toBe(join(cwd, "WORKFLOW.md"));
    expect(result.priority).toEqual({
      source: "project-field",
      field: "Priority",
      values: {
        P0: 0,
        P1: 1,
      },
    });
    expect(result.files[0]).toMatchObject({
      label: "WORKFLOW.md",
      status: "create",
      mode: "overwrite",
    });
    expect(
      result.files.some((file) =>
        file.path.endsWith(DEFAULT_AFTER_CREATE_HOOK_PATH)
      )
    ).toBe(true);
    expect(
      result.files.some((file) => file.path.includes(".gh-symphony"))
    ).toBe(false);
    expect(result.environment.packageManager).toBeDefined();
  });

  it("generates hooks and skill-local references without .gh-symphony files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-"));

    const result = await writeEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: MOCK_PRIORITY_FIELD,
      runtime: "codex",
      skipSkills: false,
      skipContext: false,
    });

    expect(result.afterCreateHookWritten).toBe(true);
    expect(result.contextYamlWritten).toBe(false);
    expect(result.referenceWorkflowWritten).toBe(false);
    await expect(
      readFile(join(cwd, ".gh-symphony", "context.yaml"), "utf8")
    ).rejects.toThrow();
    await expect(
      readFile(join(cwd, ".gh-symphony", "reference-workflow.md"), "utf8")
    ).rejects.toThrow();

    const hookPath = join(cwd, DEFAULT_AFTER_CREATE_HOOK_PATH);
    const hook = await readFile(hookPath, "utf8");
    const hookStats = await stat(hookPath);
    expect(hook).toBe(DEFAULT_AFTER_CREATE_HOOK_CONTENT);
    expect(hookStats.mode & 0o111).not.toBe(0);
  });

  it("reflects detected repository commands across generated artifacts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-guidance-"));
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          private: true,
          scripts: {
            test: "pnpm --filter fixture test",
            lint: "pnpm --filter fixture lint",
            build: "pnpm --filter fixture build",
          },
        },
        null,
        2
      )
    );
    await writeFile(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - .\n");

    await writeEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: MOCK_PRIORITY_FIELD,
      runtime: "codex",
      skipSkills: false,
      skipContext: false,
    });

    const referenceWorkflow = await readFile(
      join(
        cwd,
        ".codex",
        "skills",
        "gh-symphony",
        "references",
        "workflow-schema.md"
      ),
      "utf8"
    );
    const skill = await readFile(
      join(cwd, ".codex", "skills", "gh-symphony", "SKILL.md"),
      "utf8"
    );
    const implementPosture = await readFile(
      join(
        cwd,
        ".codex",
        "skills",
        "gh-symphony",
        "references",
        "workflow-posture-implement.md"
      ),
      "utf8"
    );

    expect(referenceWorkflow).toContain(
      "Detected repository validation commands:"
    );
    expect(referenceWorkflow).toContain("`pnpm test`");
    expect(referenceWorkflow).toContain(
      "(script: `pnpm --filter fixture test`)"
    );
    expect(referenceWorkflow).toContain(
      "This repository appears to be a monorepo"
    );
    expect(skill).toContain("Detected repository validation commands:");
    expect(skill).toContain("`pnpm lint`");
    expect(skill).toContain("(script: `pnpm --filter fixture lint`)");
    expect(skill).toContain("Use `pnpm` conventions");
    expect(implementPosture).toContain("`pnpm lint`");
    expect(implementPosture).toContain(
      "(script: `pnpm --filter fixture lint`)"
    );
  });

  it("threads detected repository commands into generated WORKFLOW.md", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-workflow-guidance-"));
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          private: true,
          scripts: {
            test: "npm test",
            lint: "npm run lint",
          },
        },
        null,
        2
      )
    );
    await writeFile(join(cwd, "package-lock.json"), "{}\n");

    const plan = await planWorkflowArtifacts({
      cwd,
      outputPath: join(cwd, "WORKFLOW.md"),
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: MOCK_PRIORITY_FIELD,
      mappings: {
        Todo: { role: "active" },
        "In Progress": { role: "active" },
        Done: { role: "terminal" },
      },
      runtime: "codex",
      skipSkills: true,
      skipContext: true,
    });

    expect(plan.workflowMd).toContain("### Repository Validation Guidance");
    expect(plan.workflowMd).toContain("source: project-field");
    expect(plan.workflowMd).toContain('field: "Priority"');
    expect(plan.workflowMd).not.toContain("priority_field:");
    expect(plan.workflowMd).toContain(
      "Detected repository validation commands:"
    );
    expect(plan.workflowMd).toContain("`npm test`");
    expect(plan.workflowMd).toContain("`npm run lint`");
    expect(plan.workflowMd).toContain("Use `npm` conventions");
  });

  it("threads non-Node repository commands into generated workflow artifacts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-non-node-guidance-"));
    await writeFile(
      join(cwd, "pyproject.toml"),
      "[project]\nname = 'fixture'\n"
    );
    await writeFile(join(cwd, "uv.lock"), "version = 1\n");
    await writeFile(join(cwd, "pytest.ini"), "[pytest]\n");
    await writeFile(
      join(cwd, "Makefile"),
      ["test:", "\tuv run pytest", "lint:", "\truff check ."].join("\n")
    );

    const plan = await planWorkflowArtifacts({
      cwd,
      outputPath: join(cwd, "WORKFLOW.md"),
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: MOCK_PRIORITY_FIELD,
      mappings: {
        Todo: { role: "active" },
        "In Progress": { role: "active" },
        Done: { role: "terminal" },
      },
      runtime: "codex",
      skipSkills: false,
      skipContext: false,
    });

    expect(plan.workflowMd).toContain(
      "Detected repository validation commands:"
    );
    expect(plan.workflowMd).toContain("`make test`");
    expect(plan.workflowMd).toContain("`make lint`");
    expect(plan.workflowMd).toContain("Use `uv` conventions");
    expect(
      plan.ecosystemPlan.files.some((file) =>
        file.path.endsWith("references/workflow-schema.md")
      )
    ).toBe(true);
  });

  it("scaffolds codex-app-server runtime defaults into WORKFLOW.md", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-workflow-codex-runtime-"));

    const plan = await planWorkflowArtifacts({
      cwd,
      outputPath: join(cwd, "WORKFLOW.md"),
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: null,
      mappings: {
        Todo: { role: "active" },
        "In Progress": { role: "active" },
        Done: { role: "terminal" },
      },
      runtime: "codex-app-server",
      skipSkills: true,
      skipContext: false,
    });

    expect(plan.workflowMd).toContain("runtime:");
    expect(plan.workflowMd).toContain("  kind: codex-app-server");
    expect(plan.workflowMd).toContain("  command: codex");
    expect(plan.workflowMd).toContain("    - app-server");
    expect(plan.workflowMd).toContain("    bare: false");
    expect(plan.workflowMd).toContain("    strict_mcp_config: false");
    expect(plan.workflowMd).not.toContain("## Runtime Constraints");
  });

  it("scaffolds claude-print runtime defaults and constraints into WORKFLOW.md", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-workflow-claude-runtime-"));

    const plan = await planWorkflowArtifacts({
      cwd,
      outputPath: join(cwd, "WORKFLOW.md"),
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: null,
      mappings: {
        Todo: { role: "active" },
        "In Progress": { role: "active" },
        Done: { role: "terminal" },
      },
      runtime: "claude-print",
      skipSkills: true,
      skipContext: false,
    });

    expect(plan.workflowMd).toContain("  kind: claude-print");
    expect(plan.workflowMd).toContain("  command: claude");
    expect(plan.workflowMd).toContain("    - -p");
    expect(plan.workflowMd).toContain("    - --output-format");
    expect(plan.workflowMd).toContain("    - stream-json");
    expect(plan.workflowMd).toContain("    - --permission-mode");
    expect(plan.workflowMd).toContain("    - bypassPermissions");
    expect(plan.workflowMd).toContain("    bare: false");
    expect(plan.workflowMd).toContain("    strict_mcp_config: false");
    expect(plan.workflowMd).not.toContain("    env: ANTHROPIC_API_KEY");
    expect(plan.workflowMd).toContain("    stall_timeout_ms: 900000");
    expect(plan.workflowMd).toContain("## Runtime Constraints");
    expect(plan.workflowMd).toContain("Runtime trade-off note:");
  });

  it("prompts for runtime selection and reports preflight during interactive init", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-init-runtime-int-"));
    const binDir = join(configDir, "bin");
    await mkdir(binDir, { recursive: true });
    const claude = join(binDir, "claude");
    await writeFile(
      claude,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo \'claude 1.0.0\'; fi\n',
      "utf8"
    );
    await chmod(claude, 0o755);
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockReturnValue(true as never);
    vi.spyOn(ghAuth, "resolveGitHubAuth").mockResolvedValue({
      source: "env",
      login: "env-user",
      token: "env-token",
      scopes: ["repo", "read:org", "project"],
    });
    vi.spyOn(githubClient, "createClient").mockReturnValue({} as never);
    vi.spyOn(githubClient, "discoverUserProjects").mockResolvedValue({
      projects: [
        {
          id: "project-1",
          title: "Roadmap",
          shortDescription: "",
          url: "https://github.com/users/tester/projects/1",
          openItemCount: 3,
          owner: { login: "tester", type: "User" },
        },
      ],
      partial: false,
      reason: null,
      requests: 1,
    });
    vi.spyOn(githubClient, "getProjectDetail").mockResolvedValue({
      ...MOCK_PROJECT_DETAIL,
      id: "project-1",
      statusFields: [MOCK_STATUS_FIELD],
    });
    vi.stubEnv(
      "PATH",
      `${binDir}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`
    );
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.stubEnv("GITHUB_GRAPHQL_TOKEN", "github-token");
    vi.mocked(p.select)
      .mockResolvedValueOnce("claude-print" as never)
      .mockResolvedValueOnce("project-1" as never)
      .mockResolvedValueOnce("active" as never)
      .mockResolvedValueOnce("active" as never)
      .mockResolvedValueOnce("terminal" as never);

    await initCommand(
      ["--dry-run", "--output", join(configDir, "WORKFLOW.md")],
      {
        configDir,
        verbose: false,
        json: false,
        noColor: true,
      }
    );

    const rendered = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(rendered).toContain("Runtime   claude-print");
    expect(p.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Step 1/5 — Select the agent runtime:",
      })
    );
    expect(p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Claude runtime preflight")
    );
    vi.unstubAllEnvs();
  });

  it("generates codex skills when runtime is the codex agent command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-codex-cmd-"));

    await writeEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: null,
      runtime: "bash -lc codex app-server",
      skipSkills: false,
      skipContext: false,
    });

    const skill = await readFile(
      join(cwd, ".codex", "skills", "gh-symphony", "SKILL.md"),
      "utf8"
    );
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toContain("name: gh-symphony");
    expect(skill).toContain("description: Design, refine, and validate");
    expect(skill).toContain("gh-symphony");
    await expect(
      readFile(
        join(cwd, ".codex", "skills", "gh-symphony", "references", "README.md"),
        "utf8"
      )
    ).resolves.toContain("# /gh-symphony references");
  });

  it("does not generate context.yaml for shell command runtimes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-shell-command-"));

    await writeEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: null,
      runtime: "bash -lc codex app-server",
      skipSkills: true,
      skipContext: false,
    });

    await expect(
      readFile(join(cwd, ".gh-symphony", "context.yaml"), "utf8")
    ).rejects.toThrow();
  });

  it("generates frontmatter for all scaffolded codex skills", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-codex-frontmatter-"));

    await writeEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: null,
      runtime: "codex",
      skipSkills: false,
      skipContext: false,
    });

    const skillNames = [
      "gh-symphony",
      "gh-project",
      "commit",
      "push",
      "pull",
      "land",
    ];

    for (const skillName of skillNames) {
      const skill = await readFile(
        join(cwd, ".codex", "skills", skillName, "SKILL.md"),
        "utf8"
      );
      expect(skill.startsWith("---\n")).toBe(true);
      expect(skill).toContain(`name: ${skillName}`);
      expect(skill).toContain("license: MIT");
      expect(skill).toContain("metadata:");
    }

    const referenceFiles = [
      "README.md",
      "workflow-schema.md",
      "workflow-posture-implement.md",
      "workflow-posture-review.md",
      "workflow-posture-maintain.md",
    ];

    for (const referenceFile of referenceFiles) {
      await expect(
        readFile(
          join(
            cwd,
            ".codex",
            "skills",
            "gh-symphony",
            "references",
            referenceFile
          ),
          "utf8"
        )
      ).resolves.toMatch(/gh-symphony|Workflow|workflow/);
    }
  });

  it("--skip-skills skips skill files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-skip-skill-"));

    const result = await writeEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: null,
      runtime: "codex",
      skipSkills: true,
      skipContext: false,
    });

    await expect(
      readFile(join(cwd, ".codex", "skills", "gh-symphony", "SKILL.md"), "utf8")
    ).rejects.toThrow();

    expect(result.skillsDir).toBeNull();
    await expect(
      readFile(join(cwd, ".gh-symphony", "context.yaml"), "utf8")
    ).rejects.toThrow();
  });

  it("--skip-context is a no-op after context generation removal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-skip-ctx-"));

    await writeEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: null,
      runtime: "codex",
      skipSkills: true,
      skipContext: true,
    });

    await expect(
      readFile(join(cwd, ".gh-symphony", "context.yaml"), "utf8")
    ).rejects.toThrow();

    await expect(
      readFile(join(cwd, ".gh-symphony", "reference-workflow.md"), "utf8")
    ).rejects.toThrow();
  });

  it("legacy cleanup removes known .gh-symphony files and empty directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-ids-"));
    await mkdir(join(cwd, ".gh-symphony"), { recursive: true });
    await writeFile(join(cwd, ".gh-symphony", "context.yaml"), "old\n");
    await writeFile(
      join(cwd, ".gh-symphony", "reference-workflow.md"),
      "old\n"
    );
    vi.mocked(p.confirm).mockResolvedValueOnce(true as never);

    const removed = await promptLegacyGhSymphonyCleanup(cwd);

    expect(removed).toEqual([
      ".gh-symphony/context.yaml",
      ".gh-symphony/reference-workflow.md",
    ]);
    await expect(
      readFile(join(cwd, ".gh-symphony", "context.yaml"), "utf8")
    ).rejects.toThrow();
    await expect(readdir(join(cwd, ".gh-symphony"))).rejects.toThrow();
  });

  it("marks existing skill files as unchanged in dry-run plans", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-existing-"));

    await writeEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: null,
      runtime: "codex",
      skipSkills: false,
      skipContext: false,
    });

    const plan = await planEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: null,
      runtime: "codex",
      skipSkills: false,
      skipContext: false,
    });

    const hookScaffold = plan.files.find(
      (file) => file.label === DEFAULT_AFTER_CREATE_HOOK_LABEL
    );
    expect(hookScaffold?.status).toBe("unchanged");

    expect(plan.files.some((file) => file.path.includes(".gh-symphony"))).toBe(
      false
    );

    const skillStatuses = plan.files
      .filter((file) => file.label.startsWith("Skill "))
      .map((file) => file.status);
    expect(skillStatuses.length).toBeGreaterThan(0);
    expect(skillStatuses.every((status) => status === "unchanged")).toBe(true);
  });

  it("does not rewrite unchanged overwrite files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-unchanged-"));

    await writeEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: null,
      runtime: "codex",
      skipSkills: true,
      skipContext: true,
    });

    const secondRun = await writeEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      priorityField: null,
      runtime: "codex",
      skipSkills: true,
      skipContext: true,
    });

    expect(secondRun.referenceWorkflowWritten).toBe(false);
    expect(secondRun.contextYamlWritten).toBe(false);
  });
});
