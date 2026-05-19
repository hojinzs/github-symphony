import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureTurnWorkspaceSnapshot,
  evaluateTurnProgress,
  resolveMaxNonProductiveTurns,
} from "./convergence-detection.js";

describe("convergence detection helpers", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.map(async (path) => rm(path, { recursive: true, force: true }))
    );
    tempRoots.length = 0;
  });

  it("defaults max non-productive turns to 3", () => {
    expect(resolveMaxNonProductiveTurns({})).toBe(3);
    expect(
      resolveMaxNonProductiveTurns({
        SYMPHONY_MAX_NONPRODUCTIVE_TURNS: "0",
      })
    ).toBe(3);
  });

  it("parses configured max non-productive turns", () => {
    expect(
      resolveMaxNonProductiveTurns({
        SYMPHONY_MAX_NONPRODUCTIVE_TURNS: "5",
      })
    ).toBe(5);
  });

  it("captures the git workspace fingerprint from file changes", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "worker-convergence-"));
    tempRoots.push(repoRoot);

    execSync("git init", {
      cwd: repoRoot,
      stdio: "ignore",
    });
    await writeFile(join(repoRoot, "notes.txt"), "hello\n", "utf8");

    const snapshot = captureTurnWorkspaceSnapshot(repoRoot);

    expect(snapshot.fingerprint).toContain("notes.txt");
    expect(snapshot.changedFiles).toEqual(["?? notes.txt"]);
    expect(snapshot.headSha).toBeNull();
  });

  it("captures the git HEAD SHA when a commit exists", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "worker-convergence-"));
    tempRoots.push(repoRoot);

    execSync("git init", {
      cwd: repoRoot,
      stdio: "ignore",
    });
    await writeFile(join(repoRoot, "notes.txt"), "hello\n", "utf8");
    execSync("git add notes.txt", {
      cwd: repoRoot,
      stdio: "ignore",
    });
    execSync(
      'git -c user.name="Test User" -c user.email="test@example.com" -c commit.gpgsign=false commit -m "initial"',
      {
        cwd: repoRoot,
        stdio: "ignore",
      }
    );

    const headSha = execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const snapshot = captureTurnWorkspaceSnapshot(repoRoot);

    expect(snapshot.fingerprint).toBe("");
    expect(snapshot.changedFiles).toEqual([]);
    expect(snapshot.headSha).toBe(headSha);
  });

  it("marks clean snapshots with unchanged HEAD as non-productive", () => {
    expect(
      evaluateTurnProgress(
        {
          fingerprint: "",
          changedFiles: [],
          headSha: "1111111111111111111111111111111111111111",
          lastError: null,
        },
        {
          fingerprint: "",
          changedFiles: [],
          headSha: "1111111111111111111111111111111111111111",
          lastError: null,
        }
      )
    ).toEqual({
      nonProductive: true,
      repeatedPattern: true,
      reason: "workspace unchanged",
      headChanged: false,
      fingerprintUnchanged: true,
    });
  });

  it("treats clean snapshots with changed HEAD as productive", () => {
    expect(
      evaluateTurnProgress(
        {
          fingerprint: "",
          changedFiles: [],
          headSha: "1111111111111111111111111111111111111111",
          lastError: null,
        },
        {
          fingerprint: "",
          changedFiles: [],
          headSha: "2222222222222222222222222222222222222222",
          lastError: null,
        }
      )
    ).toEqual({
      nonProductive: false,
      repeatedPattern: false,
      reason: null,
      headChanged: true,
      fingerprintUnchanged: true,
    });
  });

  it("treats clean snapshots with newly available HEAD as productive", () => {
    expect(
      evaluateTurnProgress(
        {
          fingerprint: "",
          changedFiles: [],
          headSha: null,
          lastError: null,
        },
        {
          fingerprint: "",
          changedFiles: [],
          headSha: "1111111111111111111111111111111111111111",
          lastError: null,
        }
      )
    ).toEqual({
      nonProductive: false,
      repeatedPattern: false,
      reason: null,
      headChanged: true,
      fingerprintUnchanged: true,
    });
  });

  it("marks unchanged dirty workspace snapshots as non-productive", () => {
    expect(
      evaluateTurnProgress(
        {
          fingerprint: "M src/index.ts",
          changedFiles: ["M src/index.ts"],
          headSha: "1111111111111111111111111111111111111111",
          lastError: null,
        },
        {
          fingerprint: "M src/index.ts",
          changedFiles: ["M src/index.ts"],
          headSha: "1111111111111111111111111111111111111111",
          lastError: null,
        }
      )
    ).toEqual({
      nonProductive: true,
      repeatedPattern: true,
      reason: "workspace diff unchanged (1 tracked change)",
      headChanged: false,
      fingerprintUnchanged: true,
    });
  });

  it("marks repeated errors as non-productive even without git state", () => {
    expect(
      evaluateTurnProgress(
        {
          fingerprint: null,
          changedFiles: [],
          headSha: null,
          lastError: "turn_failed: tool execution failed",
        },
        {
          fingerprint: null,
          changedFiles: [],
          headSha: null,
          lastError: "turn_failed: tool execution failed",
        }
      )
    ).toEqual({
      nonProductive: true,
      repeatedPattern: true,
      reason: "repeated error: turn_failed: tool execution failed",
      headChanged: false,
      fingerprintUnchanged: false,
    });
  });

  it("treats changed HEAD as productive even when the last error repeats", () => {
    expect(
      evaluateTurnProgress(
        {
          fingerprint: "",
          changedFiles: [],
          headSha: "1111111111111111111111111111111111111111",
          lastError: "turn_failed: transient failure",
        },
        {
          fingerprint: "",
          changedFiles: [],
          headSha: "2222222222222222222222222222222222222222",
          lastError: "turn_failed: transient failure",
        }
      )
    ).toEqual({
      nonProductive: false,
      repeatedPattern: false,
      reason: null,
      headChanged: true,
      fingerprintUnchanged: true,
    });
  });

  it("treats changed workspace fingerprints as productive", () => {
    expect(
      evaluateTurnProgress(
        {
          fingerprint: "",
          changedFiles: [],
          headSha: "1111111111111111111111111111111111111111",
          lastError: null,
        },
        {
          fingerprint: "M src/index.ts",
          changedFiles: ["M src/index.ts"],
          headSha: "1111111111111111111111111111111111111111",
          lastError: null,
        }
      )
    ).toEqual({
      nonProductive: false,
      repeatedPattern: false,
      reason: null,
      headChanged: false,
      fingerprintUnchanged: false,
    });
  });
});
