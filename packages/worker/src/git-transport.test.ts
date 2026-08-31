import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  shouldSynchronizeAssignedBranch,
  synchronizeAssignedBranch,
  trySynchronizeAssignedBranch,
} from "./git-transport.js";

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

    await git(root, "init", "--bare", "--initial-branch=main", remote);
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

    const result = await synchronizeAssignedBranch({
      cwd: workspace,
      assignedBranch: "feat/assigned",
      remoteUrl: remote,
    });

    expect(result).toEqual({
      branch: "feat/assigned",
      pushed: true,
      head: expectedHead.trim(),
    });
    await git(root, "clone", "--branch", "feat/assigned", remote, observer);
    const { stdout: remoteHead } = await git(observer, "rev-parse", "HEAD");
    expect(remoteHead.trim()).toBe(expectedHead.trim());
  });

  it("refuses a host-authenticated push when the child moved off the assigned branch", async () => {
    const { remote, workspace } = await createGitFixture();
    await git(workspace, "switch", "main");
    await git(workspace, "commit", "--allow-empty", "-m", "wrong branch");
    const { stdout: remoteMainBefore } = await git(
      remote,
      "rev-parse",
      "refs/heads/main"
    );

    await expect(
      synchronizeAssignedBranch({
        cwd: workspace,
        assignedBranch: "feat/assigned",
        remoteUrl: remote,
      })
    ).rejects.toThrow(
      "refusing to push: worktree is on main, expected assigned branch feat/assigned"
    );

    const { stdout: remoteMainAfter } = await git(
      remote,
      "rev-parse",
      "refs/heads/main"
    );
    expect(remoteMainAfter).toBe(remoteMainBefore);
  });

  it("reports detached HEAD as an assigned-worktree state error", async () => {
    const { remote, workspace } = await createGitFixture();
    await git(workspace, "checkout", "--detach");

    await expect(
      synchronizeAssignedBranch({
        cwd: workspace,
        assignedBranch: "feat/assigned",
        remoteUrl: remote,
      })
    ).rejects.toThrow(
      "refusing to push: assigned worktree is in detached HEAD state"
    );
  });

  it("preserves symbolic-ref diagnostics for failures other than detached HEAD", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-git-transport-invalid-"));
    tempRoots.push(root);

    await expect(
      synchronizeAssignedBranch({
        cwd: root,
        assignedBranch: "feat/assigned",
        remoteUrl: join(root, "remote.git"),
      })
    ).rejects.toThrow("not a git repository");
  });

  it("returns a distinct transport failure without throwing after the agent succeeded", async () => {
    const { workspace } = await createGitFixture();
    const competing = join(workspace, "..", "competing");
    await git(
      join(workspace, ".."),
      "clone",
      join(workspace, "..", "remote.git"),
      competing
    );
    await git(competing, "switch", "-c", "feat/assigned");
    await git(competing, "config", "user.name", "Symphony Test");
    await git(competing, "config", "user.email", "symphony@example.com");
    await git(competing, "commit", "--allow-empty", "-m", "remote advance");
    await git(competing, "push", "origin", "feat/assigned");
    await git(workspace, "commit", "--allow-empty", "-m", "agent commit");

    const result = await trySynchronizeAssignedBranch({
      cwd: workspace,
      assignedBranch: "feat/assigned",
      remoteUrl: join(workspace, "..", "remote.git"),
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("refusing to push feat/assigned"),
    });
  });

  it("ignores a child-controlled origin push URL", async () => {
    const { root, remote, workspace } = await createGitFixture();
    const attackerRemote = join(root, "attacker.git");
    await git(root, "init", "--bare", "--initial-branch=main", attackerRemote);
    await git(
      workspace,
      "remote",
      "set-url",
      "--push",
      "origin",
      attackerRemote
    );
    await git(workspace, "commit", "--allow-empty", "-m", "agent commit");
    const { stdout: expectedHead } = await git(workspace, "rev-parse", "HEAD");

    await synchronizeAssignedBranch({
      cwd: workspace,
      assignedBranch: "feat/assigned",
      remoteUrl: remote,
    });

    const { stdout: remoteHead } = await git(
      remote,
      "rev-parse",
      "refs/heads/feat/assigned"
    );
    expect(remoteHead.trim()).toBe(expectedHead.trim());
    await expect(
      git(attackerRemote, "rev-parse", "refs/heads/feat/assigned")
    ).rejects.toThrow();
  });

  it("does not execute child-controlled pre-push hooks with host secrets", async () => {
    const { remote, workspace } = await createGitFixture();
    const marker = join(workspace, "..", "hook-secret.txt");
    const hook = join(workspace, ".git", "hooks", "pre-push");
    await writeFile(
      hook,
      '#!/bin/sh\nprintf "%s" "$GITHUB_GRAPHQL_TOKEN" > "$HOOK_MARKER"\n'
    );
    await chmod(hook, 0o755);
    await git(workspace, "commit", "--allow-empty", "-m", "agent commit");

    await synchronizeAssignedBranch({
      cwd: workspace,
      assignedBranch: "feat/assigned",
      remoteUrl: remote,
      env: {
        ...process.env,
        GITHUB_GRAPHQL_TOKEN: "host-secret",
        HOOK_MARKER: marker,
      },
    });

    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("shouldSynchronizeAssignedBranch", () => {
  it.each([
    { userInputRequired: false, terminalFailure: false, expected: true },
    { userInputRequired: false, terminalFailure: true, expected: false },
    { userInputRequired: true, terminalFailure: false, expected: false },
  ])(
    "returns $expected for userInputRequired=$userInputRequired terminalFailure=$terminalFailure",
    ({ userInputRequired, terminalFailure, expected }) => {
      expect(
        shouldSynchronizeAssignedBranch({
          userInputRequired,
          terminalFailure,
        })
      ).toBe(expected);
    }
  );
});

async function createGitFixture() {
  const root = await mkdtemp(join(tmpdir(), "worker-git-transport-"));
  tempRoots.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const workspace = join(root, "workspace");
  await git(root, "init", "--bare", "--initial-branch=main", remote);
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
  return { root, remote, workspace };
}

async function git(cwd: string, ...args: string[]) {
  return await execFileAsync("git", args, { cwd });
}
