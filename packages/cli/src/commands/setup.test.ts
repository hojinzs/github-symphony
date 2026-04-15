import { mkdtemp, readFile } from "node:fs/promises";
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
import type { CliProjectConfig } from "../config.js";
import { generateProjectId } from "./init.js";

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
        { id: "p1", name: "P1", description: null, color: "RED" as string | null },
      ],
    },
    {
      id: "priority-severity",
      name: "Priority (Severity)",
      options: [
        { id: "high", name: "High", description: null, color: "ORANGE" as string | null },
      ],
    },
  ],
};

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
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("writes workflow files and managed-project config in non-interactive mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "setup-non-interactive-cwd-"));
    const configDir = await mkdtemp(join(tmpdir(), "setup-non-interactive-config-"));
    process.chdir(cwd);

    await setupCommand(
      ["--non-interactive", "--project", MOCK_PROJECT_SUMMARY.id],
      {
        configDir,
        verbose: false,
        json: false,
        noColor: true,
      }
    );

    const projectId = generateProjectId(
      MOCK_PROJECT_DETAIL.title,
      MOCK_PROJECT_DETAIL.id
    );
    const workflow = await readFile(join(cwd, "WORKFLOW.md"), "utf8");
    const contextYaml = await readFile(
      join(cwd, ".gh-symphony", "context.yaml"),
      "utf8"
    );
    const project = JSON.parse(
      await readFile(
        join(configDir, "projects", projectId, "project.json"),
        "utf8"
      )
    ) as CliProjectConfig;

    expect(workflow).toContain("project_id: PVT_setup_1");
    expect(contextYaml).toContain("PVT_setup_1");
    expect(project.displayName).toBe("Setup Project");
    expect(project.repositories).toHaveLength(2);
  });

  it("shows a final summary and writes the selected repositories in interactive mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "setup-interactive-cwd-"));
    const configDir = await mkdtemp(join(tmpdir(), "setup-interactive-config-"));
    process.chdir(cwd);

    vi.mocked(p.select)
      .mockResolvedValueOnce(MOCK_PROJECT_SUMMARY.id as never)
      .mockResolvedValueOnce("wait" as never)
      .mockResolvedValueOnce("active" as never)
      .mockResolvedValueOnce("terminal" as never);
    vi.mocked(p.confirm)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(true as never);
    vi.mocked(p.multiselect).mockResolvedValue([
      MOCK_PROJECT_DETAIL.linkedRepositories[1],
    ] as never);
    vi.mocked(p.text).mockResolvedValue("/tmp/setup-workspaces" as never);

    await setupCommand([], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    const projectId = generateProjectId(
      MOCK_PROJECT_DETAIL.title,
      MOCK_PROJECT_DETAIL.id
    );
    const project = JSON.parse(
      await readFile(
        join(configDir, "projects", projectId, "project.json"),
        "utf8"
      )
    ) as CliProjectConfig;

    expect(project.workspaceDir).toBe("/tmp/setup-workspaces");
    expect(project.repositories.map((repo) => repo.name)).toEqual(["repo-b"]);
    expect(p.note).toHaveBeenCalledWith(
      expect.stringContaining("Init dry-run preview"),
      "Final summary"
    );
    expect(p.note).toHaveBeenCalledWith(
      expect.stringContaining("Repos:      acme/repo-b  (1 of 2 linked)"),
      "Final summary"
    );
  });

  it("warns and skips tracker.priority_field in non-interactive mode when priority fields are ambiguous", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "setup-non-interactive-priority-cwd-"));
    const configDir = await mkdtemp(
      join(tmpdir(), "setup-non-interactive-priority-config-")
    );
    process.chdir(cwd);

    vi.spyOn(githubClient, "getProjectDetail").mockResolvedValue(
      MOCK_PROJECT_DETAIL_WITH_AMBIGUOUS_PRIORITY
    );
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await setupCommand(
      ["--non-interactive", "--project", MOCK_PROJECT_SUMMARY.id],
      {
        configDir,
        verbose: false,
        json: false,
        noColor: true,
      }
    );

    const workflow = await readFile(join(cwd, "WORKFLOW.md"), "utf8");

    expect(stderrWrite).toHaveBeenCalledWith(
      'Warning: Multiple priority-like single-select fields found ("Priority (Team)", "Priority (Severity)"). Skipping tracker.priority_field in non-interactive mode.\n'
    );
    expect(workflow).not.toContain("priority_field:");
  });

  it("uses --assigned-only as the interactive prompt default and preserves the setting", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "setup-interactive-assigned-cwd-"));
    const configDir = await mkdtemp(
      join(tmpdir(), "setup-interactive-assigned-config-")
    );
    process.chdir(cwd);

    vi.mocked(p.select)
      .mockResolvedValueOnce(MOCK_PROJECT_SUMMARY.id as never)
      .mockResolvedValueOnce("wait" as never)
      .mockResolvedValueOnce("active" as never)
      .mockResolvedValueOnce("terminal" as never);
    vi.mocked(p.confirm)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(false as never)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(true as never);

    await setupCommand(["--assigned-only"], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    const projectId = generateProjectId(
      MOCK_PROJECT_DETAIL.title,
      MOCK_PROJECT_DETAIL.id
    );
    const project = JSON.parse(
      await readFile(
        join(configDir, "projects", projectId, "project.json"),
        "utf8"
      )
    ) as CliProjectConfig;

    expect(project.tracker.settings?.assignedOnly).toBe(true);
    expect(vi.mocked(p.confirm).mock.calls[0]?.[0]).toMatchObject({
      message:
        "Step 3/3 — Only process issues assigned to the authenticated GitHub user?",
      initialValue: true,
    });
  });
});
