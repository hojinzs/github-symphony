import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GLOBAL_SKILLS_DIRECTORY = join(homedir(), ".gh-symphony", "skills");
const PROJECT_SKILLS_DIRECTORY = join(".agent", "skills");
const INJECTED_SKILLS_MANIFEST = ".gh-symphony-injected-skills.json";

function containsRuntimeToken(command: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[\\s"'\\\`/\\\\])${escaped}(?=$|[\\s"'\\\`/\\\\])`
  ).test(command);
}

async function readInjectedSkillNames(destination: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(destination, INJECTED_SKILLS_MANIFEST), "utf8")
    );
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === "string")
      : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    return [];
  }
}

async function readSkillNames(source: string): Promise<string[]> {
  try {
    return (await readdir(source, { withFileTypes: true }))
      .filter((entry) => entry.name !== INJECTED_SKILLS_MANIFEST)
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function isTrackedPath(
  repositoryDirectory: string,
  path: string
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repositoryDirectory, "ls-files", "-z", "--", path],
      { encoding: "utf8" }
    );
    return stdout.length > 0;
  } catch {
    return false;
  }
}

export function resolveRuntimeSkillsDirectory(
  repositoryDirectory: string,
  agentCommand: string
): string | null {
  if (
    containsRuntimeToken(agentCommand, "codex") ||
    containsRuntimeToken(agentCommand, "codex-app-server")
  ) {
    return join(repositoryDirectory, ".codex", "skills");
  }
  if (
    containsRuntimeToken(agentCommand, "claude") ||
    containsRuntimeToken(agentCommand, "claude-code") ||
    containsRuntimeToken(agentCommand, "claude-print")
  ) {
    return join(repositoryDirectory, ".claude", "skills");
  }
  return null;
}

export async function injectLayeredSkills(input: {
  projectDirectory: string;
  repositoryDirectory: string;
  agentCommand: string;
  globalSkillsDirectory?: string;
}): Promise<string | null> {
  const destination = resolveRuntimeSkillsDirectory(
    input.repositoryDirectory,
    input.agentCommand
  );
  if (!destination) {
    return null;
  }

  // Only remove entries written by a previous injection. Recreating the whole
  // runtime directory would delete repository-tracked skills from older setups.
  await mkdir(destination, { recursive: true });
  for (const name of await readInjectedSkillNames(destination)) {
    const target = join(destination, name);
    if (
      !(await isTrackedPath(
        input.repositoryDirectory,
        relative(input.repositoryDirectory, target)
      ))
    ) {
      await rm(target, { recursive: true, force: true });
    }
  }

  const injectedNames = new Set<string>();
  for (const source of [
    input.globalSkillsDirectory ?? GLOBAL_SKILLS_DIRECTORY,
    join(input.projectDirectory, PROJECT_SKILLS_DIRECTORY),
  ]) {
    for (const name of await readSkillNames(source)) {
      const target = join(destination, name);
      if (
        await isTrackedPath(
          input.repositoryDirectory,
          relative(input.repositoryDirectory, target)
        )
      ) {
        continue;
      }
      await rm(target, { recursive: true, force: true });
      await cp(join(source, name), target, {
        recursive: true,
        dereference: true,
        force: true,
      });
      injectedNames.add(name);
    }
  }
  await writeFile(
    join(destination, INJECTED_SKILLS_MANIFEST),
    JSON.stringify([...injectedNames].sort()),
    "utf8"
  );
  return destination;
}

export async function excludeRuntimeSkillsFromGit(
  repositoryDirectory: string,
  agentCommand: string
): Promise<void> {
  const skillsDirectory = resolveRuntimeSkillsDirectory(
    repositoryDirectory,
    agentCommand
  );
  if (!skillsDirectory) {
    return;
  }
  const relativePath = `${relative(repositoryDirectory, skillsDirectory).replaceAll(
    "\\",
    "/"
  )}/`;
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repositoryDirectory, "rev-parse", "--git-path", "info/exclude"],
    { encoding: "utf8" }
  );
  const gitPath = stdout.trim();
  const excludePath = isAbsolute(gitPath)
    ? gitPath
    : resolve(repositoryDirectory, gitPath);
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (existing.split(/\r?\n/).includes(relativePath)) {
    return;
  }
  await mkdir(dirname(excludePath), { recursive: true });
  await writeFile(
    excludePath,
    `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${relativePath}\n`,
    "utf8"
  );
}
