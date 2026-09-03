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
  cloneRepositoryForRun,
  ensureIssueWorkspaceRepository,
  loadWorkflowFile,
  removeIssueWorkspaceWorktree,
  renderIssueBranchName,
  releaseRepositoryLock,
  startRepositoryLockHeartbeat,
  syncRepositoryForRun,
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

describe("cloneRepositoryForRun", () => {
  it("falls back to a direct clone when the global cache is unavailable", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-"));
    const repository = await createRepositoryFixture(tempRoot);
    const unavailableConfig = join(tempRoot, "config-file");
    await writeFile(unavailableConfig, "not a directory");
    process.env.GH_SYMPHONY_CONFIG_DIR = unavailableConfig;

    const onCacheUnavailable = vi.fn();
    const repositoryDirectory = await cloneRepositoryForRun({
      repository,
      targetDirectory: join(tempRoot, "workspace"),
      onCacheUnavailable,
    });

    expect(
      await readFile(join(repositoryDirectory, "WORKFLOW.md"), "utf8")
    ).toContain('project_id: "PVT_test"');
    await expect(
      access(join(repositoryDirectory, ".git", "objects", "info", "alternates"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(onCacheUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ name: "RepositoryCacheUnavailableError" })
    );
  });

  it("serializes concurrent cache clones for the same repository", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-"));
    const repository = await createRepositoryFixture(tempRoot);
    const targetDirectory = join(tempRoot, "cache");

    const [first, second] = await Promise.all([
      cloneRepositoryForRun({
        repository,
        targetDirectory,
      }),
      cloneRepositoryForRun({
        repository,
        targetDirectory,
      }),
    ]);

    expect(first).toBe(join(targetDirectory, "repository"));
    expect(second).toBe(join(targetDirectory, "repository"));
    expect(await readFile(join(first, "WORKFLOW.md"), "utf8")).toContain(
      'project_id: "PVT_test"'
    );
  });

  it("replaces partial repository debris before cloning", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-"));
    const repository = await createRepositoryFixture(tempRoot);
    const targetDirectory = join(tempRoot, "cache");
    const repositoryDirectory = join(targetDirectory, "repository");

    await mkdir(repositoryDirectory, { recursive: true });
    await writeFile(join(repositoryDirectory, "broken.txt"), "partial clone");

    const clonedDirectory = await cloneRepositoryForRun({
      repository,
      targetDirectory,
    });

    expect(clonedDirectory).toBe(repositoryDirectory);
    expect(
      await readFile(join(clonedDirectory, "WORKFLOW.md"), "utf8")
    ).toContain('project_id: "PVT_test"');
  });

  it("keeps new workspaces usable after the global cache is removed", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-"));
    const repository = await createRepositoryFixture(tempRoot);
    const targetDirectory = join(tempRoot, "workspace");
    const repositoryDirectory = await cloneRepositoryForRun({
      repository,
      targetDirectory,
    });
    const bareDirectory = globalBareRepositoryDirectory({ repository });

    await expect(
      access(join(repositoryDirectory, ".git", "objects", "info", "alternates"))
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await rm(bareDirectory, { recursive: true, force: true });
    expect(
      execSync(`git -C "${repositoryDirectory}" log --oneline -1`, {
        encoding: "utf8",
      })
    ).toContain("Add workflow");
  });

  it("does not persist clone URL credentials in a workspace remote", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-"));
    const fixture = await createRepositoryFixture(tempRoot);
    const repository = {
      ...fixture,
      cloneUrl: `file://x-access-token:secret-token@localhost${fixture.cloneUrl}`,
    };
    const repositoryDirectory = await cloneRepositoryForRun({
      repository,
      targetDirectory: join(tempRoot, "workspace"),
    });

    const origin = execSync(
      `git -C "${repositoryDirectory}" remote get-url origin`,
      { encoding: "utf8" }
    ).trim();
    expect(origin).not.toContain("secret-token");
    expect(origin).not.toContain("x-access-token@");
  });

  it("reports whether a cached repository pull changed HEAD", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-sync-"));
    const repository = await createRepositoryFixture(tempRoot);
    const targetDirectory = join(tempRoot, "cache");

    const first = await syncRepositoryForRun({
      repository,
      targetDirectory,
    });
    const second = await syncRepositoryForRun({
      repository,
      targetDirectory,
    });

    await writeFile(
      join(repository.path, "WORKFLOW.md"),
      "# updated\n",
      "utf8"
    );
    execSync(`git -C "${repository.path}" add WORKFLOW.md`);
    execSync(`git -C "${repository.path}" commit -m "Update workflow"`);
    execSync(`git -C "${repository.path}" push origin HEAD`);

    const third = await syncRepositoryForRun({
      repository,
      targetDirectory,
    });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(third.changed).toBe(true);
  });

  it("preserves dirty existing issue workspaces instead of recloning", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-issue-"));
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "acme_platform_1");
    const repositoryDirectory = join(issueWorkspacePath, "repository");

    await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath,
      existingWorkspace: false,
    });
    await writeFile(
      join(repositoryDirectory, "WORKFLOW.md"),
      "# local dirty edit\n",
      "utf8"
    );
    await writeFile(
      join(repository.path, "WORKFLOW.md"),
      "# remote edit\n",
      "utf8"
    );
    execSync(`git -C "${repository.path}" add WORKFLOW.md`);
    execSync(
      `git -C "${repository.path}" commit -m "Update workflow remotely"`
    );

    await expect(
      ensureIssueWorkspaceRepository({
        repository,
        issueWorkspacePath,
        existingWorkspace: true,
      })
    ).rejects.toThrow(
      /was preserved because it has uncommitted changes: M WORKFLOW.md/
    );

    expect(
      await readFile(join(repositoryDirectory, "WORKFLOW.md"), "utf8")
    ).toBe("# local dirty edit\n");
    expect(
      execSync(`git -C "${repositoryDirectory}" status --porcelain`, {
        encoding: "utf8",
      })
    ).toContain("M WORKFLOW.md");
  });

  it("pull failures in existing issue workspaces do not delete the checkout", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-issue-"));
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "acme_platform_1");
    const repositoryDirectory = join(issueWorkspacePath, "repository");

    await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath,
      existingWorkspace: false,
    });
    execSync(
      `git -C "${repositoryDirectory}" remote set-url origin "${join(tempRoot, "missing-origin.git")}"`
    );

    await expect(
      ensureIssueWorkspaceRepository({
        repository,
        issueWorkspacePath,
        existingWorkspace: true,
      })
    ).rejects.toThrow(/was preserved because it could not be fast-forwarded/);

    expect(
      await readFile(join(repositoryDirectory, "WORKFLOW.md"), "utf8")
    ).toContain("# Test workflow");
    await expect(
      access(join(repositoryDirectory, ".git"))
    ).resolves.toBeUndefined();
  });

  it("preserves existing issue workspace repository debris without git metadata", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-issue-"));
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "acme_platform_1");
    const repositoryDirectory = join(issueWorkspacePath, "repository");

    await mkdir(repositoryDirectory, { recursive: true });
    await writeFile(join(repositoryDirectory, "artifact.log"), "keep me");

    await expect(
      ensureIssueWorkspaceRepository({
        repository,
        issueWorkspacePath,
        existingWorkspace: true,
      })
    ).rejects.toThrow(
      /was preserved because it exists but is not a git checkout/
    );

    expect(
      await readFile(join(repositoryDirectory, "artifact.log"), "utf8")
    ).toBe("keep me");
    await expect(
      access(join(repositoryDirectory, ".git"))
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("checks out a same-repo pull request head branch for new issue workspaces", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-pr-"));
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "acme_platform_2");

    execSync(`git -C "${repository.path}" checkout -b feature/pr-branch`);
    await writeFile(
      join(repository.path, "WORKFLOW.md"),
      "# pull request workflow\n",
      "utf8"
    );
    execSync(`git -C "${repository.path}" add WORKFLOW.md`);
    execSync(`git -C "${repository.path}" commit -m "Update PR workflow"`);
    execSync(`git -C "${repository.path}" push origin feature/pr-branch`);

    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath,
      existingWorkspace: false,
      pullRequestBranch: {
        headRefName: "feature/pr-branch",
      },
    });

    expect(
      execSync(`git -C "${repositoryDirectory}" branch --show-current`, {
        encoding: "utf8",
      }).trim()
    ).toBe("feature/pr-branch");
    expect(
      await readFile(join(repositoryDirectory, "WORKFLOW.md"), "utf8")
    ).toBe("# pull request workflow\n");
    expect(
      execSync(
        `git -C "${repositoryDirectory}" merge-base origin/main feature/pr-branch`,
        { encoding: "utf8" }
      ).trim()
    ).not.toBe("");
    expect(
      execSync(
        `git -C "${repositoryDirectory}" rev-parse --is-shallow-repository`,
        { encoding: "utf8" }
      ).trim()
    ).toBe("false");
  });

  it("checks out the rendered template branch from the configured base for clone workspaces", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-git-template-")
    );
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "acme_platform_42");

    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath,
      existingWorkspace: false,
      populateStrategy: "clone",
      projectSlug: "acme/platform",
      issueIdentifier: "acme/platform#42",
      branchTemplate: "agents/{project_slug}/{sanitized_issue_id}",
      baseBranch: "main",
    });

    expect(
      execSync(`git -C "${repositoryDirectory}" branch --show-current`, {
        encoding: "utf8",
      }).trim()
    ).toBe("agents/acme-platform/acme-platform-42");
    expect(
      execSync(`git -C "${repositoryDirectory}" rev-parse HEAD`, {
        encoding: "utf8",
      }).trim()
    ).toBe(
      execSync(`git -C "${repositoryDirectory}" rev-parse origin/main`, {
        encoding: "utf8",
      }).trim()
    );
    expect(() =>
      execSync(
        `git -C "${repositoryDirectory}" rev-parse --abbrev-ref --symbolic-full-name @{upstream}`,
        { stdio: "pipe" }
      )
    ).toThrow();
  });

  it("lets a pull request head branch override the clone workspace template", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-git-pr-template-")
    );
    const repository = await createRepositoryFixture(tempRoot);
    execSync(`git -C "${repository.path}" checkout -b feature/pr-template`);
    execSync(`git -C "${repository.path}" push origin feature/pr-template`);

    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath: join(tempRoot, "workspaces", "acme_platform_43"),
      existingWorkspace: false,
      populateStrategy: "clone",
      pullRequestBranch: { headRefName: "feature/pr-template" },
      projectSlug: "acme/platform",
      issueIdentifier: "acme/platform#43",
      branchTemplate: "agents/{project_slug}/{sanitized_issue_id}",
      baseBranch: "main",
    });

    expect(
      execSync(`git -C "${repositoryDirectory}" branch --show-current`, {
        encoding: "utf8",
      }).trim()
    ).toBe("feature/pr-template");
  });

  it("reuses an existing clone workspace already on its template branch", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-git-reuse-template-")
    );
    const repository = await createRepositoryFixture(tempRoot);
    const input = {
      repository,
      issueWorkspacePath: join(tempRoot, "workspaces", "acme_platform_44"),
      populateStrategy: "clone" as const,
      projectSlug: "acme/platform",
      issueIdentifier: "acme/platform#44",
      branchTemplate: "agents/{project_slug}/{sanitized_issue_id}",
      baseBranch: "main",
    };
    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      ...input,
      existingWorkspace: false,
    });
    const before = execSync(
      `git -C "${repositoryDirectory}" reflog -1 --format=%H`,
      {
        encoding: "utf8",
      }
    ).trim();

    const reusedDirectory = await ensureIssueWorkspaceRepository({
      ...input,
      existingWorkspace: true,
    });

    expect(reusedDirectory).toBe(repositoryDirectory);
    expect(
      execSync(`git -C "${repositoryDirectory}" branch --show-current`, {
        encoding: "utf8",
      }).trim()
    ).toBe("agents/acme-platform/acme-platform-44");
    expect(
      execSync(`git -C "${repositoryDirectory}" reflog -1 --format=%H`, {
        encoding: "utf8",
      }).trim()
    ).toBe(before);
  });

  it("reuses a local template branch with unpublished commits when HEAD drifted", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-git-local-template-")
    );
    const repository = await createRepositoryFixture(tempRoot);
    const input = {
      repository,
      issueWorkspacePath: join(tempRoot, "workspaces", "acme_platform_45"),
      populateStrategy: "clone" as const,
      projectSlug: "acme/platform",
      issueIdentifier: "acme/platform#45",
      branchTemplate: "agents/{project_slug}/{sanitized_issue_id}",
      baseBranch: "main",
    };
    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      ...input,
      existingWorkspace: false,
    });
    configureGitIdentity(repositoryDirectory);
    await writeFile(
      join(repositoryDirectory, "agent-work.txt"),
      "unpublished\n",
      "utf8"
    );
    execSync(`git -C "${repositoryDirectory}" add agent-work.txt`);
    execSync(`git -C "${repositoryDirectory}" commit -m "Agent work"`);
    const unpublishedHead = execSync(
      `git -C "${repositoryDirectory}" rev-parse HEAD`,
      {
        encoding: "utf8",
      }
    ).trim();
    execSync(`git -C "${repositoryDirectory}" checkout main`);

    await ensureIssueWorkspaceRepository({ ...input, existingWorkspace: true });

    expect(
      execSync(`git -C "${repositoryDirectory}" branch --show-current`, {
        encoding: "utf8",
      }).trim()
    ).toBe("agents/acme-platform/acme-platform-45");
    expect(
      execSync(`git -C "${repositoryDirectory}" rev-parse HEAD`, {
        encoding: "utf8",
      }).trim()
    ).toBe(unpublishedHead);
  });

  it("fetches the current base before migrating a reused clone", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-git-migrate-template-")
    );
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "acme_platform_46");
    const repositoryDirectory = join(issueWorkspacePath, "repository");
    await mkdir(issueWorkspacePath, { recursive: true });
    execSync(`git clone "${repository.cloneUrl}" "${repositoryDirectory}"`);

    await writeFile(join(repository.path, "upstream.txt"), "current\n", "utf8");
    execSync(`git -C "${repository.path}" add upstream.txt`);
    execSync(`git -C "${repository.path}" commit -m "Advance base"`);
    execSync(`git -C "${repository.path}" push origin main`);
    const currentBase = execSync(`git -C "${repository.path}" rev-parse HEAD`, {
      encoding: "utf8",
    }).trim();

    await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath,
      existingWorkspace: true,
      populateStrategy: "clone",
      projectSlug: "acme/platform",
      issueIdentifier: "acme/platform#46",
      branchTemplate: "agents/{project_slug}/{sanitized_issue_id}",
      baseBranch: "main",
    });

    expect(
      execSync(`git -C "${repositoryDirectory}" rev-parse HEAD`, {
        encoding: "utf8",
      }).trim()
    ).toBe(currentBase);
  });

  it("migrates a reused shallow checkout before checking out a pull request branch", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-pr-"));
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "acme_platform_2");
    const repositoryDirectory = join(issueWorkspacePath, "repository");

    execSync(`git -C "${repository.path}" checkout -b feature/pr-branch`);
    await writeFile(join(repository.path, "feature.txt"), "feature\n", "utf8");
    execSync(`git -C "${repository.path}" add feature.txt`);
    execSync(`git -C "${repository.path}" commit -m "Add feature"`);
    execSync(`git -C "${repository.path}" push origin feature/pr-branch`);

    await mkdir(issueWorkspacePath, { recursive: true });
    execSync(
      `git clone --depth 1 "file://${repository.cloneUrl}" "${repositoryDirectory}"`
    );
    expect(
      execSync(
        `git -C "${repositoryDirectory}" rev-parse --is-shallow-repository`,
        { encoding: "utf8" }
      ).trim()
    ).toBe("true");

    await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath,
      existingWorkspace: true,
      pullRequestBranch: {
        headRefName: "feature/pr-branch",
      },
    });

    expect(
      execSync(
        `git -C "${repositoryDirectory}" rev-parse --is-shallow-repository`,
        { encoding: "utf8" }
      ).trim()
    ).toBe("false");
    expect(
      execSync(
        `git -C "${repositoryDirectory}" merge-base origin/main feature/pr-branch`,
        { encoding: "utf8" }
      ).trim()
    ).not.toBe("");
  });

  it("rebases a pull request branch onto an advanced base without add/add conflicts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-pr-"));
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "acme_platform_2");

    execSync(`git -C "${repository.path}" checkout -b feature/pr-branch`);
    await writeFile(join(repository.path, "feature.txt"), "feature\n", "utf8");
    execSync(`git -C "${repository.path}" add feature.txt`);
    execSync(`git -C "${repository.path}" commit -m "Add feature"`);
    execSync(`git -C "${repository.path}" push origin feature/pr-branch`);

    execSync(`git -C "${repository.path}" checkout main`);
    await writeFile(join(repository.path, "base.txt"), "base\n", "utf8");
    execSync(`git -C "${repository.path}" add base.txt`);
    execSync(`git -C "${repository.path}" commit -m "Advance base"`);
    execSync(`git -C "${repository.path}" push origin main`);

    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath,
      existingWorkspace: false,
      pullRequestBranch: {
        headRefName: "feature/pr-branch",
      },
    });
    execSync(`git -C "${repositoryDirectory}" config user.name "Test User"`);
    execSync(
      `git -C "${repositoryDirectory}" config user.email "test@example.com"`
    );

    expect(() =>
      execSync(`git -C "${repositoryDirectory}" rebase origin/main`)
    ).not.toThrow();
    await expect(
      access(join(repositoryDirectory, "base.txt"))
    ).resolves.toBeUndefined();
    await expect(
      access(join(repositoryDirectory, "feature.txt"))
    ).resolves.toBeUndefined();
  });

  it("keeps pull request branch workspaces reusable on the second cycle", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-pr-"));
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "acme_platform_2");

    execSync(`git -C "${repository.path}" checkout -b feature/pr-branch`);
    await writeFile(
      join(repository.path, "WORKFLOW.md"),
      "# pull request workflow\n",
      "utf8"
    );
    execSync(`git -C "${repository.path}" add WORKFLOW.md`);
    execSync(`git -C "${repository.path}" commit -m "Update PR workflow"`);
    execSync(`git -C "${repository.path}" push origin feature/pr-branch`);

    const firstDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath,
      existingWorkspace: false,
      pullRequestBranch: {
        headRefName: "feature/pr-branch",
      },
    });
    const secondDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath,
      existingWorkspace: true,
      pullRequestBranch: {
        headRefName: "feature/pr-branch",
      },
    });

    expect(secondDirectory).toBe(firstDirectory);
    expect(
      execSync(
        `git -C "${secondDirectory}" rev-parse --abbrev-ref --symbolic-full-name "@{u}"`,
        {
          encoding: "utf8",
        }
      ).trim()
    ).toBe("origin/feature/pr-branch");
    expect(
      execSync(`git -C "${secondDirectory}" branch --show-current`, {
        encoding: "utf8",
      }).trim()
    ).toBe("feature/pr-branch");
  });

  it("updates pull request branch workspaces after a force-push", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-pr-"));
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "acme_platform_2");

    execSync(`git -C "${repository.path}" checkout -b feature/pr-branch`);
    await writeFile(
      join(repository.path, "WORKFLOW.md"),
      "# pull request workflow v1\n",
      "utf8"
    );
    execSync(`git -C "${repository.path}" add WORKFLOW.md`);
    execSync(`git -C "${repository.path}" commit -m "Update PR workflow v1"`);
    execSync(`git -C "${repository.path}" push origin feature/pr-branch`);

    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath,
      existingWorkspace: false,
      pullRequestBranch: {
        headRefName: "feature/pr-branch",
      },
    });

    execSync(`git -C "${repository.path}" checkout feature/pr-branch`);
    execSync(`git -C "${repository.path}" reset --hard HEAD~1`);
    await writeFile(
      join(repository.path, "WORKFLOW.md"),
      "# pull request workflow v2\n",
      "utf8"
    );
    execSync(`git -C "${repository.path}" add WORKFLOW.md`);
    execSync(`git -C "${repository.path}" commit -m "Update PR workflow v2"`);
    execSync(
      `git -C "${repository.path}" push --force origin feature/pr-branch`
    );

    await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath,
      existingWorkspace: true,
      pullRequestBranch: {
        headRefName: "feature/pr-branch",
      },
    });

    expect(
      await readFile(join(repositoryDirectory, "WORKFLOW.md"), "utf8")
    ).toBe("# pull request workflow v2\n");
  });

  it("migrates a dirty shallow workspace before preserving it for recovery", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-pr-"));
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "acme_platform_2");
    const repositoryDirectory = join(issueWorkspacePath, "repository");

    execSync(`git -C "${repository.path}" checkout -b feature/pr-branch`);
    await writeFile(
      join(repository.path, "WORKFLOW.md"),
      "# pull request workflow v1\n",
      "utf8"
    );
    execSync(`git -C "${repository.path}" add WORKFLOW.md`);
    execSync(`git -C "${repository.path}" commit -m "Update PR workflow v1"`);
    execSync(`git -C "${repository.path}" push origin feature/pr-branch`);

    await mkdir(issueWorkspacePath, { recursive: true });
    execSync(
      `git clone --depth 1 --branch feature/pr-branch "file://${repository.cloneUrl}" "${repositoryDirectory}"`
    );
    await writeFile(
      join(repositoryDirectory, "WORKFLOW.md"),
      "# partial recovery work\n",
      "utf8"
    );

    execSync(`git -C "${repository.path}" checkout feature/pr-branch`);
    await writeFile(
      join(repository.path, "WORKFLOW.md"),
      "# pull request workflow v2\n",
      "utf8"
    );
    execSync(`git -C "${repository.path}" add WORKFLOW.md`);
    execSync(`git -C "${repository.path}" commit -m "Update PR workflow v2"`);
    execSync(`git -C "${repository.path}" push origin feature/pr-branch`);

    await expect(
      ensureIssueWorkspaceRepository({
        repository,
        issueWorkspacePath,
        existingWorkspace: true,
        pullRequestBranch: {
          headRefName: "feature/pr-branch",
        },
        allowDirtyExistingWorkspace: true,
      })
    ).resolves.toBe(repositoryDirectory);

    expect(
      execSync(
        `git -C "${repositoryDirectory}" rev-parse --is-shallow-repository`,
        {
          encoding: "utf8",
        }
      ).trim()
    ).toBe("false");
    expect(
      await readFile(join(repositoryDirectory, "WORKFLOW.md"), "utf8")
    ).toBe("# partial recovery work\n");
    expect(
      execSync(`git -C "${repositoryDirectory}" status --porcelain`, {
        encoding: "utf8",
      })
    ).toContain("M WORKFLOW.md");
  });

  it("keeps checkout failures actionable when the pull request branch is missing", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-pr-"));
    const repository = await createRepositoryFixture(tempRoot);
    const issueWorkspacePath = join(tempRoot, "workspaces", "acme_platform_2");

    await expect(
      ensureIssueWorkspaceRepository({
        repository,
        issueWorkspacePath,
        existingWorkspace: false,
        pullRequestBranch: {
          headRefName: "feature/missing-pr-branch",
        },
      })
    ).rejects.toThrow(
      /Cannot checkout pull request branch feature\/missing-pr-branch: git fetch origin feature\/missing-pr-branch failed/
    );
  });

  it("only releases repository locks owned by the current caller", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-lock-"));
    const lockDirectory = join(tempRoot, "repository.lock");

    const firstOwner = await acquireRepositoryLock(lockDirectory);
    await rm(lockDirectory, { recursive: true, force: true });

    const secondOwner = await acquireRepositoryLock(lockDirectory);
    await releaseRepositoryLock(lockDirectory, firstOwner);

    await expect(access(join(lockDirectory, "owner"))).resolves.toBeUndefined();

    await releaseRepositoryLock(lockDirectory, secondOwner);
    await expect(access(lockDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("worktree-cache issue workspaces", () => {
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
      populateStrategy: "worktree-cache",
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
      populateStrategy: "worktree-cache",
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
        populateStrategy: "worktree-cache",
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
      populateStrategy: "worktree-cache",
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
      populateStrategy: "worktree-cache",
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
      populateStrategy: "worktree-cache",
      projectSlug: "project-one",
      issueIdentifier: "acme/platform#12",
    });
    const secondDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath: join(tempRoot, "workspaces", "second"),
      existingWorkspace: false,
      populateStrategy: "worktree-cache",
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
        populateStrategy: "worktree-cache",
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
      populateStrategy: "worktree-cache",
      projectSlug: "project-one",
      issueIdentifier: "acme/platform#7",
    });
    const second = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath: secondWorkspace,
      existingWorkspace: false,
      populateStrategy: "worktree-cache",
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
        populateStrategy: "worktree-cache",
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
      populateStrategy: "worktree-cache",
      projectSlug: "project-one",
      issueIdentifier: "acme/platform#8",
    });
    await writeFile(join(repositoryDirectory, "local.txt"), "preserve");

    await expect(
      ensureIssueWorkspaceRepository({
        repository,
        issueWorkspacePath,
        existingWorkspace: false,
        populateStrategy: "worktree-cache",
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
        populateStrategy: "worktree-cache",
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
      populateStrategy: "worktree-cache" as const,
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
      populateStrategy: "worktree-cache",
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
      populateStrategy: "worktree-cache",
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
