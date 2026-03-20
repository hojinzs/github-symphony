import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import type { IssueSubjectIdentity } from "../domain/issue.js";

/**
 * Derive a stable workspace key from a canonical issue identifier.
 *
 * The workspace key is a sanitized identifier such as `Acme.Platform-123`.
 * It is used to create persistent per-issue workspace directories that remain
 * easy to reverse-map back to the source issue.
 *
 * **Migration note**: Existing run-scoped workspaces (under `runs/<run-id>/`) are
 * unaffected. The issue-scoped workspace directory (`projects/<id>/issues/<key>/`)
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
    .replace(/[^A-Za-z0-9._-]+/g, "_")
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
  projectDirectory: string,
  workspaceKey: string
): string {
  const normalizedProjectDirectory = resolve(projectDirectory);
  const candidate = resolve(normalizedProjectDirectory, "issues", workspaceKey);

  if (!candidate.startsWith(`${normalizedProjectDirectory}/`)) {
    throw new Error(
      "Issue workspace path escapes the configured project directory."
    );
  }

  return candidate;
}

export function resolveIssueRepositoryPath(
  issueWorkspaceDirectory: string
): string {
  return join(issueWorkspaceDirectory, "repository");
}
