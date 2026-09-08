import { execFileSync } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectWorkflowSourceIdentity,
  resolveWorkflowRepositoryDirectory,
} from "./workflow-source-identity.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function createRepository(): Promise<string> {
  const repositoryDirectory = await mkdtemp(
    join(tmpdir(), "workflow-source-repository-")
  );
  git(repositoryDirectory, "init", "-q");
  git(repositoryDirectory, "config", "user.email", "test@example.com");
  git(repositoryDirectory, "config", "user.name", "Test User");
  await writeFile(join(repositoryDirectory, "WORKFLOW.md"), "policy: one\n");
  git(repositoryDirectory, "add", "WORKFLOW.md");
  git(repositoryDirectory, "commit", "-q", "-m", "initial policy");
  return repositoryDirectory;
}

describe("inspectWorkflowSourceIdentity", () => {
  it("classifies a symlink to the repository workflow as linked", async () => {
    const repositoryDirectory = await createRepository();
    const projectDirectory = await mkdtemp(join(tmpdir(), "workflow-project-"));
    const workflowPath = join(projectDirectory, "WORKFLOW.md");
    await symlink(join(repositoryDirectory, "WORKFLOW.md"), workflowPath);

    await expect(
      inspectWorkflowSourceIdentity({ workflowPath, repositoryDirectory })
    ).resolves.toMatchObject({
      relationship: "linked",
      repositoryCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      repositoryRevision: expect.stringMatching(/^sha256:/),
    });
  });

  it("compares a linked working-tree workflow with the committed ref", async () => {
    const repositoryDirectory = await createRepository();
    const projectDirectory = await mkdtemp(join(tmpdir(), "workflow-project-"));
    const workflowPath = join(projectDirectory, "WORKFLOW.md");
    await symlink(join(repositoryDirectory, "WORKFLOW.md"), workflowPath);
    await writeFile(
      join(repositoryDirectory, "WORKFLOW.md"),
      "policy: dirty\n"
    );

    const identity = await inspectWorkflowSourceIdentity({
      workflowPath,
      repositoryDirectory,
    });

    expect(identity).toMatchObject({
      relationship: "linked",
      contentRevision: expect.stringMatching(/^sha256:/),
      repositoryRevision: expect.stringMatching(/^sha256:/),
      repositoryCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(identity.contentRevision).not.toBe(identity.repositoryRevision);
  });

  it("classifies an identical regular-file copy as synchronized", async () => {
    const repositoryDirectory = await createRepository();
    const projectDirectory = await mkdtemp(join(tmpdir(), "workflow-project-"));
    const workflowPath = join(projectDirectory, "WORKFLOW.md");
    await writeFile(workflowPath, "policy: one\n");

    const identity = await inspectWorkflowSourceIdentity({
      workflowPath,
      repositoryDirectory,
    });
    expect(identity.relationship).toBe("synchronized-copy");
    expect(identity.contentRevision).toBe(identity.repositoryRevision);
  });

  it("normalizes line endings when comparing a synchronized copy", async () => {
    const repositoryDirectory = await createRepository();
    const projectDirectory = await mkdtemp(join(tmpdir(), "workflow-project-"));
    const workflowPath = join(projectDirectory, "WORKFLOW.md");
    await writeFile(workflowPath, "policy: one\r\n");

    const identity = await inspectWorkflowSourceIdentity({
      workflowPath,
      repositoryDirectory,
    });

    expect(identity.relationship).toBe("synchronized-copy");
    expect(identity.contentRevision).toBe(identity.repositoryRevision);
  });

  it("reports a repository with no committed policy without warning identity", async () => {
    const repositoryDirectory = await createRepository();
    git(repositoryDirectory, "rm", "WORKFLOW.md");
    git(repositoryDirectory, "commit", "-q", "-m", "remove policy");
    const projectDirectory = await mkdtemp(join(tmpdir(), "workflow-project-"));
    const workflowPath = join(projectDirectory, "WORKFLOW.md");
    await writeFile(workflowPath, "policy: independent\n");

    await expect(
      inspectWorkflowSourceIdentity({ workflowPath, repositoryDirectory })
    ).resolves.toMatchObject({
      relationship: "no-repository-policy",
      contentRevision: expect.stringMatching(/^sha256:/),
      repositoryCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      repositoryRevision: null,
      matchedRepositoryCommit: null,
    });
  });

  it("classifies a copy of a prior repository workflow as stale", async () => {
    const repositoryDirectory = await createRepository();
    const projectDirectory = await mkdtemp(join(tmpdir(), "workflow-project-"));
    const workflowPath = join(projectDirectory, "WORKFLOW.md");
    await writeFile(workflowPath, "policy: one\n");
    await writeFile(join(repositoryDirectory, "WORKFLOW.md"), "policy: two\n");
    git(repositoryDirectory, "add", "WORKFLOW.md");
    git(repositoryDirectory, "commit", "-q", "-m", "update policy");

    const identity = await inspectWorkflowSourceIdentity({
      workflowPath,
      repositoryDirectory,
    });
    expect(identity.relationship).toBe("stale-copy");
    expect(identity.contentRevision).not.toBe(identity.repositoryRevision);
    expect(identity.matchedRepositoryCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("classifies a never-committed copy as independent", async () => {
    const repositoryDirectory = await createRepository();
    const projectDirectory = await mkdtemp(join(tmpdir(), "workflow-project-"));
    const workflowPath = join(projectDirectory, "WORKFLOW.md");
    await writeFile(workflowPath, "policy: independent\n");

    await expect(
      inspectWorkflowSourceIdentity({ workflowPath, repositoryDirectory })
    ).resolves.toMatchObject({
      relationship: "independent",
      matchedRepositoryCommit: null,
    });
  });

  it("requests full reachable history when matching a stale copy", async () => {
    const repositoryDirectory = await createRepository();
    const projectDirectory = await mkdtemp(join(tmpdir(), "workflow-project-"));
    const workflowPath = join(projectDirectory, "WORKFLOW.md");
    await writeFile(workflowPath, "policy: independent\n");
    const calls: string[][] = [];

    await inspectWorkflowSourceIdentity({
      workflowPath,
      repositoryDirectory,
      dependencies: {
        execGit: async (cwd, args) => {
          calls.push(args);
          return git(cwd, ...args);
        },
      },
    });

    expect(calls).toContainEqual([
      "rev-list",
      "--full-history",
      "HEAD",
      "--",
      "WORKFLOW.md",
    ]);
  });
});

describe("resolveWorkflowRepositoryDirectory", () => {
  it("uses the newest persisted issue checkout for a remote clone URL", async () => {
    const olderRepositoryDirectory = await createRepository();
    const newerRepositoryDirectory = await createRepository();
    await expect(
      resolveWorkflowRepositoryDirectory({
        repository: {
          owner: "acme",
          name: "widgets",
          cloneUrl: "https://github.com/acme/widgets.git",
        },
        issueWorkspaces: [
          {
            workspaceKey: "older",
            projectId: "tenant-a",
            adapter: "github-project",
            issueSubjectId: "issue-1",
            issueIdentifier: "acme/widgets#1",
            workspacePath: "/workspaces/older",
            repositoryPath: olderRepositoryDirectory,
            status: "active",
            createdAt: "2026-09-08T00:00:00Z",
            updatedAt: "2026-09-08T00:00:00Z",
            lastError: null,
          },
          {
            workspaceKey: "newer",
            projectId: "tenant-a",
            adapter: "github-project",
            issueSubjectId: "issue-2",
            issueIdentifier: "acme/widgets#2",
            workspacePath: "/workspaces/newer",
            repositoryPath: newerRepositoryDirectory,
            status: "active",
            createdAt: "2026-09-08T00:00:00Z",
            updatedAt: "2026-09-08T01:00:00Z",
            lastError: null,
          },
        ],
      })
    ).resolves.toBe(newerRepositoryDirectory);
  });

  it("skips newer removed and missing workspace records", async () => {
    const removedRepositoryDirectory = await createRepository();
    const availableRepositoryDirectory = await createRepository();
    const workspace = (input: {
      key: string;
      path: string;
      status: "active" | "removed";
      updatedAt: string;
    }) => ({
      workspaceKey: input.key,
      projectId: "tenant-a",
      adapter: "github-project" as const,
      issueSubjectId: `issue-${input.key}`,
      issueIdentifier: `acme/widgets#${input.key}`,
      workspacePath: `/workspaces/${input.key}`,
      repositoryPath: input.path,
      status: input.status,
      createdAt: "2026-09-08T00:00:00Z",
      updatedAt: input.updatedAt,
      lastError: null,
    });

    await expect(
      resolveWorkflowRepositoryDirectory({
        repository: {
          owner: "acme",
          name: "widgets",
          cloneUrl: "https://github.com/acme/widgets.git",
        },
        issueWorkspaces: [
          workspace({
            key: "removed",
            path: removedRepositoryDirectory,
            status: "removed",
            updatedAt: "2026-09-08T03:00:00Z",
          }),
          workspace({
            key: "missing",
            path: "/workspaces/missing/repository",
            status: "active",
            updatedAt: "2026-09-08T02:00:00Z",
          }),
          workspace({
            key: "available",
            path: availableRepositoryDirectory,
            status: "active",
            updatedAt: "2026-09-08T01:00:00Z",
          }),
        ],
      })
    ).resolves.toBe(availableRepositoryDirectory);
  });

  it("does not use the process cwd as evidence for a remote repository", async () => {
    await expect(
      resolveWorkflowRepositoryDirectory({
        repository: {
          owner: "acme",
          name: "widgets",
          cloneUrl: "https://github.com/acme/widgets.git",
        },
        baseDirectory: "/unrelated/operator/repository",
      })
    ).resolves.toBeNull();
  });
});
