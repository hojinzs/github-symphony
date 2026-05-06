import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import type { IssueSubjectIdentity } from "../domain/issue.js";

const RESERVED_WORKSPACE_KEYS = new Set([
  "cache",
  "issues.json",
  "project.json",
  "runs",
  "status.json",
]);

/**
 * Derive a stable workspace key from a canonical issue identifier.
 *
 * The workspace key is a sanitized identifier such as `Acme.Platform-123`.
 * It is used to create persistent per-issue workspace directories that remain
 * easy to reverse-map back to the source issue.
 *
 * **Migration note**: Existing run-scoped workspaces (under `runs/<run-id>/`) are
 * unaffected. The issue-scoped workspace directory (`<runtimeRoot>/<key>/`) is
 * created on the first run for a given issue and reused on subsequent runs.
 * `OrchestratorRunRecord.issueWorkspaceKey` is nullable to support older run
 * records created before the transition.
 */
export function deriveWorkspaceKey(identifier: string): string {
  const sanitized = identifier
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!sanitized || /^[.]+$/.test(sanitized)) {
    return "issue";
  }

  return sanitized;
}

export const deriveIssueWorkspaceKeyFromIdentifier = deriveWorkspaceKey;

export function deriveIssueWorkspaceKey(identifier: string): string;
export function deriveIssueWorkspaceKey(
  identity: IssueSubjectIdentity,
  issueIdentifier: string
): string;
export function deriveIssueWorkspaceKey(
  identityOrIdentifier: IssueSubjectIdentity | string,
  issueIdentifier?: string
): string {
  if (typeof identityOrIdentifier === "string") {
    return deriveWorkspaceKey(identityOrIdentifier);
  }

  return deriveWorkspaceKey(
    issueIdentifier ?? identityOrIdentifier.issueSubjectId
  );
}

export function deriveLegacyIssueWorkspaceKey(
  identity: IssueSubjectIdentity,
  projectId?: string
): string {
  const input = [projectId, identity.adapter, identity.issueSubjectId]
    .filter((part): part is string => typeof part === "string")
    .join(":");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function resolveIssueWorkspaceDirectory(
  runtimeRoot: string,
  workspaceKey: string
): string {
  const normalizedRuntimeRoot = resolve(runtimeRoot);
  const candidate = resolve(normalizedRuntimeRoot, workspaceKey);

  if (!candidate.startsWith(`${normalizedRuntimeRoot}/`)) {
    throw new Error(
      "Issue workspace path escapes the configured runtime root."
    );
  }

  if (isReservedWorkspaceKey(workspaceKey)) {
    throw new Error("Issue workspace key is reserved by the runtime layout.");
  }

  return candidate;
}

function isReservedWorkspaceKey(workspaceKey: string): boolean {
  return (
    workspaceKey.startsWith(".") ||
    RESERVED_WORKSPACE_KEYS.has(workspaceKey)
  );
}

export function resolveIssueRepositoryPath(
  issueWorkspaceDirectory: string
): string {
  return join(issueWorkspaceDirectory, "repository");
}
