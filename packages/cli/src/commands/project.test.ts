import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadProjectConfig } from "../config.js";
import { deriveStandaloneProject, standaloneProjectId } from "./project.js";
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

describe("deriveStandaloneProject", () => {
  it("derives an external workflow project from its folder", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-standalone-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    await writeFile(join(projectDir, "WORKFLOW.md"), workflow, "utf8");

    const project = await deriveStandaloneProject(projectDir, { configDir });

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
    expect(project.projectId).toBe(standaloneProjectId(projectDir));
  });

  it("derives a clone URL override from the repository extension", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-standalone-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    await writeFile(
      join(projectDir, "WORKFLOW.md"),
      workflow.replace(
        "repository:\n  slug: acme/platform",
        "repository:\n  slug: acme/platform\n  clone_url: /srv/mirrors/platform.git"
      ),
      "utf8"
    );

    const project = await deriveStandaloneProject(projectDir, { configDir });

    expect(project.repository).toMatchObject({
      owner: "acme",
      name: "platform",
      cloneUrl: "/srv/mirrors/platform.git",
    });
  });

  it("re-derives the stored config when the workflow changes", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-standalone-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    await writeFile(join(projectDir, "WORKFLOW.md"), workflow, "utf8");
    await deriveStandaloneProject(projectDir, { configDir });

    await writeFile(
      join(projectDir, "WORKFLOW.md"),
      workflow.replace("PVT_example", "PVT_changed"),
      "utf8"
    );
    const project = await deriveStandaloneProject(projectDir, { configDir });

    await expect(
      loadProjectConfig(configDir, project.projectId)
    ).resolves.toMatchObject({
      tracker: { bindingId: "PVT_changed" },
    });
  });

  it("explains that a folder without WORKFLOW.md is not a project", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-standalone-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-standalone-empty-"));

    await expect(
      deriveStandaloneProject(projectDir, { configDir })
    ).rejects.toThrow("No WORKFLOW.md in");
  });

  it("points a repo-embedded workflow at repo start", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-standalone-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    await writeFile(
      join(projectDir, "WORKFLOW.md"),
      workflow.replace("repository:\n  slug: acme/platform\n", ""),
      "utf8"
    );

    await expect(
      deriveStandaloneProject(projectDir, { configDir })
    ).rejects.toThrow("gh-symphony repo start");
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
    await deriveStandaloneProject(first, { configDir });

    await expect(
      deriveStandaloneProject(second, { configDir })
    ).rejects.toThrow("Tracker mapping overlaps project(s)");
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

    const project = await deriveStandaloneProject(first, { configDir });

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
      deriveStandaloneProject(second, { configDir })
    ).rejects.toThrow("Tracker mapping overlaps project(s)");
  });

  it("lists standalone projects that have been derived", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-standalone-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    await writeFile(join(projectDir, "WORKFLOW.md"), workflow, "utf8");
    const project = await deriveStandaloneProject(projectDir, { configDir });
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
