import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseWorkflowMarkdown } from "@gh-symphony/core";
import type { CliTenantConfig, WorkflowStateConfig } from "../config.js";
import { generateTenantId, writeConfig } from "./init.js";

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
        name: "Stage",
        options: [{ name: "Queued" }, { name: "Doing" }, { name: "Done" }],
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
    expect(tenant.workflow?.lifecycle).toMatchObject({
      stateFieldName: "Stage",
      activeStates: ["Queued", "Doing"],
      terminalStates: ["Done"],
    });
    expect(tenant.workflow?.scheduler?.pollIntervalMs).toBe(15_000);
    expect(tenant.orchestrator).toEqual({
      concurrency: 1,
      maxAttempts: 2,
    });

    const mapping = JSON.parse(
      await readFile(
        join(
          configDir,
          "tenants",
          "tenant-alpha",
          "workflow-mapping.json"
        ),
        "utf8"
      )
    ) as WorkflowStateConfig;
    expect(mapping.lifecycle.stateFieldName).toBe("Stage");
    expect(mapping.lifecycle.activeStates).toContain("Queued");
    expect(mapping.lifecycle.terminalStates).toContain("Done");
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
        name: "Status",
        options: [{ name: "Todo" }, { name: "In Progress" }, { name: "Done" }],
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

  it("derives unique tenant IDs from the project identity, not only the title", () => {
    expect(generateTenantId("Roadmap", "project-a")).not.toBe(
      generateTenantId("Roadmap", "project-b")
    );
  });
});
