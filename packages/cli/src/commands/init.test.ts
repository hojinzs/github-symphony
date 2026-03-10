import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { CliWorkspaceConfig, WorkflowMappingConfig } from "../config.js";
import { generateWorkspaceId, writeConfig } from "./init.js";

describe("init command config output", () => {
  it("writes workflow and orchestrator overrides for the runtime", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-init-"));

    await writeConfig(configDir, {
      workspaceId: "workspace-alpha",
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
      roles: {
        Queued: "trigger",
        Doing: "working",
        Done: "done",
      },
      humanReviewMode: "none",
      runtime: "codex",
      pollIntervalMs: 15_000,
      concurrency: 1,
      maxAttempts: 2,
    });

    const workspace = JSON.parse(
      await readFile(
        join(configDir, "workspaces", "workspace-alpha", "workspace.json"),
        "utf8"
      )
    ) as CliWorkspaceConfig;
    expect(workspace.workflow?.lifecycle).toMatchObject({
      stateFieldName: "Stage",
      planningStates: ["Queued"],
      implementationStates: ["Doing"],
      completedStates: ["Done"],
    });
    expect(workspace.workflow?.scheduler?.pollIntervalMs).toBe(15_000);
    expect(workspace.orchestrator).toEqual({
      concurrency: 1,
      maxAttempts: 2,
    });

    const mapping = JSON.parse(
      await readFile(
        join(
          configDir,
          "workspaces",
          "workspace-alpha",
          "workflow-mapping.json"
        ),
        "utf8"
      )
    ) as WorkflowMappingConfig;
    expect(mapping.lifecycle.stateFieldName).toBe("Stage");
    expect(mapping.lifecycle.planningCompleteState).toBe("Doing");
  });

  it("derives unique workspace IDs from the project identity, not only the title", () => {
    expect(generateWorkspaceId("Roadmap", "project-a")).not.toBe(
      generateWorkspaceId("Roadmap", "project-b")
    );
  });
});
