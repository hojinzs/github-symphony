import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import type { IssueSubjectIdentity } from "../domain/issue.js";

/**
 * Derive a stable workspace key from a canonical issue subject identity.
 *
 * The workspace key is a truncated SHA-256 hash of `tenantId:adapter:issueSubjectId`.
 * It is used to create persistent per-issue workspace directories.
 *
 * **Migration note**: Existing run-scoped workspaces (under `runs/<run-id>/`) are
 * unaffected. The issue-scoped workspace directory (`workspaces/<id>/issues/<key>/`)
 * is created on the first run for a given issue and reused on subsequent runs.
 * `OrchestratorRunRecord.issueWorkspaceKey` is nullable to support older run
 * records created before the transition.
 */
export function deriveIssueWorkspaceKey(
  identity: IssueSubjectIdentity
): string {
  const input = [
    identity.tenantId,
    identity.adapter,
    identity.issueSubjectId,
  ].join(":");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function resolveIssueWorkspaceDirectory(
  workspaceRoot: string,
  tenantId: string,
  workspaceKey: string
): string {
  const normalizedRoot = resolve(workspaceRoot);
  const candidate = resolve(
    normalizedRoot,
    "workspaces",
    tenantId,
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
