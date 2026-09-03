import { execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyGitTransportAttempt,
  buildHostGitEnvironment,
  shouldSynchronizeAssignedBranch,
  synchronizeAssignedBranch,
  trySynchronizeAssignedBranch,
} from "./git-transport.js";
import type { GitTransportAttempt } from "./git-transport.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("synchronizeAssignedBranch", { timeout: 15_000 }, () => {
  it("marks a failed host transport as a terminal worker failure", () => {
    const state = {
      status: "completed" as const,
      runPhase: "succeeded" as const,
      lastError: null as string | null,
      unpublishedWorktree: null,
      exitClassification: "completed" as const,
    };

    const exitCode = applyGitTransportAttempt(
      state,
      { ok: false, error: "refusing to push feat/assigned" },
      () => undefined
    );

    expect(state).toEqual({
      status: "failed",
      runPhase: "failed",
      lastError: "git_transport_failed: refusing to push feat/assigned",
      unpublishedWorktree: null,
      exitClassification: "error",
    });
    expect(exitCode).toBe(1);
  });

  it("keeps a successful transport distinct when worktree edits remain unpublished", () => {
    const state = {
      status: "completed" as const,
      runPhase: "succeeded" as const,
      lastError: null as string | null,
      unpublishedWorktree: null,
      exitClassification: "completed" as const,
    };

    const exitCode = applyGitTransportAttempt(
      state,
      {
        ok: true,
        result: {
          branch: "feat/assigned",
          pushed: true,
          head: "deadbeef",
          unpublishedWorktreeChanges: {
            tracked: [" M tracked.txt"],
            untracked: ["untracked/notes.txt"],
            trackedOmitted: 0,
            untrackedOmitted: 0,
          },
        },
      } as GitTransportAttempt,
      () => undefined
    );

    expect(state).toMatchObject({
      status: "completed",
      runPhase: "succeeded",
      lastError: null,
      unpublishedWorktree: {
        branch: "feat/assigned",
        head: "deadbeef",
        tracked: [" M tracked.txt"],
        untracked: ["untracked/notes.txt"],
        trackedOmitted: 0,
        untrackedOmitted: 0,
      },
      exitClassification: "completed",
    });
    expect(exitCode).toBe(0);
  });

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
      unpublishedWorktreeChanges: null,
    });
    await git(root, "clone", "--branch", "feat/assigned", remote, observer);
    const { stdout: remoteHead } = await git(observer, "rev-parse", "HEAD");
    expect(remoteHead.trim()).toBe(expectedHead.trim());
  });

  it("reports tracked and untracked work left unpublished after pushing the branch", async () => {
    const { remote, workspace } = await createGitFixture();
    const trackedFile = join(workspace, "tracked.txt");
    const untrackedFile = join(workspace, "untracked", "notes.txt");
    await writeFile(trackedFile, "committed\n", "utf8");
    await git(workspace, "add", "tracked.txt");
    await git(workspace, "commit", "-m", "agent commit");
    await writeFile(trackedFile, "unpublished tracked edit\n", "utf8");
    await mkdir(join(workspace, "untracked"), { recursive: true });
    await writeFile(untrackedFile, "unpublished untracked edit\n", "utf8");

    const result = await synchronizeAssignedBranch({
      cwd: workspace,
      assignedBranch: "feat/assigned",
      remoteUrl: remote,
    });

    expect(result).toMatchObject({
      branch: "feat/assigned",
      pushed: true,
      unpublishedWorktreeChanges: {
        tracked: [" M tracked.txt"],
        untracked: ["untracked/"],
      },
    });
  });

  it("reports both paths for an unpublished rename after pushing the branch", async () => {
    const { remote, workspace } = await createGitFixture();
    const original = join(workspace, "original.txt");
    await writeFile(original, "committed\n", "utf8");
    await git(workspace, "add", "original.txt");
    await git(workspace, "commit", "-m", "agent commit");
    await git(workspace, "mv", "original.txt", "renamed.txt");

    const result = await synchronizeAssignedBranch({
      cwd: workspace,
      assignedBranch: "feat/assigned",
      remoteUrl: remote,
    });

    expect(result.unpublishedWorktreeChanges).toEqual({
      tracked: ["R  original.txt -> renamed.txt"],
      untracked: [],
      trackedOmitted: 0,
      untrackedOmitted: 0,
    });
  });

  it("bounds unpublished worktree diagnostics while retaining omitted counts", async () => {
    const { remote, workspace } = await createGitFixture();
    await Promise.all(
      Array.from({ length: 11 }, (_, index) =>
        writeFile(
          join(workspace, `untracked-${index}.txt`),
          "unpublished\n",
          "utf8"
        )
      )
    );

    const result = await synchronizeAssignedBranch({
      cwd: workspace,
      assignedBranch: "feat/assigned",
      remoteUrl: remote,
    });

    expect(result.unpublishedWorktreeChanges).toMatchObject({
      tracked: [],
      untrackedOmitted: 3,
    });
    expect(result.unpublishedWorktreeChanges?.untracked).toHaveLength(8);
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

  it("redacts credentials from a failing remote URL", async () => {
    const { workspace } = await createGitFixture();
    const secret = "transport-secret";

    const result = await trySynchronizeAssignedBranch({
      cwd: workspace,
      assignedBranch: "feat/assigned",
      remoteUrl: `http://host-user:${secret}@127.0.0.1:1/repository.git`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected Git transport to fail");
    }
    expect(result.error).not.toContain(secret);
    expect(result.error).not.toContain("host-user");
  });

  it("uses host credential-helper authentication for remote Git operations", async () => {
    const { root, remote, workspace } = await createGitFixture();
    const token = "host-transport-token";
    await git(remote, "config", "http.receivepack", "true");
    const server = await createAuthenticatedGitServer(root, token);
    try {
      await git(workspace, "commit", "--allow-empty", "-m", "agent commit");
      const { stdout: expectedHead } = await git(
        workspace,
        "rev-parse",
        "HEAD"
      );

      const result = await synchronizeAssignedBranch({
        cwd: workspace,
        assignedBranch: "feat/assigned",
        remoteUrl: `${server.url}/${remote.slice(root.length + 1)}`,
        env: {
          ...process.env,
          GITHUB_GRAPHQL_TOKEN: undefined,
          GITHUB_TOKEN_BROKER_URL: undefined,
          GITHUB_TOKEN_BROKER_SECRET: undefined,
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "credential.helper",
          // credential.helper is a list; an empty value resets inherited entries.
          GIT_CONFIG_VALUE_0: "",
          GIT_CONFIG_KEY_1: "credential.helper",
          GIT_CONFIG_VALUE_1: `!f() { if test "$1" = get; then printf 'username=host-user\\npassword=${token}\\n\\n'; fi; }; f`,
        },
      });

      expect(result.head).toBe(expectedHead.trim());
      expect(server.authenticatedPaths).toEqual(
        expect.arrayContaining([
          expect.stringContaining("service=git-upload-pack"),
          expect.stringContaining("git-upload-pack"),
          expect.stringContaining("git-receive-pack"),
        ])
      );
    } finally {
      await server.close();
    }
  });

  it("ignores child-controlled origin fetch and push URLs", async () => {
    const { root, remote, workspace } = await createGitFixture();
    const attackerRemote = join(root, "attacker.git");
    await git(root, "init", "--bare", "--initial-branch=main", attackerRemote);
    await git(workspace, "remote", "set-url", "origin", attackerRemote);
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
    const { root, remote, workspace } = await createGitFixture();
    const marker = join(workspace, "..", "hook-secret.txt");
    const hookDirectory = join(root, "child-hooks");
    await mkdir(hookDirectory, { recursive: true });
    const hook = join(hookDirectory, "pre-push");
    await writeFile(
      hook,
      '#!/bin/sh\nprintf "%s" "$GITHUB_GRAPHQL_TOKEN" > "$HOOK_MARKER"\n'
    );
    await chmod(hook, 0o755);
    await git(workspace, "config", "core.hooksPath", hookDirectory);
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

describe("buildHostGitEnvironment", () => {
  it("preserves configured GHES identity for the credential helper", () => {
    const env = buildHostGitEnvironment({
      GITHUB_GRAPHQL_TOKEN: "host-token",
      GITHUB_GIT_HOST: "github.enterprise.example",
      GITHUB_GIT_USERNAME: "symphony-service",
    });

    expect(env.GITHUB_GIT_HOST).toBe("github.enterprise.example");
    expect(env.GITHUB_GIT_USERNAME).toBe("symphony-service");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toContain("git-credential-helper.js");
  });
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

async function createAuthenticatedGitServer(
  projectRoot: string,
  token: string
) {
  const authenticatedPaths: string[] = [];
  const expectedAuthorization = `Basic ${Buffer.from(`host-user:${token}`).toString("base64")}`;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== expectedAuthorization) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="Git"' });
      response.end();
      return;
    }
    authenticatedPaths.push(request.url ?? "");
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const backend = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: requestUrl.pathname,
        QUERY_STRING: requestUrl.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: request.headers["content-length"] ?? "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    backend.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    backend.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    backend.once("error", (error) => {
      response.writeHead(500);
      response.end(error.message);
    });
    backend.once("close", (exitCode) => {
      const output = Buffer.concat(stdout);
      const separator = output.indexOf("\r\n\r\n");
      if (exitCode !== 0 || separator === -1) {
        response.writeHead(500);
        response.end(Buffer.concat(stderr));
        return;
      }
      const headerLines = output
        .subarray(0, separator)
        .toString("utf8")
        .split("\r\n");
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") {
          status = Number.parseInt(value, 10);
        } else {
          headers[name] = value;
        }
      }
      response.writeHead(status, headers);
      response.end(output.subarray(separator + 4));
    });
    request.pipe(backend.stdin);
  });
  await new Promise<void>((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectServer);
      resolveServer();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    authenticatedPaths,
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      const closed = new Promise<void>((resolveClose) =>
        server.close(() => resolveClose())
      );
      server.closeAllConnections();
      return closed;
    },
  };
}
