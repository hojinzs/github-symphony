import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  excludeRuntimeSkillsFromGit,
  injectLayeredSkills,
  resolveRuntimeSkillsDirectory,
} from "./skills.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => execFileAsync("rm", ["-rf", root]))
  );
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-skills-"));
  roots.push(root);
  return root;
}

async function writeSkill(root: string, name: string, content: string) {
  const path = join(root, name, "SKILL.md");
  await mkdir(join(root, name), { recursive: true });
  await writeFile(path, content, "utf8");
}

describe("layered runtime skills", () => {
  it("copies global and project skills, with the project layer winning collisions", async () => {
    const root = await createRoot();
    const global = join(root, "global");
    const project = join(root, "project");
    const repository = join(root, "repository");
    await writeSkill(global, "global-only", "global");
    await writeSkill(global, "shared", "global version");
    await writeSkill(
      join(project, ".agent", "skills"),
      "project-only",
      "project"
    );
    await writeSkill(
      join(project, ".agent", "skills"),
      "shared",
      "project version"
    );

    await injectLayeredSkills({
      globalSkillsDirectory: global,
      projectDirectory: project,
      repositoryDirectory: repository,
      agentCommand: "codex app-server",
    });

    expect(
      await readFile(
        join(repository, ".codex", "skills", "global-only", "SKILL.md"),
        "utf8"
      )
    ).toBe("global");
    expect(
      await readFile(
        join(repository, ".codex", "skills", "project-only", "SKILL.md"),
        "utf8"
      )
    ).toBe("project");
    expect(
      await readFile(
        join(repository, ".codex", "skills", "shared", "SKILL.md"),
        "utf8"
      )
    ).toBe("project version");
  });

  it("repopulates the destination on every attempt", async () => {
    const root = await createRoot();
    const global = join(root, "global");
    const project = join(root, "project");
    const repository = join(root, "repository");
    await writeSkill(global, "shared", "first");
    const input = {
      globalSkillsDirectory: global,
      projectDirectory: project,
      repositoryDirectory: repository,
      agentCommand: "codex app-server",
    };
    await injectLayeredSkills(input);
    await writeSkill(global, "shared", "second");
    await injectLayeredSkills(input);

    expect(
      await readFile(
        join(repository, ".codex", "skills", "shared", "SKILL.md"),
        "utf8"
      )
    ).toBe("second");
  });

  it("uses cwd-native runtime skill directories", () => {
    expect(resolveRuntimeSkillsDirectory("/worktree", "codex app-server")).toBe(
      "/worktree/.codex/skills"
    );
    expect(resolveRuntimeSkillsDirectory("/worktree", "claude -p")).toBe(
      "/worktree/.claude/skills"
    );
  });

  it("excludes injected runtime skills from the worktree git status", async () => {
    const root = await createRoot();
    await execFileAsync("git", ["init", root]);
    await excludeRuntimeSkillsFromGit(root, "codex app-server");
    await writeSkill(join(root, ".codex", "skills"), "injected", "skill");

    const { stdout } = await execFileAsync("git", [
      "-C",
      root,
      "status",
      "--short",
    ]);
    expect(stdout).toBe("");
  });
});
