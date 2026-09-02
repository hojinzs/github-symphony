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

/** Stages only the non-secret Git author identity for an isolated child HOME. */
export async function stageGitUserIdentity(options: {
  sourceHome: string;
  destination: string;
}): Promise<boolean> {
  if (await pathExists(options.destination)) {
    return false;
  }

  let source: string;
  try {
    source = await readFile(join(options.sourceHome, ".gitconfig"), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  const identity = parseGitUserIdentity(source);
  if (!identity.name && !identity.email) {
    return false;
  }

  const lines = ["[user]"];
  if (identity.name) {
    lines.push(`\tname = ${identity.name}`);
  }
  if (identity.email) {
    lines.push(`\temail = ${identity.email}`);
  }
  await writeFile(options.destination, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return true;
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

function parseGitUserIdentity(source: string): {
  name: string | null;
  email: string | null;
} {
  let inUserSection = false;
  let name: string | null = null;
  let email: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    const section = line.match(/^\s*\[\s*([^\s\]]+)\s*\]\s*$/);
    if (section) {
      inUserSection = section[1]?.toLowerCase() === "user";
      continue;
    }
    if (!inUserSection) {
      continue;
    }
    const assignment = line.match(/^\s*(name|email)\s*=\s*(.*?)\s*$/i);
    if (!assignment) {
      continue;
    }
    const value = assignment[2]?.trim();
    if (!value || value.includes("\n") || value.includes("\r")) {
      continue;
    }
    if (assignment[1]?.toLowerCase() === "name") {
      name = value;
    } else {
      email = value;
    }
  }
  return { name, email };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
