import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
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
    expect(
      resolveRuntimeSkillsDirectory("/worktree", "/usr/local/bin/codex app-server")
    ).toBe("/worktree/.codex/skills");
  });

  it("excludes injected runtime skills from a linked worktree git status", async () => {
    const root = await createRoot();
    const bare = join(root, "cache.git");
    const seed = join(root, "seed");
    const worktree = join(root, "worktree");
    await execFileAsync("git", ["init", "-q", "-b", "main", seed]);
    await execFileAsync("git", ["-C", seed, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", seed, "config", "user.name", "Test User"]);
    await writeFile(join(seed, "README.md"), "seed", "utf8");
    await execFileAsync("git", ["-C", seed, "add", "README.md"]);
    await execFileAsync("git", ["-C", seed, "commit", "-qm", "seed"]);
    await execFileAsync("git", ["init", "-q", "--bare", bare]);
    await execFileAsync("git", ["-C", seed, "remote", "add", "origin", bare]);
    await execFileAsync("git", ["-C", seed, "push", "-q", "origin", "main"]);
    await execFileAsync("git", ["--git-dir", bare, "worktree", "add", "-q", worktree, "main"]);
    await excludeRuntimeSkillsFromGit(worktree, "codex app-server");
    await writeSkill(join(worktree, ".codex", "skills"), "injected", "skill");

    const { stdout } = await execFileAsync("git", [
      "-C",
      worktree,
      "status",
      "--short",
    ]);
    expect(stdout).toBe("");
  });

  it("preserves tracked runtime skills while refreshing injected skills", async () => {
    const root = await createRoot();
    const global = join(root, "global");
    const project = join(root, "project");
    const repository = join(root, "repository");
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Test User"]);
    await writeSkill(
      join(repository, ".codex", "skills"),
      "committed",
      "repository skill"
    );
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-qm", "skills"]);
    await writeSkill(global, "injected", "first");
    await excludeRuntimeSkillsFromGit(repository, "codex app-server");

    const input = {
      globalSkillsDirectory: global,
      projectDirectory: project,
      repositoryDirectory: repository,
      agentCommand: "codex app-server",
    };
    await injectLayeredSkills(input);
    await writeSkill(global, "injected", "second");
    await injectLayeredSkills(input);

    await expect(
      readFile(
        join(repository, ".codex", "skills", "committed", "SKILL.md"),
        "utf8"
      )
    ).resolves.toBe("repository skill");
    await expect(
      readFile(
        join(repository, ".codex", "skills", "injected", "SKILL.md"),
        "utf8"
      )
    ).resolves.toBe("second");
    const { stdout } = await execFileAsync("git", [
      "-C",
      repository,
      "status",
      "--short",
    ]);
    expect(stdout).toBe("");
  });
});
