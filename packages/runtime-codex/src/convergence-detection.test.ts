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
    const repoRoot = await mkdtemp(join(tmpdir(), "runtime-codex-convergence-"));
    tempRoots.push(repoRoot);

    execSync("git init", {
      cwd: repoRoot,
      stdio: "ignore",
    });
    await writeFile(join(repoRoot, "notes.txt"), "hello\n", "utf8");

    const snapshot = captureTurnWorkspaceSnapshot(repoRoot);

    expect(snapshot.fingerprint).toContain("notes.txt");
    expect(snapshot.changedFiles).toEqual(["?? notes.txt"]);
  });

  it("marks unchanged workspace snapshots as non-productive", () => {
    expect(
      evaluateTurnProgress(
        {
          fingerprint: "M src/index.ts",
          changedFiles: ["M src/index.ts"],
          lastError: null,
        },
        {
          fingerprint: "M src/index.ts",
          changedFiles: ["M src/index.ts"],
          lastError: null,
        }
      )
    ).toEqual({
      nonProductive: true,
      repeatedPattern: true,
      reason: "workspace diff unchanged (1 tracked change)",
    });
  });

  it("marks repeated errors as non-productive even without git state", () => {
    expect(
      evaluateTurnProgress(
        {
          fingerprint: null,
          changedFiles: [],
          lastError: "turn_failed: tool execution failed",
        },
        {
          fingerprint: null,
          changedFiles: [],
          lastError: "turn_failed: tool execution failed",
        }
      )
    ).toEqual({
      nonProductive: true,
      repeatedPattern: true,
      reason: "repeated error: turn_failed: tool execution failed",
    });
  });

  it("treats changed workspace fingerprints as productive", () => {
    expect(
      evaluateTurnProgress(
        {
          fingerprint: "",
          changedFiles: [],
          lastError: null,
        },
        {
          fingerprint: "M src/index.ts",
          changedFiles: ["M src/index.ts"],
          lastError: null,
        }
      )
    ).toEqual({
      nonProductive: false,
      repeatedPattern: false,
      reason: null,
    });
  });
});
