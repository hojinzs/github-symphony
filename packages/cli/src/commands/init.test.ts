import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseWorkflowMarkdown } from "@gh-symphony/core";
import type { CliTenantConfig, WorkflowStateConfig } from "../config.js";
import { generateTenantId, writeConfig, writeEcosystem } from "./init.js";

describe("init command config output", () => {
  it("writes workflow and orchestrator overrides for the runtime", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-init-"));

    await writeConfig(configDir, {
      tenantId: "tenant-alpha",
      token: "token-123",
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
      statusField: {
        id: "PVTSSF_stage1",
        name: "Stage",
        options: [
          { id: "opt_q", name: "Queued" },
          { id: "opt_d", name: "Doing" },
          { id: "opt_dn", name: "Done" },
        ],
      },
      mappings: {
        Queued: { role: "active", goal: "Triage and plan the issue" },
        Doing: { role: "active", goal: "Implement the solution" },
        Done: { role: "terminal" },
      },
      runtime: "codex",
      pollIntervalMs: 15_000,
      concurrency: 1,
      maxAttempts: 2,
    });

    const tenant = JSON.parse(
      await readFile(
        join(configDir, "tenants", "tenant-alpha", "tenant.json"),
        "utf8"
      )
    ) as CliTenantConfig;
    expect(tenant.workflowMapping?.lifecycle).toMatchObject({
      stateFieldName: "Stage",
      activeStates: ["Queued", "Doing"],
      terminalStates: ["Done"],
    });

    const mapping = JSON.parse(
      await readFile(
        join(configDir, "tenants", "tenant-alpha", "workflow-mapping.json"),
        "utf8"
      )
    ) as WorkflowStateConfig;
    expect(mapping.lifecycle.stateFieldName).toBe("Stage");
    expect(mapping.lifecycle.activeStates).toContain("Queued");
    expect(mapping.lifecycle.terminalStates).toContain("Done");
  });

  it("writes assignedOnly into tenant tracker settings when enabled", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-init-assigned-"));

    await writeConfig(configDir, {
      tenantId: "tenant-assigned",
      token: "token-123",
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
      statusField: {
        id: "PVTSSF_stage1",
        name: "Stage",
        options: [
          { id: "opt_q", name: "Queued" },
          { id: "opt_d", name: "Doing" },
          { id: "opt_dn", name: "Done" },
        ],
      },
      mappings: {
        Queued: { role: "active" },
        Doing: { role: "active" },
        Done: { role: "terminal" },
      },
      runtime: "codex",
      assignedOnly: true,
    });

    const tenant = JSON.parse(
      await readFile(
        join(configDir, "tenants", "tenant-assigned", "tenant.json"),
        "utf8"
      )
    ) as CliTenantConfig;

    expect(tenant.tracker.settings?.assignedOnly).toBe(true);
    expect(tenant.tracker.settings?.projectId).toBe("project-123");
  });

  it("generates a parseable WORKFLOW.md alongside tenant config", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-init-wf-"));

    await writeConfig(configDir, {
      tenantId: "tenant-wf",
      token: "token-456",
      project: {
        id: "project-456",
        title: "Platform",
        url: "https://github.com/orgs/acme/projects/2",
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
      statusField: {
        id: "PVTSSF_status1",
        name: "Status",
        options: [
          { id: "opt_todo", name: "Todo" },
          { id: "opt_ip", name: "In Progress" },
          { id: "opt_done", name: "Done" },
        ],
      },
      mappings: {
        Todo: { role: "active" },
        "In Progress": { role: "active" },
        Done: { role: "terminal" },
      },
      runtime: "codex",
    });

    const workflowMd = await readFile(
      join(configDir, "tenants", "tenant-wf", "WORKFLOW.md"),
      "utf8"
    );
    const parsed = parseWorkflowMarkdown(workflowMd, {});

    expect(parsed.format).toBe("front-matter");
    expect(parsed.lifecycle.activeStates).toContain("Todo");
    expect(parsed.lifecycle.activeStates).toContain("In Progress");
    expect(parsed.lifecycle.terminalStates).toContain("Done");
    expect(parsed.githubProjectId).toBe("project-456");
  });

  it("writes the custom agent command into WORKFLOW.md", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-init-custom-"));

    await writeConfig(configDir, {
      tenantId: "tenant-custom",
      token: "token-789",
      project: {
        id: "project-789",
        title: "Platform",
        url: "https://github.com/orgs/acme/projects/3",
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
      statusField: {
        id: "PVTSSF_status2",
        name: "Status",
        options: [
          { id: "opt_todo", name: "Todo" },
          { id: "opt_done", name: "Done" },
        ],
      },
      mappings: {
        Todo: { role: "active" },
        Done: { role: "terminal" },
      },
      runtime: "custom",
      agentCommand: "bash -lc my-agent",
    });

    const workflowMd = await readFile(
      join(configDir, "tenants", "tenant-custom", "WORKFLOW.md"),
      "utf8"
    );
    const parsed = parseWorkflowMarkdown(workflowMd, {});

    expect(parsed.agentCommand).toBe("bash -lc my-agent");
  });

  it("derives unique tenant IDs from the project identity, not only the title", () => {
    expect(generateTenantId("Roadmap", "project-a")).not.toBe(
      generateTenantId("Roadmap", "project-b")
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

    await writeEcosystem({
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
});
