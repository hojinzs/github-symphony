import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function resolveAgentChildHome(options: {
  workingDirectory: string;
  runtimeDirectory?: string;
}): string {
  return join(
    options.runtimeDirectory ?? join(options.workingDirectory, ".runtime"),
    "child-home"
  );
}

export async function prepareAgentChildHome(childHome: string): Promise<void> {
  await mkdir(childHome, { recursive: true, mode: 0o700 });
  await mkdir(join(childHome, "gh"), { recursive: true, mode: 0o700 });
}

export async function stageJsonCredentialFile(options: {
  source: string;
  destination: string;
  allowedKeys?: readonly string[];
}): Promise<boolean> {
  if (await pathExists(options.destination)) {
    return false;
  }

  let raw: string;
  try {
    raw = await readFile(options.source, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(
      `Provider credential file must contain a JSON object: ${options.source}`
    );
  }
  const staged = options.allowedKeys
    ? Object.fromEntries(
        options.allowedKeys.flatMap((key) =>
          Object.hasOwn(parsed, key) ? [[key, parsed[key]]] : []
        )
      )
    : parsed;
  if (Object.keys(staged).length === 0) {
    return false;
  }

  await mkdir(dirname(options.destination), { recursive: true, mode: 0o700 });
  try {
    await writeFile(options.destination, `${JSON.stringify(staged)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
