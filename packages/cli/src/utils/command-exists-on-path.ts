import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

type AccessFn = typeof import("node:fs/promises").access;

type CommandExistsDependencies = {
  access: AccessFn;
  pathEnv: string | undefined;
  pathExtEnv: string | undefined;
  platform: NodeJS.Platform;
};

function getCommandCandidates(
  binary: string,
  deps: Pick<CommandExistsDependencies, "platform" | "pathExtEnv">
): string[] {
  if (deps.platform !== "win32") {
    return [binary];
  }

  const pathExts = (deps.pathExtEnv ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  const normalizedBinary = binary.toLowerCase();
  if (pathExts.some((ext) => normalizedBinary.endsWith(ext.toLowerCase()))) {
    return [binary];
  }

  return [binary, ...pathExts.map((ext) => `${binary}${ext}`)];
}

export async function commandExistsOnPath(
  binary: string,
  deps: CommandExistsDependencies
): Promise<boolean> {
  if (!binary) {
    return false;
  }

  const candidates = getCommandCandidates(binary, deps);
  if (isAbsolute(binary) || binary.includes("/") || binary.includes("\\")) {
    for (const candidate of candidates) {
      try {
        await deps.access(resolve(candidate), constants.X_OK);
        return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  for (const segment of (deps.pathEnv ?? "").split(delimiter)) {
    if (!segment) {
      continue;
    }
    for (const command of candidates) {
      const candidate = join(segment, command);
      try {
        await deps.access(candidate, constants.X_OK);
        return true;
      } catch {
        continue;
      }
    }
  }

  return false;
}
