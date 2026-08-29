import { resolveEnvironmentValue } from "@gh-symphony/core";

/**
 * Resolves the file tracker fixture path from its provider configuration or
 * the legacy E2E compatibility environment variable.
 */
export function resolveFileTrackerIssuesPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    const fallback = process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH;
    if (fallback?.trim()) return fallback;
    throw new Error(
      'File tracker requires "tracker.provider.path" or GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH.'
    );
  }
  return resolveEnvironmentValue(value, process.env, "tracker.provider.path");
}
