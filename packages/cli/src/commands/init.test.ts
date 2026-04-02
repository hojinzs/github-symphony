import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { CliProjectConfig } from "../config.js";
import {
  buildDryRunJsonResult,
  generateProjectId,
  planEcosystem,
  renderDryRunPreview,
  writeConfig,
  writeEcosystem,
} from "./init.js";

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

describe("init ecosystem generation", () => {
  it("plans dry-run output without writing files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-plan-"));

    const plan = await planEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
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
    expect(preview).toContain(".gh-symphony/context.yaml");
    expect(preview).toContain("Detected environment inputs");
    expect(preview).toContain("Dry run only. No files were written.");
  });

  it("builds JSON-friendly dry-run results", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-json-"));

    const plan = await planEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
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
    expect(result.files[0]).toMatchObject({
      label: "WORKFLOW.md",
      status: "create",
      mode: "overwrite",
    });
    expect(
      result.files.some((file) => file.path.endsWith(".gh-symphony/context.yaml"))
    ).toBe(true);
    expect(result.environment.packageManager).toBeDefined();
  });

  it("generates context.yaml and reference-workflow.md", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-"));

    await writeEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      runtime: "codex",
      skipSkills: false,
      skipContext: false,
    });

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
  });

  it("generates codex skills when runtime is the codex agent command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-eco-codex-cmd-"));

    await writeEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
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
      runtime: "codex",
      skipSkills: false,
      skipContext: false,
    });

    const plan = await planEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      runtime: "codex",
      skipSkills: false,
      skipContext: false,
    });

    const referenceWorkflow = plan.files.find((file) =>
      file.path.endsWith(".gh-symphony/reference-workflow.md")
    );
    expect(referenceWorkflow?.status).toBe("unchanged");

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
      runtime: "codex",
      skipSkills: true,
      skipContext: true,
    });

    const secondRun = await writeEcosystem({
      cwd,
      projectDetail: MOCK_PROJECT_DETAIL,
      statusField: MOCK_STATUS_FIELD,
      runtime: "codex",
      skipSkills: true,
      skipContext: true,
    });

    expect(secondRun.referenceWorkflowWritten).toBe(false);
    expect(secondRun.contextYamlWritten).toBe(false);
  });
});
