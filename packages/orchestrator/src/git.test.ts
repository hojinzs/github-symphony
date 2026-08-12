import { execSync } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  acquireRepositoryLock,
  cloneRepositoryForRun,
  ensureIssueWorkspaceRepository,
  releaseRepositoryLock,
  syncRepositoryForRun,
} from "./git.js";
import {
  ensureGlobalBareRepositoryCache,
  globalBareRepositoryDirectory,
} from "./repository-cache.js";

describe("global bare repository cache", () => {
  it("serializes concurrent cache initialization for the same repository", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "orchestrator-global-cache-")
    );
    const repository = await createRepositoryFixture(tempRoot);
    const configDir = join(tempRoot, "config");

    const [first, second] = await Promise.all([
      ensureGlobalBareRepositoryCache({ repository, configDir }),
      ensureGlobalBareRepositoryCache({ repository, configDir }),
    ]);

    expect(first).toBe(second);
    expect(
      execSync(`git -C "${first}" rev-parse --is-bare-repository`, {
        encoding: "utf8",
      }).trim()
    ).toBe("true");
    await expect(stat(`${first}.lock`)).rejects.toMatchObject({
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
    await ensureGlobalBareRepositoryCache({
      repository,
      configDir,
      now: new Date(now.getTime() + 31_000),
      requiredRef: "refs/heads/feature/cache-ref",
    });
    expect(
      execSync(
        `git -C "${bareDirectory}" show-ref --verify refs/heads/feature/cache-ref`,
        { encoding: "utf8" }
      )
    ).toContain("refs/heads/feature/cache-ref");
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
    const lockDirectory = `${bareDirectory}.lock`;
    await mkdir(lockDirectory, { recursive: true });
    const staleAt = new Date(Date.now() - 31 * 60 * 1000);
    await utimes(lockDirectory, staleAt, staleAt);

    await expect(
      ensureGlobalBareRepositoryCache({ repository, configDir })
    ).resolves.toBe(bareDirectory);
  });
});

describe("cloneRepositoryForRun", () => {
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
