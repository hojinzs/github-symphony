import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import type { IssueSubjectIdentity } from "../domain/issue.js";

/**
 * Derive a stable workspace key from a canonical issue identifier.
 *
 * The workspace key is a sanitized identifier such as `acme_platform_123`.
 * It is used to create persistent per-issue workspace directories that remain
 * easy to reverse-map back to the source issue.
 *
 * **Migration note**: Existing run-scoped workspaces (under `runs/<run-id>/`) are
 * unaffected. The issue-scoped workspace directory (`workspaces/<id>/issues/<key>/`)
 * is created on the first run for a given issue and reused on subsequent runs.
 * `OrchestratorRunRecord.issueWorkspaceKey` is nullable to support older run
 * records created before the transition.
 */
export function deriveIssueWorkspaceKey(
  identity: IssueSubjectIdentity,
  issueIdentifier?: string
): string {
  if (issueIdentifier) {
    return deriveIssueWorkspaceKeyFromIdentifier(issueIdentifier);
  }

  return deriveLegacyIssueWorkspaceKey(identity);
}

export function deriveIssueWorkspaceKeyFromIdentifier(
  issueIdentifier: string
): string {
  const sanitized = issueIdentifier
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return sanitized || "issue";
}

export function deriveLegacyIssueWorkspaceKey(
  identity: IssueSubjectIdentity
): string {
  const input = [
    identity.projectId,
    identity.adapter,
    identity.issueSubjectId,
  ].join(":");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function resolveIssueWorkspaceDirectory(
  workspaceRoot: string,
  projectId: string,
  workspaceKey: string
): string {
  const normalizedRoot = resolve(workspaceRoot);
  const candidate = resolve(
    normalizedRoot,
    "workspaces",
    projectId,
    "issues",
    workspaceKey
  );

  if (!candidate.startsWith(`${normalizedRoot}/`)) {
    throw new Error(
      "Issue workspace path escapes the configured workspace root."
    );
  }

  return candidate;
}

export function resolveIssueRepositoryPath(
  issueWorkspaceDirectory: string
): string {
  return join(issueWorkspaceDirectory, "repository");
}
