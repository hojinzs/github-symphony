import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export type DetectedEnvironment = {
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
  lockfile: string | null;
  testCommand: string | null;
  buildCommand: string | null;
  lintCommand: string | null;
  ciPlatform: "github-actions" | null;
  monorepo: boolean;
  existingSkills: string[];
};

function isFileMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isFileMissing(error)) {
      return false;
    }
    throw error;
  }
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isFileMissing(error)) {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function detectPackageManager(cwd: string): Promise<{
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
  lockfile: string | null;
}> {
  const lockfiles = [
    { name: "pnpm-lock.yaml", manager: "pnpm" as const },
    { name: "bun.lock", manager: "bun" as const },
    { name: "bun.lockb", manager: "bun" as const },
    { name: "yarn.lock", manager: "yarn" as const },
    { name: "package-lock.json", manager: "npm" as const },
  ];

  for (const { name, manager } of lockfiles) {
    const exists = await fileExists(join(cwd, name));
    if (exists) {
      return { packageManager: manager, lockfile: name };
    }
  }

  return { packageManager: null, lockfile: null };
}

async function detectScripts(cwd: string): Promise<{
  testCommand: string | null;
  buildCommand: string | null;
  lintCommand: string | null;
}> {
  const packageJson = await readJsonFile<{
    scripts?: Record<string, string>;
  }>(join(cwd, "package.json"));

  if (!packageJson?.scripts) {
    return { testCommand: null, buildCommand: null, lintCommand: null };
  }

  return {
    testCommand: packageJson.scripts.test ?? null,
    buildCommand: packageJson.scripts.build ?? null,
    lintCommand: packageJson.scripts.lint ?? null,
  };
}

async function detectCiPlatform(cwd: string): Promise<"github-actions" | null> {
  const workflowsDir = join(cwd, ".github", "workflows");
  const exists = await fileExists(workflowsDir);
  return exists ? "github-actions" : null;
}

async function detectMonorepo(cwd: string): Promise<boolean> {
  // Check for pnpm-workspace.yaml
  const hasPnpmWorkspace = await fileExists(join(cwd, "pnpm-workspace.yaml"));
  if (hasPnpmWorkspace) {
    return true;
  }

  // Check for lerna.json
  const hasLerna = await fileExists(join(cwd, "lerna.json"));
  if (hasLerna) {
    return true;
  }

  // Check for workspaces field in package.json
  const packageJson = await readJsonFile<{
    workspaces?: string[] | { packages?: string[] };
  }>(join(cwd, "package.json"));

  if (packageJson?.workspaces) {
    return true;
  }

  return false;
}

async function detectExistingSkills(cwd: string): Promise<string[]> {
  const skills: string[] = [];

  // Check .claude/skills/
  const claudeSkillsDir = join(cwd, ".claude", "skills");
  try {
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(claudeSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        skills.push(entry.name);
      }
    }
  } catch (error) {
    if (!isFileMissing(error)) {
      throw error;
    }
  }

  // Check .codex/skills/
  const codexSkillsDir = join(cwd, ".codex", "skills");
  try {
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(codexSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        skills.push(entry.name);
      }
    }
  } catch (error) {
    if (!isFileMissing(error)) {
      throw error;
    }
  }

  return skills;
}

export async function detectEnvironment(
  cwd: string
): Promise<DetectedEnvironment> {
  const [
    { packageManager, lockfile },
    { testCommand, buildCommand, lintCommand },
    ciPlatform,
    monorepo,
    existingSkills,
  ] = await Promise.all([
    detectPackageManager(cwd),
    detectScripts(cwd),
    detectCiPlatform(cwd),
    detectMonorepo(cwd),
    detectExistingSkills(cwd),
  ]);

  return {
    packageManager,
    lockfile,
    testCommand,
    buildCommand,
    lintCommand,
    ciPlatform,
    monorepo,
    existingSkills,
  };
}
