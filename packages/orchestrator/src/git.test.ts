import { execSync } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireRepositoryLock,
  ensureIssueWorkspaceRepository,
  loadWorkflowFile,
  removeIssueWorkspaceWorktree,
  renderIssueBranchName,
  releaseRepositoryLock,
  startRepositoryLockHeartbeat,
} from "./git.js";
import {
  ensureGlobalBareRepositoryCache,
  globalBareRepositoryDirectory,
  globalBareRepositoryLockDirectory,
} from "./repository-cache.js";
import { sanitizeRepositoryCloneUrl } from "./repository-url.js";

const originalConfigDir = process.env.GH_SYMPHONY_CONFIG_DIR;
let testConfigDir: string;

beforeEach(async () => {
  testConfigDir = await mkdtemp(join(tmpdir(), "orchestrator-config-"));
  process.env.GH_SYMPHONY_CONFIG_DIR = testConfigDir;
});

afterEach(async () => {
  await rm(testConfigDir, { recursive: true, force: true });
  if (originalConfigDir === undefined) {
    delete process.env.GH_SYMPHONY_CONFIG_DIR;
  } else {
    process.env.GH_SYMPHONY_CONFIG_DIR = originalConfigDir;
  }
});

describe("global bare repository cache", () => {
  it("serializes concurrent cache initialization for the same repository", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-global-cache-")
    );
    const repository = await createRepositoryFixture(tempRoot);
    const configDir = join(tempRoot, "config");
    const lockDirectory = globalBareRepositoryLockDirectory({
      repository,
      configDir,
    });
    await mkdir(dirname(lockDirectory), { recursive: true });
    const ownerToken = await acquireRepositoryLock(lockDirectory);

    const first = ensureGlobalBareRepositoryCache({ repository, configDir });
    const second = ensureGlobalBareRepositoryCache({ repository, configDir });

    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(
      stat(globalBareRepositoryDirectory({ repository, configDir }))
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    await releaseRepositoryLock(lockDirectory, ownerToken);
    const [firstDirectory, secondDirectory] = await Promise.all([
      first,
      second,
    ]);

    expect(firstDirectory).toBe(secondDirectory);
    expect(
      execSync(`git -C "${firstDirectory}" rev-parse --is-bare-repository`, {
        encoding: "utf8",
      }).trim()
    ).toBe("true");
    await expect(
      stat(globalBareRepositoryLockDirectory({ repository, configDir }))
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("skips a fresh fetch but fetches when a required ref is missing", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-global-cache-")
    );
    const repository = await createRepositoryFixture(tempRoot);
    const configDir = join(tempRoot, "config");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const bareDirectory = await ensureGlobalBareRepositoryCache({
      repository,
      configDir,
      now,
    });
    const originalHead = execSync(`git -C "${bareDirectory}" rev-parse HEAD`, {
      encoding: "utf8",
    }).trim();

    await writeFile(join(repository.path, "fresh.txt"), "fresh\n");
    execSync(`git -C "${repository.path}" add fresh.txt`);
    execSync(`git -C "${repository.path}" commit -m "Add fresh commit"`);
    execSync(`git -C "${repository.path}" push origin HEAD`);
    await ensureGlobalBareRepositoryCache({
      repository,
      configDir,
      now: new Date(now.getTime() + 30_000),
    });
    expect(
      execSync(`git -C "${bareDirectory}" rev-parse HEAD`, {
        encoding: "utf8",
      }).trim()
    ).toBe(originalHead);

    execSync(`git -C "${repository.path}" checkout -b feature/cache-ref`);
    execSync(`git -C "${repository.path}" push origin feature/cache-ref`);
    execSync(`git -C "${repository.path}" tag cache-v1`);
    execSync(`git -C "${repository.path}" push origin cache-v1`);
    await ensureGlobalBareRepositoryCache({
      repository,
      configDir,
      now: new Date(now.getTime() + 31_000),
      requiredRef: "refs/heads/feature/cache-ref",
    });
    expect(
      execSync(
        `git -C "${bareDirectory}" show-ref --verify refs/remotes/origin/feature/cache-ref`,
        { encoding: "utf8" }
      )
    ).toContain("refs/remotes/origin/feature/cache-ref");
    expect(
      execSync(
        `git -C "${bareDirectory}" show-ref --verify refs/tags/cache-v1`,
        {
          encoding: "utf8",
        }
      )
    ).toContain("refs/tags/cache-v1");
  });

  it("reclaims stale cache locks using repository lock semantics", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-global-cache-")
    );
    const repository = await createRepositoryFixture(tempRoot);
    const configDir = join(tempRoot, "config");
    const bareDirectory = globalBareRepositoryDirectory({
      repository,
      configDir,
    });
    const lockDirectory = globalBareRepositoryLockDirectory({
      repository,
      configDir,
    });
    await mkdir(lockDirectory, { recursive: true });
    const staleAt = new Date(Date.now() - 31 * 60 * 1000);
    await utimes(lockDirectory, staleAt, staleAt);

    await expect(
      ensureGlobalBareRepositoryCache({ repository, configDir })
    ).resolves.toBe(bareDirectory);
  });

  it("keeps a cache lock fresh while a long operation is running", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-global-cache-")
    );
    const lockDirectory = join(tempRoot, "platform.lock");
    const ownerToken = await acquireRepositoryLock(lockDirectory);
    const staleAt = new Date(Date.now() - 31 * 60 * 1000);
    await utimes(lockDirectory, staleAt, staleAt);

    const heartbeat = startRepositoryLockHeartbeat(
      lockDirectory,
      ownerToken,
      10
    );
    await new Promise((resolve) => setTimeout(resolve, 35));
    const refreshed = await stat(lockDirectory);
    await heartbeat.stop();
    await releaseRepositoryLock(lockDirectory, ownerToken);

    expect(Date.now() - refreshed.mtimeMs).toBeLessThan(1_000);
  });

  it("recreates a cache with a missing origin remote under its lock", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-global-cache-")
    );
    const repository = await createRepositoryFixture(tempRoot);
    const configDir = join(tempRoot, "config");
    const bareDirectory = await ensureGlobalBareRepositoryCache({
      repository,
      configDir,
    });
    execSync(`git -C "${bareDirectory}" remote remove origin`);

    await ensureGlobalBareRepositoryCache({ repository, configDir });

    expect(
      execSync(`git -C "${bareDirectory}" remote get-url origin`, {
        encoding: "utf8",
      }).trim()
    ).toBe(repository.cloneUrl);
  });

  it("does not persist clone URL credentials in the bare cache remote", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-global-cache-")
    );
    const fixture = await createRepositoryFixture(tempRoot);
    const repository = {
      ...fixture,
      cloneUrl: `file://x-access-token:secret-token@localhost${fixture.cloneUrl}`,
    };
    const bareDirectory = await ensureGlobalBareRepositoryCache({ repository });

    const origin = execSync(`git -C "${bareDirectory}" remote get-url origin`, {
      encoding: "utf8",
    }).trim();
    expect(origin).not.toContain("secret-token");
    expect(origin).not.toContain("x-access-token@");
  });

  it("rejects unsafe repository path segments", () => {
    expect(() =>
      globalBareRepositoryDirectory({
        repository: { owner: "../outside", name: "platform" },
      })
    ).toThrow(/Invalid repository owner/);
  });
});

describe("issue workspaces", () => {
  it("falls back to a direct clone with the project branch when the cache is unavailable", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-worktree-"));
    const repository = await createRepositoryFixture(tempRoot);
    const unavailableConfig = join(tempRoot, "config-file");
    await writeFile(unavailableConfig, "not a directory");
    process.env.GH_SYMPHONY_CONFIG_DIR = unavailableConfig;

    const onCacheUnavailable = vi.fn();
    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath: join(tempRoot, "workspace"),
      existingWorkspace: false,
      projectSlug: "fallback-project",
      issueIdentifier: "588",
      baseBranch: "main",
      onCacheUnavailable,
    });

    expect(
      execSync(`git -C "${repositoryDirectory}" branch --show-current`, {
        encoding: "utf8",
      }).trim()
    ).toBe("symphony/fallback-project/588");
    expect(
      await readFile(join(repositoryDirectory, "WORKFLOW.md"), "utf8")
    ).toContain('project_id: "PVT_test"');
    expect(onCacheUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ name: "RepositoryCacheUnavailableError" })
    );

    await expect(
      removeIssueWorkspaceWorktree({
        repository,
        repositoryDirectory,
        projectSlug: "fallback-project",
        issueIdentifier: "588",
      })
    ).resolves.toBeUndefined();
    await expect(access(repositoryDirectory)).resolves.toBeUndefined();
  });

  it("populates, reuses, and removes a project-scoped worktree", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-worktree-"));
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "issue-1");

    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath,
      existingWorkspace: false,
      projectSlug: "project-one",
      issueIdentifier: "acme/platform#1",
    });

    expect(
      execSync(`git -C "${repositoryDirectory}" branch --show-current`, {
        encoding: "utf8",
      }).trim()
    ).toBe("symphony/project-one/acme-platform-1");
    await expect(
      ensureIssueWorkspaceRepository({
        repository,
        issueWorkspacePath,
        existingWorkspace: true,
      })
    ).resolves.toBe(repositoryDirectory);

    configureGitIdentity(repositoryDirectory);
    await writeFile(join(repositoryDirectory, "unpushed.txt"), "keep\n");
    execSync(`git -C "${repositoryDirectory}" add unpushed.txt`);
    execSync(`git -C "${repositoryDirectory}" commit -m "Keep unpushed work"`);
    const unpushedCommit = execSync(
      `git -C "${repositoryDirectory}" rev-parse HEAD`,
      { encoding: "utf8" }
    ).trim();
    const cleanupResults: unknown[] = [];
    await removeIssueWorkspaceWorktree({
      repository,
      repositoryDirectory,
      projectSlug: "project-one",
      issueIdentifier: "acme/platform#1",
      onBranchCleanup: (result) => cleanupResults.push(result),
    });
    await expect(access(repositoryDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      removeIssueWorkspaceWorktree({
        repository,
        repositoryDirectory,
        projectSlug: "project-one",
        issueIdentifier: "acme/platform#1",
      })
    ).resolves.toBeUndefined();
    const bareDirectory = globalBareRepositoryDirectory({ repository });
    expect(
      execSync(
        `git -C "${bareDirectory}" show-ref --verify refs/heads/symphony/project-one/acme-platform-1`,
        { encoding: "utf8" }
      )
    ).toContain("refs/heads/symphony/project-one/acme-platform-1");
    expect(cleanupResults).toContainEqual({
      branch: "symphony/project-one/acme-platform-1",
      outcome: "retained",
      reason: "unreachable-from-origin",
    });
    const revivedDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath: join(tempRoot, "workspaces", "issue-1-revived"),
      existingWorkspace: false,
      projectSlug: "project-one",
      issueIdentifier: "acme/platform#1",
    });
    expect(revivedDirectory).toBe(
      join(tempRoot, "workspaces", "issue-1-revived", "repository")
    );
    expect(
      execSync(`git -C "${revivedDirectory}" rev-parse HEAD`, {
        encoding: "utf8",
      }).trim()
    ).toBe(unpushedCommit);
  });

  it("collects a pushed branch created from a configured template", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-worktree-"));
    const repository = await createRepositoryFixture(tempRoot);
    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath: join(tempRoot, "workspaces", "custom-template"),
      existingWorkspace: false,
      projectSlug: "project-one",
      issueIdentifier: "acme/platform#14",
      branchTemplate: "agents/{project_slug}/{sanitized_issue_id}",
    });
    const branch = "agents/project-one/acme-platform-14";
    execSync(`git -C "${repositoryDirectory}" push origin ${branch}`);

    await removeIssueWorkspaceWorktree({
      repository,
      repositoryDirectory,
      projectSlug: "project-one",
      issueIdentifier: "acme/platform#14",
    });

    const bareDirectory = globalBareRepositoryDirectory({ repository });
    expect(() =>
      execSync(
        `git -C "${bareDirectory}" show-ref --verify refs/heads/${branch}`
      )
    ).toThrow();
  });

  it("collects pushed agent branches but retains branches linked to another worktree", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-worktree-"));
    const repository = await createRepositoryFixture(tempRoot);
    const firstDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath: join(tempRoot, "workspaces", "first"),
      existingWorkspace: false,
      projectSlug: "project-one",
      issueIdentifier: "acme/platform#12",
    });
    const secondDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath: join(tempRoot, "workspaces", "second"),
      existingWorkspace: false,
      projectSlug: "project-one",
      issueIdentifier: "acme/platform#13",
    });

    configureGitIdentity(firstDirectory);
    execSync(`git -C "${firstDirectory}" checkout -b feat/592-pushed`);
    await writeFile(join(firstDirectory, "pushed.txt"), "pushed\n");
    execSync(`git -C "${firstDirectory}" add pushed.txt`);
    execSync(`git -C "${firstDirectory}" commit -m "Add pushed work"`);
    execSync(`git -C "${firstDirectory}" push origin feat/592-pushed`);
    execSync(`git -C "${secondDirectory}" checkout -b symphony/issue-active`);

    const cleanupResults: unknown[] = [];
    await removeIssueWorkspaceWorktree({
      repository,
      repositoryDirectory: firstDirectory,
      projectSlug: "project-one",
      issueIdentifier: "acme/platform#12",
      onBranchCleanup: (result) => cleanupResults.push(result),
    });

    const bareDirectory = globalBareRepositoryDirectory({ repository });
    expect(() =>
      execSync(
        `git -C "${bareDirectory}" show-ref --verify refs/heads/feat/592-pushed`
      )
    ).toThrow();
    expect(
      execSync(
        `git -C "${bareDirectory}" show-ref --verify refs/heads/symphony/issue-active`,
        { encoding: "utf8" }
      )
    ).toContain("refs/heads/symphony/issue-active");
    expect(cleanupResults).toContainEqual({
      branch: "feat/592-pushed",
      outcome: "deleted",
      reason: null,
    });
    expect(cleanupResults).toContainEqual({
      branch: "symphony/issue-active",
      outcome: "retained",
      reason: "linked-worktree",
    });
  });

  it("requires a project-scoped identity for fresh worktree population", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-worktree-"));
    const repository = await createRepositoryFixture(tempRoot);

    await expect(
      ensureIssueWorkspaceRepository({
        repository,
        issueWorkspacePath: join(tempRoot, "workspaces", "missing-identity"),
        existingWorkspace: false,
      })
    ).rejects.toThrow(
      "worktree-cache populate requires projectSlug and issueIdentifier"
    );
  });

  it("namespaces identical issue identifiers by project and preserves failed reuse", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-worktree-"));
    const repository = await createRepositoryFixture(tempRoot);
    const firstWorkspace = join(tempRoot, "workspaces", "first");
    const secondWorkspace = join(tempRoot, "workspaces", "second");
    const invalidWorkspace = join(tempRoot, "workspaces", "invalid");

    const first = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath: firstWorkspace,
      existingWorkspace: false,
      projectSlug: "project-one",
      issueIdentifier: "acme/platform#7",
    });
    const second = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath: secondWorkspace,
      existingWorkspace: false,
      projectSlug: "project-two",
      issueIdentifier: "acme/platform#7",
    });
    expect(readGitBranch(first)).toBe("symphony/project-one/acme-platform-7");
    expect(readGitBranch(second)).toBe("symphony/project-two/acme-platform-7");

    await mkdir(join(invalidWorkspace, "repository"), { recursive: true });
    await writeFile(join(invalidWorkspace, "repository", "keep"), "preserve");
    await expect(
      ensureIssueWorkspaceRepository({
        repository,
        issueWorkspacePath: invalidWorkspace,
        existingWorkspace: true,
      })
    ).rejects.toThrow(/was preserved/);
    await expect(
      readFile(join(invalidWorkspace, "repository", "keep"), "utf8")
    ).resolves.toBe("preserve");
  });

  it("keeps existing recovered worktrees and their branches on cache refresh", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-worktree-"));
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "recovered");
    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath,
      existingWorkspace: false,
      projectSlug: "project-one",
      issueIdentifier: "acme/platform#8",
    });
    await writeFile(join(repositoryDirectory, "local.txt"), "preserve");

    await expect(
      ensureIssueWorkspaceRepository({
        repository,
        issueWorkspacePath,
        existingWorkspace: false,
      })
    ).resolves.toBe(repositoryDirectory);
    await ensureGlobalBareRepositoryCache({
      repository,
      now: new Date(Date.now() + 61_000),
    });

    expect(readGitBranch(repositoryDirectory)).toBe(
      "symphony/project-one/acme-platform-8"
    );
    await expect(
      readFile(join(repositoryDirectory, "local.txt"), "utf8")
    ).resolves.toBe("preserve");
  });

  it("repopulates after cleanup when a workspace record outlives its directory", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-worktree-"));
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "revived");

    await expect(
      ensureIssueWorkspaceRepository({
        repository,
        issueWorkspacePath,
        existingWorkspace: true,
        projectSlug: "project-one",
        issueIdentifier: "acme/platform#10",
      })
    ).resolves.toBe(join(issueWorkspacePath, "repository"));
  });

  it("recovers a quarantined workspace whose owned branch remains in the cache", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-worktree-"));
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "quarantined");
    const input = {
      repository,
      issueWorkspacePath,
      existingWorkspace: false,
      projectSlug: "project-one",
      issueIdentifier: "acme/platform#11",
    };
    await ensureIssueWorkspaceRepository(input);

    await rename(issueWorkspacePath, `${issueWorkspacePath}.quarantine`);

    const recoveredDirectory = await ensureIssueWorkspaceRepository(input);
    expect(recoveredDirectory).toBe(join(issueWorkspacePath, "repository"));
    expect(readGitBranch(recoveredDirectory)).toBe(
      "symphony/project-one/acme-platform-11"
    );
  });

  it("uses origin's default branch when no base branch is configured", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-worktree-"));
    const originPath = join(tempRoot, "origin.git");
    const workingPath = join(tempRoot, "working");
    execSync(`git init --initial-branch=master --bare "${originPath}"`);
    execSync(`git clone "${originPath}" "${workingPath}"`);
    execSync(`git -C "${workingPath}" config user.name "Test User"`);
    execSync(`git -C "${workingPath}" config user.email "test@example.com"`);
    await writeFile(join(workingPath, "README.md"), "master\n");
    execSync(`git -C "${workingPath}" add README.md`);
    execSync(`git -C "${workingPath}" commit -m "Initial commit"`);
    execSync(`git -C "${workingPath}" push origin master`);

    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository: { owner: "acme", name: "master-repo", cloneUrl: originPath },
      issueWorkspacePath: join(tempRoot, "workspaces", "master"),
      existingWorkspace: false,
      projectSlug: "project-one",
      issueIdentifier: "acme/master-repo#1",
    });

    await expect(
      readFile(join(repositoryDirectory, "README.md"), "utf8")
    ).resolves.toBe("master\n");
  });

  it("creates a project-scoped branch from a pull request checkout target", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-worktree-"));
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "pr-target");
    execSync(`git -C "${repository.path}" checkout -b feature/pr-branch`);
    await writeFile(join(repository.path, "pr.txt"), "pull request\n");
    execSync(`git -C "${repository.path}" add pr.txt`);
    execSync(`git -C "${repository.path}" commit -m "Add PR commit"`);
    execSync(`git -C "${repository.path}" push origin feature/pr-branch`);

    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath,
      existingWorkspace: false,
      projectSlug: "project-one",
      issueIdentifier: "acme/platform#9",
      pullRequestBranch: { headRefName: "feature/pr-branch" },
    });

    expect(readGitBranch(repositoryDirectory)).toBe(
      "symphony/project-one/acme-platform-9"
    );
    await expect(
      readFile(join(repositoryDirectory, "pr.txt"), "utf8")
    ).resolves.toBe("pull request\n");
  });

  it("supports a front matter branch template", () => {
    expect(
      renderIssueBranchName({
        template: "agents/{project_slug}/{sanitized_issue_id}",
        projectSlug: "project one",
        issueIdentifier: "acme/repo#42",
      })
    ).toBe("agents/project-one/acme-repo-42");
  });
});

function readGitBranch(repositoryDirectory: string): string {
  return execSync(`git -C "${repositoryDirectory}" branch --show-current`, {
    encoding: "utf8",
  }).trim();
}

function configureGitIdentity(repositoryDirectory: string): void {
  execSync(`git -C "${repositoryDirectory}" config user.name "Test User"`);
  execSync(
    `git -C "${repositoryDirectory}" config user.email "test@example.com"`
  );
}

describe("sanitizeRepositoryCloneUrl", () => {
  it("removes embedded credentials before Git can persist the remote", () => {
    expect(
      sanitizeRepositoryCloneUrl(
        "https://x-access-token:secret-token@github.com/acme/platform.git"
      )
    ).toBe("https://github.com/acme/platform.git");
  });
});

describe("loadWorkflowFile", () => {
  it("rejects a custom auth name declared by the selected tracker adapter", async () => {
    const workflowPath = join(testConfigDir, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: file
runtime:
  kind: custom
  command: node
  auth:
    env: TRACKER_SECRET
---
Prompt`,
      "utf8"
    );

    const trackerAdapter = {
      secretEnvironmentNames: () => ["TRACKER_SECRET"],
    };
    const resolution = await loadWorkflowFile(
      workflowPath,
      process.env,
      trackerAdapter
    );

    expect(resolution).toMatchObject({
      isValid: false,
      validationError: expect.stringMatching(
        /runtime\.auth\.env.*reserved credential.*TRACKER_SECRET/i
      ),
    });
  });

  it("uses the selected tracker adapter for provider validation", async () => {
    const workflowPath = join(testConfigDir, "WORKFLOW.md");
    const validateProviderConfig = vi.fn(() => []);
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: file
  provider:
    issues_path: /tmp/issues.json
    state_field: Status
  active_states:
    - Ready
  terminal_states:
    - Done
codex:
  command: codex
---
Prompt`,
      "utf8"
    );

    const resolution = await loadWorkflowFile(workflowPath, process.env, {
      validateProviderConfig,
    });

    expect(resolution.isValid).toBe(true);
    expect(validateProviderConfig).toHaveBeenCalledWith(
      {
        issues_path: "/tmp/issues.json",
        state_field: "Status",
      },
      {
        rawProvider: {
          issues_path: "/tmp/issues.json",
          state_field: "Status",
        },
      }
    );
  });
});

async function createRepositoryFixture(tempRoot: string) {
  const originPath = join(tempRoot, "origin.git");
  const workingPath = join(tempRoot, "working");

  execSync(`git init --initial-branch=main --bare "${originPath}"`);
  execSync(`git clone "${originPath}" "${workingPath}"`);
  execSync(`git -C "${workingPath}" config user.name "Test User"`);
  execSync(`git -C "${workingPath}" config user.email "test@example.com"`);

  await writeFile(
    join(workingPath, "WORKFLOW.md"),
    [
      "---",
      "tracker:",
      "  kind: github-project",
      '  project_id: "PVT_test"',
      '  state_field: "Status"',
      '  active_states: ["Todo"]',
      '  terminal_states: ["Done"]',
      "---",
      "",
      "# Test workflow",
      "",
    ].join("\n"),
    "utf8"
  );

  execSync(`git -C "${workingPath}" add WORKFLOW.md`);
  execSync(`git -C "${workingPath}" commit -m "Add workflow"`);
  execSync(`git -C "${workingPath}" push origin HEAD`);

  return {
    owner: "acme",
    name: "platform",
    cloneUrl: originPath,
    path: workingPath,
  };
}
