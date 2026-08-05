import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

function realpathWithMissingTail(path: string): string | null {
  let current = path;
  const missingTail: string[] = [];

  while (true) {
    try {
      return join(realpathSync(current), ...missingTail);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        return null;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }

    try {
      if (lstatSync(current).isSymbolicLink()) {
        return null;
      }
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        return null;
      }
    }

    missingTail.unshift(basename(current));
    current = parent;
  }
}

export function isPathWithinRoot(
  root: string,
  candidate: string,
  allowRoot = true
): boolean {
  const realRoot = realpathWithMissingTail(root);
  const realCandidate = realpathWithMissingTail(candidate);

  if (!realRoot || !realCandidate) {
    return false;
  }

  const rel = relative(realRoot, realCandidate);

  return (
    (allowRoot && rel === "") ||
    (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel))
  );
}
