import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GLOBAL_SKILLS_DIRECTORY = join(homedir(), ".gh-symphony", "skills");
const PROJECT_SKILLS_DIRECTORY = join(".agent", "skills");

function containsRuntimeToken(command: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s"'\\\`])${escaped}(?=$|[\\s"'\\\`])`).test(command);
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

  // Start every attempt from an empty destination so removed or changed skills
  // are reflected. Project skills are copied last and therefore take precedence.
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const source of [
    input.globalSkillsDirectory ?? GLOBAL_SKILLS_DIRECTORY,
    join(input.projectDirectory, PROJECT_SKILLS_DIRECTORY),
  ]) {
    try {
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        force: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
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
  const relativePath = `${skillsDirectory
    .slice(resolve(repositoryDirectory).length + 1)
    .replaceAll("\\", "/")}/`;
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repositoryDirectory, "rev-parse", "--git-dir"],
    { encoding: "utf8" }
  );
  const gitDirectory = stdout.trim();
  const excludePath = join(
    isAbsolute(gitDirectory)
      ? gitDirectory
      : resolve(repositoryDirectory, gitDirectory),
    "info",
    "exclude"
  );
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
