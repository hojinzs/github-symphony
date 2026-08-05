import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

function realpathWithMissingTail(path: string): string {
  let current = path;
  const missingTail: string[] = [];

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return path;
    }
    missingTail.unshift(basename(current));
    current = parent;
  }

  return join(realpathSync(current), ...missingTail);
}

export function isPathWithinRoot(
  root: string,
  candidate: string,
  allowRoot = true
): boolean {
  const realRoot = realpathWithMissingTail(root);
  const realCandidate = realpathWithMissingTail(candidate);
  const rel = relative(realRoot, realCandidate);

  return (
    (allowRoot && rel === "") ||
    (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel))
  );
}
