import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadGlobalConfig, loadProjectConfig } from "../config.js";
import { registerStandaloneProject } from "./project.js";
import projectCommand from "./project.js";

const workflow = `---
tracker:
  kind: github-project
  project_id: PVT_example
codex:
  command: codex app-server
repository:
  slug: acme/platform
workspace:
  root: .runners
---
Implement the issue.`;

const linearWorkflow = `---
tracker:
  kind: linear
  project_slug: symphony
  active_states: [" Todo "]
  pickup_labels:
    include: [team-a]
    exclude: [skip]
codex:
  command: codex app-server
repository:
  slug: acme/platform
---
Implement the issue.`;

describe("registerStandaloneProject", () => {
  it("persists an external workflow project and makes it active", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-standalone-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    await writeFile(join(projectDir, "WORKFLOW.md"), workflow, "utf8");

    const project = await registerStandaloneProject(projectDir, { configDir });

    await expect(
      loadProjectConfig(configDir, project.projectId)
    ).resolves.toMatchObject({
      repository: { owner: "acme", name: "platform" },
      workflowSource: {
        type: "external",
        path: join(projectDir, "WORKFLOW.md"),
      },
      projectDir,
      workspaceDir: join(projectDir, ".runners"),
      populateStrategy: "worktree-cache",
    });
    await expect(loadGlobalConfig(configDir)).resolves.toEqual({
      activeProject: project.projectId,
      projects: [project.projectId],
    });
  });

  it("rejects an overlapping mapping without interactive confirmation", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-standalone-config-"));
    const first = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    const second = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    await Promise.all([
      writeFile(join(first, "WORKFLOW.md"), workflow, "utf8"),
      writeFile(join(second, "WORKFLOW.md"), workflow, "utf8"),
      mkdir(join(first, ".runners"), { recursive: true }),
    ]);
    await registerStandaloneProject(first, { configDir });

    await expect(
      registerStandaloneProject(second, { configDir })
    ).rejects.toThrow("Tracker mapping overlaps registered project(s)");
  });

  it("preserves Linear label filters and normalizes overlapping states", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-standalone-config-"));
    const first = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    const second = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    await Promise.all([
      writeFile(join(first, "WORKFLOW.md"), linearWorkflow, "utf8"),
      writeFile(
        join(second, "WORKFLOW.md"),
        linearWorkflow.replace(" Todo ", "todo"),
        "utf8"
      ),
    ]);

    const project = await registerStandaloneProject(first, { configDir });

    await expect(
      loadProjectConfig(configDir, project.projectId)
    ).resolves.toMatchObject({
      tracker: {
        settings: {
          pickupLabels: { include: ["team-a"], exclude: ["skip"] },
        },
      },
    });
    await expect(
      registerStandaloneProject(second, { configDir })
    ).rejects.toThrow("Tracker mapping overlaps registered project(s)");
  });

  it("lists registered standalone projects", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-standalone-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    await writeFile(join(projectDir, "WORKFLOW.md"), workflow, "utf8");
    const project = await registerStandaloneProject(projectDir, { configDir });
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

    await projectCommand(["list"], {
      configDir,
      configDirOverride: true,
      verbose: false,
      json: true,
      noColor: true,
    });

    spy.mockRestore();
    expect(JSON.parse(writes.join(""))).toEqual([
      expect.objectContaining({ projectId: project.projectId, projectDir }),
    ]);
  });
});
