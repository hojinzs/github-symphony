import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { synchronizeAssignedBranch } from "./git-transport.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("synchronizeAssignedBranch", () => {
  it("fetches and pushes an agent-local commit to the assigned branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-git-transport-"));
    tempRoots.push(root);
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    const workspace = join(root, "workspace");
    const observer = join(root, "observer");

    await git(root, "init", "--bare", remote);
    await git(root, "init", "-b", "main", seed);
    await git(seed, "config", "user.name", "Symphony Test");
    await git(seed, "config", "user.email", "symphony@example.com");
    await git(seed, "commit", "--allow-empty", "-m", "initial");
    await git(seed, "remote", "add", "origin", remote);
    await git(seed, "push", "origin", "main");
    await git(root, "clone", remote, workspace);
    await git(workspace, "switch", "-c", "feat/assigned");
    await git(workspace, "config", "user.name", "Symphony Test");
    await git(workspace, "config", "user.email", "symphony@example.com");
    await git(workspace, "commit", "--allow-empty", "-m", "agent commit");
    const { stdout: expectedHead } = await git(workspace, "rev-parse", "HEAD");

    const result = await synchronizeAssignedBranch({ cwd: workspace });

    expect(result).toEqual({
      branch: "feat/assigned",
      pushed: true,
      head: expectedHead.trim(),
    });
    await git(root, "clone", "--branch", "feat/assigned", remote, observer);
    const { stdout: remoteHead } = await git(observer, "rev-parse", "HEAD");
    expect(remoteHead.trim()).toBe(expectedHead.trim());
  });
});

async function git(cwd: string, ...args: string[]) {
  return await execFileAsync("git", args, { cwd });
}
