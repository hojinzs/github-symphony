import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

type DetectedPackageManager =
  | "pnpm"
  | "npm"
  | "yarn"
  | "bun"
  | "uv"
  | "poetry";

export type DetectedEnvironment = {
  packageManager: DetectedPackageManager | null;
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

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isFileMissing(error)) {
      return null;
    }
    throw error;
  }
}

async function detectPackageManager(cwd: string): Promise<{
  packageManager: DetectedPackageManager | null;
  lockfile: string | null;
}> {
  const lockfiles = [
    { name: "pnpm-lock.yaml", manager: "pnpm" as const },
    { name: "bun.lock", manager: "bun" as const },
    { name: "bun.lockb", manager: "bun" as const },
    { name: "yarn.lock", manager: "yarn" as const },
    { name: "package-lock.json", manager: "npm" as const },
    { name: "uv.lock", manager: "uv" as const },
    { name: "poetry.lock", manager: "poetry" as const },
  ];

  for (const { name, manager } of lockfiles) {
    const exists = await fileExists(join(cwd, name));
    if (exists) {
      return { packageManager: manager, lockfile: name };
    }
  }

  return { packageManager: null, lockfile: null };
}

type DetectedCommands = {
  testCommand: string | null;
  buildCommand: string | null;
  lintCommand: string | null;
};

type CommandLabel = keyof DetectedCommands;
type CommandCandidate = {
  command: string;
  priority: number;
};

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function addCandidate(
  candidates: Record<CommandLabel, CommandCandidate[]>,
  label: CommandLabel,
  command: string | null,
  priority: number
): void {
  if (!command) {
    return;
  }

  candidates[label].push({
    command: normalizeCommand(command),
    priority,
  });
}

function resolveCommand(
  candidates: Record<CommandLabel, CommandCandidate[]>,
  label: CommandLabel
): string | null {
  const entries = candidates[label];
  if (entries.length === 0) {
    return null;
  }

  const highestPriority = Math.max(...entries.map((entry) => entry.priority));
  const highestPriorityCommands = [
    ...new Set(
      entries
        .filter((entry) => entry.priority === highestPriority)
        .map((entry) => entry.command)
    ),
  ];

  return highestPriorityCommands.length === 1
    ? highestPriorityCommands[0]
    : null;
}

async function detectNodeScripts(cwd: string): Promise<DetectedCommands> {
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

async function detectMakeCommands(cwd: string): Promise<DetectedCommands> {
  const makefile =
    (await readTextFile(join(cwd, "Makefile"))) ??
    (await readTextFile(join(cwd, "makefile")));
  if (!makefile) {
    return { testCommand: null, buildCommand: null, lintCommand: null };
  }

  const hasTarget = (target: string): boolean =>
    new RegExp(`^${target}\\s*::?(?:\\s|$)`, "m").test(makefile);

  return {
    testCommand: hasTarget("test") ? "make test" : null,
    lintCommand: hasTarget("lint") ? "make lint" : null,
    buildCommand: hasTarget("build") ? "make build" : null,
  };
}

async function detectJustCommands(cwd: string): Promise<DetectedCommands> {
  const justfile =
    (await readTextFile(join(cwd, "justfile"))) ??
    (await readTextFile(join(cwd, ".justfile")));
  if (!justfile) {
    return { testCommand: null, buildCommand: null, lintCommand: null };
  }

  const hasRecipe = (name: string): boolean =>
    new RegExp(`^${name}\\s*:(?!=)`, "m").test(justfile);

  return {
    testCommand: hasRecipe("test") ? "just test" : null,
    lintCommand: hasRecipe("lint") ? "just lint" : null,
    buildCommand: hasRecipe("build") ? "just build" : null,
  };
}

async function hasRequirementsFile(cwd: string): Promise<boolean> {
  try {
    const entries = await readdir(cwd);
    return entries.some((entry) => /^requirements[^/]*\.txt$/i.test(entry));
  } catch (error) {
    if (isFileMissing(error)) {
      return false;
    }
    throw error;
  }
}

async function detectPythonCommands(cwd: string): Promise<DetectedCommands> {
  const [
    pyproject,
    hasUvLock,
    hasPoetryLock,
    hasPytestIni,
    hasToxIni,
    hasRequirements,
  ] = await Promise.all([
    readTextFile(join(cwd, "pyproject.toml")),
    fileExists(join(cwd, "uv.lock")),
    fileExists(join(cwd, "poetry.lock")),
    fileExists(join(cwd, "pytest.ini")),
    fileExists(join(cwd, "tox.ini")),
    hasRequirementsFile(cwd),
  ]);

  const hasPythonSignals =
    pyproject !== null ||
    hasUvLock ||
    hasPoetryLock ||
    hasPytestIni ||
    hasToxIni ||
    hasRequirements;
  if (!hasPythonSignals) {
    return { testCommand: null, buildCommand: null, lintCommand: null };
  }

  const hasPytestConfig =
    hasPytestIni ||
    /\[tool\.pytest(?:\.ini_options)?\]/.test(pyproject ?? "");
  if (!hasPytestConfig) {
    return { testCommand: null, buildCommand: null, lintCommand: null };
  }

  const testCommand = hasUvLock
    ? "uv run pytest"
    : hasPoetryLock
      ? "poetry run pytest"
      : "pytest";

  return { testCommand, buildCommand: null, lintCommand: null };
}

async function detectGoCommands(cwd: string): Promise<DetectedCommands> {
  const hasGoMod = await fileExists(join(cwd, "go.mod"));
  return {
    testCommand: hasGoMod ? "go test ./..." : null,
    buildCommand: null,
    lintCommand: null,
  };
}

async function detectRustCommands(cwd: string): Promise<DetectedCommands> {
  const hasCargoToml = await fileExists(join(cwd, "Cargo.toml"));
  return {
    testCommand: hasCargoToml ? "cargo test" : null,
    buildCommand: null,
    lintCommand: null,
  };
}

async function detectValidationCommands(cwd: string): Promise<DetectedCommands> {
  const [makeCommands, justCommands, nodeCommands, pythonCommands, goCommands, rustCommands] =
    await Promise.all([
      detectMakeCommands(cwd),
      detectJustCommands(cwd),
      detectNodeScripts(cwd),
      detectPythonCommands(cwd),
      detectGoCommands(cwd),
      detectRustCommands(cwd),
    ]);

  const candidates: Record<CommandLabel, CommandCandidate[]> = {
    testCommand: [],
    lintCommand: [],
    buildCommand: [],
  };

  for (const commandSet of [makeCommands, justCommands]) {
    addCandidate(candidates, "testCommand", commandSet.testCommand, 3);
    addCandidate(candidates, "lintCommand", commandSet.lintCommand, 3);
    addCandidate(candidates, "buildCommand", commandSet.buildCommand, 3);
  }

  addCandidate(candidates, "testCommand", nodeCommands.testCommand, 2);
  addCandidate(candidates, "lintCommand", nodeCommands.lintCommand, 2);
  addCandidate(candidates, "buildCommand", nodeCommands.buildCommand, 2);

  for (const commandSet of [pythonCommands, goCommands, rustCommands]) {
    addCandidate(candidates, "testCommand", commandSet.testCommand, 1);
    addCandidate(candidates, "lintCommand", commandSet.lintCommand, 1);
    addCandidate(candidates, "buildCommand", commandSet.buildCommand, 1);
  }

  return {
    testCommand: resolveCommand(candidates, "testCommand"),
    lintCommand: resolveCommand(candidates, "lintCommand"),
    buildCommand: resolveCommand(candidates, "buildCommand"),
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

  const hasGoWorkspace = await fileExists(join(cwd, "go.work"));
  if (hasGoWorkspace) {
    return true;
  }

  // Check for workspaces field in package.json
  const packageJson = await readJsonFile<{
    workspaces?: string[] | { packages?: string[] };
  }>(join(cwd, "package.json"));

  if (packageJson?.workspaces) {
    return true;
  }

  const cargoToml = await readTextFile(join(cwd, "Cargo.toml"));
  if (cargoToml?.includes("[workspace]")) {
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
    detectValidationCommands(cwd),
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
