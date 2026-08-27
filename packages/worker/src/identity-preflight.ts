import { spawn } from "node:child_process";
import {
  deriveIssueWorkspaceKey,
  deriveLegacyIssueWorkspaceKey,
  deriveLegacyWorkspaceKey,
  extractIssueNumberFromIdentifier,
  extractIssueNumbersFromBranch,
} from "@gh-symphony/core";

/**
 * Startup identity preflight (#507): before launching the agent, verify that
 * the workspace this worker was pointed at actually belongs to the issue the
 * run claims to own. Any mismatch is a fail-closed startup failure.
 */

export type IdentityPreflightEnv = {
  SYMPHONY_ISSUE_IDENTIFIER?: string;
  SYMPHONY_ISSUE_SUBJECT_ID?: string;
  SYMPHONY_ISSUE_WORKSPACE_KEY?: string;
  SYMPHONY_TRACKER_ADAPTER?: string;
  TARGET_REPOSITORY_CLONE_URL?: string;
  TARGET_REPOSITORY_URL?: string;
  PROJECT_ID?: string;
  CODEX_PROJECT_ID?: string;
};

export type IdentityPreflightResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Normalize a git remote URL for comparison: strips protocol, credentials,
 * `git@host:` prefixes, and trailing `.git`.
 */
export function normalizeRepositoryUrl(url: string): string {
  let normalized = url.trim().toLowerCase();
  normalized = normalized.replace(/^[a-z+]+:\/\//, "");
  normalized = normalized.replace(/^[^@/]+@/, "");
  normalized = normalized.replace(":", "/");
  normalized = normalized.replace(/\.git$/, "");
  normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

export function evaluateWorkerIdentityPreflight(input: {
  env: IdentityPreflightEnv;
  originUrl: string | null;
  currentBranch: string | null;
}): IdentityPreflightResult {
  const { env, originUrl, currentBranch } = input;
  const issueIdentifier = env.SYMPHONY_ISSUE_IDENTIFIER?.trim() ?? "";

  const expectedUrls = [
    env.TARGET_REPOSITORY_CLONE_URL,
    env.TARGET_REPOSITORY_URL,
  ]
    .map((url) => url?.trim())
    .filter((url): url is string => Boolean(url))
    .map(normalizeRepositoryUrl);
  if (expectedUrls.length > 0 && originUrl) {
    const normalizedOrigin = normalizeRepositoryUrl(originUrl);
    if (!expectedUrls.includes(normalizedOrigin)) {
      return {
        ok: false,
        reason: `workspace git origin '${originUrl}' does not match the target repository '${expectedUrls[0]}'`,
      };
    }
  }

  const workspaceKey = env.SYMPHONY_ISSUE_WORKSPACE_KEY?.trim() ?? "";
  if (workspaceKey && issueIdentifier) {
    const identity = {
      adapter: env.SYMPHONY_TRACKER_ADAPTER?.trim() ?? "",
      issueSubjectId: env.SYMPHONY_ISSUE_SUBJECT_ID?.trim() ?? "",
    };
    const acceptableKeys = new Set(
      [
        deriveIssueWorkspaceKey(identity, issueIdentifier),
        deriveIssueWorkspaceKey(issueIdentifier),
        deriveLegacyWorkspaceKey(issueIdentifier),
        identity.issueSubjectId
          ? deriveLegacyIssueWorkspaceKey(identity)
          : null,
        identity.issueSubjectId
          ? deriveLegacyIssueWorkspaceKey(
              identity,
              env.PROJECT_ID ?? env.CODEX_PROJECT_ID
            )
          : null,
      ].filter((key): key is string => Boolean(key))
    );
    if (!acceptableKeys.has(workspaceKey)) {
      return {
        ok: false,
        reason: `issue workspace key '${workspaceKey}' cannot be derived from issue '${issueIdentifier}'`,
      };
    }
  }

  if (currentBranch && issueIdentifier) {
    const issueNumber = extractIssueNumberFromIdentifier(issueIdentifier);
    const branchNumbers = extractIssueNumbersFromBranch(currentBranch);
    const foreign = branchNumbers.filter((number) => number !== issueNumber);
    if (foreign.length > 0) {
      return {
        ok: false,
        reason: `workspace branch '${currentBranch}' belongs to issue #${foreign[0]} instead of '${issueIdentifier}'`,
      };
    }
  }

  return { ok: true };
}

export async function runWorkerIdentityPreflight(
  env: IdentityPreflightEnv & { WORKING_DIRECTORY?: string }
): Promise<IdentityPreflightResult> {
  const workingDirectory = env.WORKING_DIRECTORY?.trim();
  if (!workingDirectory) {
    return { ok: false, reason: "WORKING_DIRECTORY is not set" };
  }

  const [originUrl, currentBranch] = await Promise.all([
    captureGitOutput(workingDirectory, ["remote", "get-url", "origin"]),
    captureGitOutput(workingDirectory, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);

  return evaluateWorkerIdentityPreflight({
    env,
    originUrl,
    currentBranch: currentBranch === "HEAD" ? null : currentBranch,
  });
}

function captureGitOutput(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: "pipe" });
    const stdout: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", () => resolve(null));
    child.once("exit", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const output = Buffer.concat(stdout).toString("utf8").trim();
      resolve(output || null);
    });
  });
}
