import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { confirmMock, stopMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  stopMock: vi.fn(),
}));

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return { ...actual, confirm: confirmMock };
});

vi.mock("./stop.js", () => ({ default: stopMock }));

import { loadProjectConfig } from "../config.js";
import { deriveStandaloneProject, standaloneProjectId } from "./project.js";
import projectCommand from "./project.js";

const workflow = `---
tracker:
  kind: github-project
  provider:
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
  provider:
    project_slug: symphony
    pickup_labels:
      include: [team-a]
      exclude: [skip]
  active_states: [" Todo "]
codex:
  command: codex app-server
repository:
  slug: acme/platform
---
Implement the issue.`;

const fileWorkflowWithoutProviderPath = `---
tracker:
  kind: file
  provider:
    project_id: e2e-test
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

  it("uses the legacy file fixture environment fallback for standalone projects", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-standalone-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    const originalIssuesPath = process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH;
    await writeFile(
      join(projectDir, "WORKFLOW.md"),
      fileWorkflowWithoutProviderPath,
      "utf8"
    );
    process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH =
      "/tmp/legacy-issues.json";

    try {
      await expect(
        deriveStandaloneProject(projectDir, { configDir })
      ).resolves.toMatchObject({
        tracker: { settings: { issuesPath: "/tmp/legacy-issues.json" } },
      });
    } finally {
      if (originalIssuesPath === undefined) {
        delete process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH;
      } else {
        process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH = originalIssuesPath;
      }
    }
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

  it("requires tracker.kind before deriving a standalone project", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-standalone-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    await writeFile(join(projectDir, "WORKFLOW.md"), "Prompt only", "utf8");

    await expect(
      deriveStandaloneProject(projectDir, { configDir })
    ).rejects.toThrow(
      'Workflow dispatch requires front matter field "tracker.kind".'
    );
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

  it("serializes concurrent derivation before validating overlaps", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-standalone-config-"));
    const first = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    const second = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    await Promise.all([
      writeFile(join(first, "WORKFLOW.md"), workflow, "utf8"),
      writeFile(join(second, "WORKFLOW.md"), workflow, "utf8"),
    ]);

    const results = await Promise.allSettled([
      deriveStandaloneProject(first, { configDir }),
      deriveStandaloneProject(second, { configDir }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
  });

  it("keeps an aged live lock through overlap confirmation", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-standalone-config-"));
    const existing = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    const first = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    const second = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    await Promise.all(
      [existing, first, second].map((projectDir) =>
        writeFile(join(projectDir, "WORKFLOW.md"), workflow, "utf8")
      )
    );
    await deriveStandaloneProject(existing, { configDir });

    const originalIsTTY = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY"
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    let resolveConfirmation!: (value: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    });
    confirmMock
      .mockImplementationOnce(() => confirmation)
      .mockResolvedValue(false);

    try {
      const firstStart = deriveStandaloneProject(first, { configDir });
      await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));

      const lockPath = join(configDir, ".config.lock");
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
        startedAt: string;
      };
      lock.startedAt = new Date(Date.now() - 31_000).toISOString();
      await writeFile(lockPath, JSON.stringify(lock), "utf8");

      const secondStart = deriveStandaloneProject(second, { configDir });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(confirmMock).toHaveBeenCalledTimes(1);

      resolveConfirmation(true);
      await expect(firstStart).resolves.toBeDefined();
      await expect(secondStart).rejects.toThrow(
        "Standalone project start cancelled"
      );
    } finally {
      confirmMock.mockReset();
      if (originalIsTTY) {
        Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
    }
  });

  it("preserves Linear label filters and normalizes overlapping states and labels", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-standalone-config-"));
    const first = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    const second = await mkdtemp(join(tmpdir(), "cli-standalone-project-"));
    await Promise.all([
      writeFile(join(first, "WORKFLOW.md"), linearWorkflow, "utf8"),
      writeFile(
        join(second, "WORKFLOW.md"),
        linearWorkflow
          .replace(" Todo ", "todo")
          .replace("team-a", '" Team-A "'),
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

  it("stops a legacy repo-local daemon before standalone project registration", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-global-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-legacy-project-"));
    const legacyConfigDir = join(projectDir, ".runtime", "orchestrator");
    await mkdir(join(legacyConfigDir, "projects", "repository"), {
      recursive: true,
    });
    await writeFile(
      join(legacyConfigDir, "projects", "repository", "project.json"),
      JSON.stringify({
        projectId: "repository",
        slug: "repository",
        displayName: "Legacy repository",
        projectDir,
        workspaceDir: projectDir,
        repository: { owner: "acme", name: "platform" },
        populateStrategy: "worktree-cache",
        workflowSource: {
          type: "external",
          path: join(projectDir, "WORKFLOW.md"),
        },
        tracker: { adapter: "github-project", bindingId: "PVT_example" },
      })
    );

    await projectCommand(["stop", "--project-dir", projectDir], {
      configDir,
      configDirOverride: false,
      verbose: false,
      json: false,
      noColor: true,
    });

    expect(stopMock).toHaveBeenCalledWith([], {
      configDir: legacyConfigDir,
      configDirOverride: false,
      verbose: false,
      json: false,
      noColor: true,
      invocation: "project",
      projectId: "repository",
    });
  });
});
