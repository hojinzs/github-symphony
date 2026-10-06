import { readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  getProcessIdentity,
  isProcessRunning,
} from "@gh-symphony/orchestrator";
import {
  loadProjectConfig,
  REPO_RUNTIME_DIR,
  type CliProjectConfig,
} from "./config.js";
import { standaloneProjectId } from "./standalone-project.js";

export interface CanonicalRuntime {
  configDir: string;
  runtimeProjectId: string;
  project: CliProjectConfig;
}
export async function findCanonicalRuntimes(
  configDir: string,
  canonicalPath: string
): Promise<CanonicalRuntime[]> {
  const roots = [
    ...new Set([resolve(configDir), join(canonicalPath, REPO_RUNTIME_DIR)]),
  ];
  const matches: CanonicalRuntime[] = [];
  for (const directory of roots) {
    let ids: string[];
    try {
      ids = await readdir(join(directory, "projects"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const id of ids.sort()) {
      const project = await loadProjectConfig(directory, id);
      if (!project) continue;
      const paths = [
        project.projectDir,
        project.workflowSource?.type === "external"
          ? resolve(project.workflowSource.path, "..")
          : undefined,
      ];
      for (const name of ["daemon.pid", ".lock"]) {
        try {
          const record = JSON.parse(
            await readFile(join(directory, "projects", id, name), "utf8")
          ) as { cwd?: unknown };
          if (typeof record.cwd === "string") paths.push(record.cwd);
        } catch {
          /* Invalid ownership is handled by the strict inspector. */
        }
      }
      if (
        (
          await Promise.all(
            paths.map(async (path) => {
              if (!path) return false;
              try {
                return (await realpath(path)) === canonicalPath;
              } catch {
                return false;
              }
            })
          )
        ).some(Boolean)
      )
        matches.push({ configDir: directory, runtimeProjectId: id, project });
    }
  }
  return matches;
}
/** Resolve aliases using ownership evidence, retaining the stored runtime ID. */
export async function resolveCanonicalRuntime(
  configDir: string,
  folder: string
): Promise<CanonicalRuntime | null> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(folder);
  } catch {
    return null;
  }
  const candidates = await findCanonicalRuntimes(configDir, canonicalPath);
  const live: CanonicalRuntime[] = [];
  for (const candidate of candidates) {
    for (const name of ["daemon.pid", ".lock"]) {
      try {
        const record = JSON.parse(
          await readFile(
            join(
              candidate.configDir,
              "projects",
              candidate.runtimeProjectId,
              name
            ),
            "utf8"
          )
        ) as { pid?: unknown; processIdentity?: unknown };
        if (
          typeof record.pid === "number" &&
          isProcessRunning(record.pid) &&
          typeof record.processIdentity === "string" &&
          getProcessIdentity(record.pid) === record.processIdentity
        ) {
          live.push(candidate);
          break;
        }
      } catch {
        /* Strict inspection remains authoritative. */
      }
    }
  }
  if (live.length > 1)
    throw new Error(
      "process_unverified: multiple runtimes address the canonical folder"
    );
  return (
    live[0] ??
    candidates.find(
      (candidate) =>
        candidate.runtimeProjectId === standaloneProjectId(canonicalPath)
    ) ??
    candidates[0] ??
    null
  );
}
