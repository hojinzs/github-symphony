import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
import initCommand from "./init.js";
import {
  buildDryRunJsonResult,
  generateProjectId,
  planWorkflowArtifacts,
  planEcosystem,
  renderDryRunPreview,
  writeConfig,
  writeEcosystem,
} from "./init.js";

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
    vi.mocked(p.spinner).mockImplementation(mockSpinner);
    vi.mocked(p.log.error).mockImplementation(() => undefined);
    vi.mocked(p.log.warn).mockImplementation(() => undefined);
    vi.mocked(p.log.info).mockImplementation(() => undefined);
  });

  afterEach(() => {
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
    const configDir = await mkdtemp(join(tmpdir(), "cli-init-partial-projects-"));
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

describe("init command config output", () => {
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

  it("writes assignedOnly into project tracker settings when enabled", async () => {
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
      assignedOnly: true,
    });

    const project = JSON.parse(
      await readFile(
        join(configDir, "projects", "tenant-assigned", "project.json"),
        "utf8"
      )
    ) as CliProjectConfig;

    expect(project.tracker.settings?.assignedOnly).toBe(true);
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

  it("adds tracker.priority_field during non-interactive dry-run when Priority exists", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-init-priority-nonint-"));
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
      ["--non-interactive", "--dry-run", "--output", join(configDir, "WORKFLOW.md")],
      {
        configDir,
        verbose: false,
        json: true,
        noColor: true,
      }
    );

    const payload = JSON.parse(
      stdout.mock.calls.map(([chunk]) => String(chunk)).join("")
    ) as { priorityFieldName: string | null };
    expect(payload.priorityFieldName).toBe("Priority");
  });

  it("runs Claude preflight for init --runtime claude-code", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-init-claude-preflight-"));
    const binDir = join(configDir, "bin");
    await mkdir(binDir, { recursive: true });
    const claude = join(binDir, "claude-code");
    await writeFile(
      claude,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'claude-code 1.0.0'; fi\n",
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

    expect(process.exitCode).toBe(1);
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("Neither ANTHROPIC_API_KEY")
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
      .mockResolvedValueOnce("project-1" as never)
      .mockResolvedValueOnce("active" as never)
      .mockResolvedValueOnce("active" as never)
      .mockResolvedValueOnce("terminal" as never)
      .mockResolvedValueOnce("priority-severity" as never);

    await initCommand(["--dry-run", "--output", join(configDir, "WORKFLOW.md")], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    const rendered = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(rendered).toContain("Priority field   Priority (Severity)");
    expect(vi.mocked(p.select).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            message:
              "Step 3/3 — Multiple GitHub Project priority fields look plausible. Select the one Symphony should use:",
          }),
        ],
      ])
    );
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
    expect(preview).toContain(".gh-symphony/context.yaml");
    expect(preview).toContain("Priority field   Priority");
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
    expect(result.priorityFieldName).toBe("Priority");
    expect(result.files[0]).toMatchObject({
      label: "WORKFLOW.md",
      status: "create",
      mode: "overwrite",
    });
    expect(
      result.files.some((file) => file.path.endsWith(DEFAULT_AFTER_CREATE_HOOK_PATH))
    ).toBe(true);
    expect(
      result.files.some((file) => file.path.endsWith(".gh-symphony/context.yaml"))
    ).toBe(true);
    expect(result.environment.packageManager).toBeDefined();
  });

  it("generates context.yaml and reference-workflow.md", async () => {
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

    const contextYaml = await readFile(
      join(cwd, ".gh-symphony", "context.yaml"),
      "utf8"
    );
    expect(contextYaml).toContain("schema_version: 1");
    expect(contextYaml).toContain("PVT_eco1");

    const refWorkflow = await readFile(
      join(cwd, ".gh-symphony", "reference-workflow.md"),
      "utf8"
    );
    expect(refWorkflow).toContain("# Reference WORKFLOW.md");

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
      join(cwd, ".gh-symphony", "reference-workflow.md"),
      "utf8"
    );
    const skill = await readFile(
      join(cwd, ".codex", "skills", "gh-symphony", "SKILL.md"),
      "utf8"
    );

    expect(referenceWorkflow).toContain("Detected repository validation commands:");
    expect(referenceWorkflow).toContain("`pnpm test`");
    expect(referenceWorkflow).toContain(
      "(script: `pnpm --filter fixture test`)"
    );
    expect(referenceWorkflow).toContain("This repository appears to be a monorepo");
    expect(skill).toContain("Detected repository validation commands:");
    expect(skill).toContain("`pnpm lint`");
    expect(skill).toContain("(script: `pnpm --filter fixture lint`)");
    expect(skill).toContain("Use `pnpm` conventions");
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
    expect(plan.workflowMd).toContain("priority_field: Priority");
    expect(plan.workflowMd).toContain("Detected repository validation commands:");
    expect(plan.workflowMd).toContain("`npm test`");
    expect(plan.workflowMd).toContain("`npm run lint`");
    expect(plan.workflowMd).toContain("Use `npm` conventions");
  });

  it("threads non-Node repository commands into generated workflow artifacts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-non-node-guidance-"));
    await writeFile(join(cwd, "pyproject.toml"), "[project]\nname = 'fixture'\n");
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

    expect(plan.workflowMd).toContain("Detected repository validation commands:");
    expect(plan.workflowMd).toContain("`make test`");
    expect(plan.workflowMd).toContain("`make lint`");
    expect(plan.workflowMd).toContain("Use `uv` conventions");
    expect(plan.ecosystemPlan.files.some((file) => file.path.endsWith("reference-workflow.md"))).toBe(
      true
    );
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

    const contextYaml = await readFile(
      join(cwd, ".gh-symphony", "context.yaml"),
      "utf8"
    );
    expect(contextYaml).toContain("schema_version: 1");
    expect(result.skillsDir).toBeNull();
  });

  it("--skip-context skips context.yaml", async () => {
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

    const refWorkflow = await readFile(
      join(cwd, ".gh-symphony", "reference-workflow.md"),
      "utf8"
    );
    expect(refWorkflow).toContain("# Reference WORKFLOW.md");
  });

  it("context.yaml contains statusField.id and option IDs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-ids-"));

    await writeEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: {
        id: "PVTSSF_myfield",
        name: "Status",
        options: [
          { id: "opt_abc", name: "Todo", description: null, color: null },
          { id: "opt_def", name: "Done", description: null, color: null },
        ],
      },
      priorityField: null,
      runtime: "codex",
      skipSkills: true,
      skipContext: false,
    });

    const contextYaml = await readFile(
      join(cwd, ".gh-symphony", "context.yaml"),
      "utf8"
    );
    expect(contextYaml).toContain("PVTSSF_myfield");
    expect(contextYaml).toContain("opt_abc");
    expect(contextYaml).toContain("opt_def");
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

    const referenceWorkflow = plan.files.find((file) =>
      file.path.endsWith(".gh-symphony/reference-workflow.md")
    );
    expect(referenceWorkflow?.status).toBe("unchanged");

    const hookScaffold = plan.files.find(
      (file) => file.label === DEFAULT_AFTER_CREATE_HOOK_LABEL
    );
    expect(hookScaffold?.status).toBe("unchanged");

    const contextYaml = plan.files.find((file) =>
      file.path.endsWith(".gh-symphony/context.yaml")
    );
    expect(contextYaml?.status).toBe("update");

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
