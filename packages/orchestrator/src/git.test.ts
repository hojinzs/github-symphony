import { execSync } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  acquireRepositoryLock,
  cloneRepositoryForRun,
  releaseRepositoryLock,
  syncRepositoryForRun,
} from "./git.js";

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
    expect(await readFile(join(clonedDirectory, "WORKFLOW.md"), "utf8")).toContain(
      'project_id: "PVT_test"'
    );
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

    await writeFile(join(repository.path, "WORKFLOW.md"), "# updated\n", "utf8");
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

  it("only releases repository locks owned by the current caller", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "orchestrator-git-lock-"));
    const lockDirectory = join(tempRoot, "repository.lock");

    const firstOwner = await acquireRepositoryLock(lockDirectory);
    await rm(lockDirectory, { recursive: true, force: true });

    const secondOwner = await acquireRepositoryLock(lockDirectory);
    await releaseRepositoryLock(lockDirectory, firstOwner);

    await expect(access(join(lockDirectory, "owner"))).resolves.toBeUndefined();

    await releaseRepositoryLock(lockDirectory, secondOwner);
    await expect(access(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createRepositoryFixture(tempRoot: string) {
  const originPath = join(tempRoot, "origin.git");
  const workingPath = join(tempRoot, "working");

  execSync(`git init --bare "${originPath}"`);
  execSync(`git clone "${originPath}" "${workingPath}"`);
  execSync(`git -C "${workingPath}" config user.name "Test User"`);
  execSync(`git -C "${workingPath}" config user.email "test@example.com"`);

  await writeFile(
    join(workingPath, "WORKFLOW.md"),
    [
      "---",
      'tracker:',
      '  kind: github-project',
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
