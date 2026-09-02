import { describe, expect, it } from "vitest";
import {
  deriveIssueWorkspaceKey,
  deriveLegacyWorkspaceKey,
} from "@gh-symphony/core";
import {
  evaluateWorkerIdentityPreflight,
  normalizeRepositoryUrl,
} from "./identity-preflight.js";

const baseEnv = {
  SYMPHONY_ISSUE_IDENTIFIER: "acme/platform#507",
  SYMPHONY_ISSUE_SUBJECT_ID: "issue-507",
  SYMPHONY_TRACKER_ADAPTER: "github-project",
  TARGET_REPOSITORY_CLONE_URL: "https://github.com/acme/platform.git",
  TARGET_REPOSITORY_URL: "https://github.com/acme/platform",
};

describe("normalizeRepositoryUrl", () => {
  it("normalizes https, ssh, and credentialed remotes to the same slug", () => {
    expect(normalizeRepositoryUrl("https://github.com/acme/platform.git")).toBe(
      "github.com/acme/platform"
    );
    expect(normalizeRepositoryUrl("git@github.com:acme/platform.git")).toBe(
      "github.com/acme/platform"
    );
    expect(
      normalizeRepositoryUrl("https://x-token@github.com/acme/platform")
    ).toBe("github.com/acme/platform");
  });
});

describe("evaluateWorkerIdentityPreflight", () => {
  const workspaceKey = deriveIssueWorkspaceKey(
    { adapter: "github-project", issueSubjectId: "issue-507" },
    "acme/platform#507"
  );

  it("passes for a workspace matching origin, key, and branch", () => {
    const result = evaluateWorkerIdentityPreflight({
      env: { ...baseEnv, SYMPHONY_ISSUE_WORKSPACE_KEY: workspaceKey },
      originUrl: "git@github.com:acme/platform.git",
      currentBranch: "feat/507-identity",
    });

    expect(result).toEqual({ ok: true });
  });

  it("fails closed when the origin points at a different repository", () => {
    const result = evaluateWorkerIdentityPreflight({
      env: { ...baseEnv, SYMPHONY_ISSUE_WORKSPACE_KEY: workspaceKey },
      originUrl: "https://github.com/acme/other-repo.git",
      currentBranch: "main",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("does not match the target repository");
    }
  });

  it("fails closed when the workspace key cannot be derived from the issue", () => {
    const result = evaluateWorkerIdentityPreflight({
      env: { ...baseEnv, SYMPHONY_ISSUE_WORKSPACE_KEY: "acme_platform_9999" },
      originUrl: "https://github.com/acme/platform.git",
      currentBranch: "main",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("cannot be derived");
    }
  });

  it("accepts a suffixless legacy workspace key", () => {
    expect(
      evaluateWorkerIdentityPreflight({
        env: {
          ...baseEnv,
          SYMPHONY_ISSUE_WORKSPACE_KEY: deriveLegacyWorkspaceKey(
            baseEnv.SYMPHONY_ISSUE_IDENTIFIER
          ),
        },
        originUrl: "https://github.com/acme/platform.git",
        currentBranch: "feat/507-identity",
      })
    ).toEqual({ ok: true });
  });

  it("fails closed when the checked-out branch belongs to another issue", () => {
    const result = evaluateWorkerIdentityPreflight({
      env: { ...baseEnv, SYMPHONY_ISSUE_WORKSPACE_KEY: workspaceKey },
      originUrl: "https://github.com/acme/platform.git",
      currentBranch: "fix/172-decode-nonascii-handles",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("#172");
    }
  });

  it("fails closed for a bare numeric branch that collides with a Linear issue", () => {
    const result = evaluateWorkerIdentityPreflight({
      env: {
        ...baseEnv,
        SYMPHONY_ISSUE_IDENTIFIER: "DEV-54",
        SYMPHONY_ISSUE_WORKSPACE_KEY: deriveIssueWorkspaceKey(
          { adapter: "linear", issueSubjectId: "DEV-54" },
          "DEV-54"
        ),
      },
      originUrl: "https://github.com/acme/platform.git",
      currentBranch: "feat/54-unrelated",
    });

    expect(result.ok).toBe(false);
  });

  it("accepts neutral branches and missing git metadata", () => {
    expect(
      evaluateWorkerIdentityPreflight({
        env: { ...baseEnv, SYMPHONY_ISSUE_WORKSPACE_KEY: workspaceKey },
        originUrl: null,
        currentBranch: "main",
      })
    ).toEqual({ ok: true });
    expect(
      evaluateWorkerIdentityPreflight({
        env: { ...baseEnv, SYMPHONY_ISSUE_WORKSPACE_KEY: workspaceKey },
        originUrl: "https://github.com/acme/platform.git",
        currentBranch: null,
      })
    ).toEqual({ ok: true });
  });
});
