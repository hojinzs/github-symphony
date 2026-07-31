import { isAbsolute, resolve, sep } from "node:path";

/**
 * Workspace boundary enforcement for codex runtime events (#507, upstream
 * spec §9.5 Safety Invariants): every reported command `cwd` must stay inside
 * the run's workspace path.
 */

function collectEventCwds(params: unknown): string[] {
  if (!params || typeof params !== "object") {
    return [];
  }

  const record = params as Record<string, unknown>;
  const cwds: string[] = [];
  if (typeof record.cwd === "string" && record.cwd.trim()) {
    cwds.push(record.cwd);
  }

  const item = record.item;
  if (item && typeof item === "object") {
    const itemCwd = (item as Record<string, unknown>).cwd;
    if (typeof itemCwd === "string" && itemCwd.trim()) {
      cwds.push(itemCwd);
    }
  }

  return cwds;
}

function isWithinBoundary(cwd: string, boundary: string): boolean {
  const resolvedBoundary = resolve(boundary);
  // Relative cwds are interpreted against the workspace by the runtime.
  const resolvedCwd = isAbsolute(cwd) ? resolve(cwd) : resolve(boundary, cwd);
  return (
    resolvedCwd === resolvedBoundary ||
    resolvedCwd.startsWith(`${resolvedBoundary}${sep}`)
  );
}

/**
 * Return the first `cwd` reported by a codex event that escapes the
 * workspace boundary, or null when every reported cwd is inside it.
 */
export function findCwdBoundaryViolation(
  params: unknown,
  boundary: string
): string | null {
  for (const cwd of collectEventCwds(params)) {
    if (!isWithinBoundary(cwd, boundary)) {
      return cwd;
    }
  }

  return null;
}

/**
 * Untruncated cwd suffix for worker event logs. The 300-char JSON truncation
 * previously cut workspace paths mid-prefix, which made commands look like
 * they ran from the project root during the #507 incident investigation.
 */
export function formatEventCwdSuffix(params: unknown): string {
  const cwds = collectEventCwds(params);
  return cwds.length > 0 ? ` cwd=${cwds[0]}` : "";
}
