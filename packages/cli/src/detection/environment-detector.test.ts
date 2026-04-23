import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { detectEnvironment } from "./environment-detector";

describe("detectEnvironment", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "env-detect-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("detects pnpm monorepo with all scripts", async () => {
    await writeFile(join(tempDir, "pnpm-lock.yaml"), "lockfileVersion: 5.4\n");
    await writeFile(
      join(tempDir, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n"
    );
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-monorepo",
        scripts: {
          test: "vitest run",
          build: "tsc",
          lint: "eslint src",
        },
      })
    );
    await mkdir(join(tempDir, ".github", "workflows"), { recursive: true });

    const result = await detectEnvironment(tempDir);

    expect(result.packageManager).toBe("pnpm");
    expect(result.lockfile).toBe("pnpm-lock.yaml");
    expect(result.testCommand).toBe("vitest run");
    expect(result.buildCommand).toBe("tsc");
    expect(result.lintCommand).toBe("eslint src");
    expect(result.ciPlatform).toBe("github-actions");
    expect(result.monorepo).toBe(true);
    expect(result.existingSkills).toEqual([]);
  });

  it("detects npm project without CI", async () => {
    await writeFile(
      join(tempDir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3 })
    );
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-npm",
        scripts: {
          test: "jest",
        },
      })
    );

    const result = await detectEnvironment(tempDir);

    expect(result.packageManager).toBe("npm");
    expect(result.lockfile).toBe("package-lock.json");
    expect(result.testCommand).toBe("jest");
    expect(result.buildCommand).toBeNull();
    expect(result.lintCommand).toBeNull();
    expect(result.ciPlatform).toBeNull();
    expect(result.monorepo).toBe(false);
  });

  it("detects yarn project", async () => {
    await writeFile(join(tempDir, "yarn.lock"), "");
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-yarn",
        scripts: {
          build: "yarn build",
        },
      })
    );

    const result = await detectEnvironment(tempDir);

    expect(result.packageManager).toBe("yarn");
    expect(result.lockfile).toBe("yarn.lock");
    expect(result.buildCommand).toBe("yarn build");
  });

  it("detects bun project with bun.lock", async () => {
    await writeFile(join(tempDir, "bun.lock"), "");
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-bun",
      })
    );

    const result = await detectEnvironment(tempDir);

    expect(result.packageManager).toBe("bun");
    expect(result.lockfile).toBe("bun.lock");
  });

  it("detects bun project with bun.lockb", async () => {
    await writeFile(join(tempDir, "bun.lockb"), "");
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-bun",
      })
    );

    const result = await detectEnvironment(tempDir);

    expect(result.packageManager).toBe("bun");
    expect(result.lockfile).toBe("bun.lockb");
  });

  it("detects uv-managed python repositories with pytest guidance", async () => {
    await writeFile(
      join(tempDir, "pyproject.toml"),
      [
        "[project]",
        'name = "python-fixture"',
        "",
        "[tool.pytest.ini_options]",
        'addopts = "-q"',
        "",
      ].join("\n")
    );
    await writeFile(join(tempDir, "uv.lock"), "version = 1\n");

    const result = await detectEnvironment(tempDir);

    expect(result.packageManager).toBe("uv");
    expect(result.lockfile).toBe("uv.lock");
    expect(result.testCommand).toBe("uv run pytest");
    expect(result.lintCommand).toBeNull();
    expect(result.buildCommand).toBeNull();
  });

  it("detects poetry-managed python repositories with pytest guidance", async () => {
    await writeFile(join(tempDir, "pyproject.toml"), "[project]\nname = 'poetry-fixture'\n");
    await writeFile(join(tempDir, "poetry.lock"), "package = []\n");
    await writeFile(join(tempDir, "pytest.ini"), "[pytest]\n");

    const result = await detectEnvironment(tempDir);

    expect(result.packageManager).toBe("poetry");
    expect(result.lockfile).toBe("poetry.lock");
    expect(result.testCommand).toBe("poetry run pytest");
  });

  it("returns null for package manager when no lockfile exists", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-no-lockfile",
      })
    );

    const result = await detectEnvironment(tempDir);

    expect(result.packageManager).toBeNull();
    expect(result.lockfile).toBeNull();
  });

  it("detects go repositories conservatively", async () => {
    await writeFile(join(tempDir, "go.mod"), "module example.com/fixture\n");

    const result = await detectEnvironment(tempDir);

    expect(result.packageManager).toBeNull();
    expect(result.testCommand).toBe("go test ./...");
    expect(result.lintCommand).toBeNull();
    expect(result.buildCommand).toBeNull();
  });

  it("detects rust repositories conservatively", async () => {
    await writeFile(
      join(tempDir, "Cargo.toml"),
      '[package]\nname = "fixture"\nversion = "0.1.0"\n'
    );

    const result = await detectEnvironment(tempDir);

    expect(result.packageManager).toBeNull();
    expect(result.testCommand).toBe("cargo test");
    expect(result.lintCommand).toBeNull();
    expect(result.buildCommand).toBeNull();
  });

  it("prefers explicit make targets over inferred language commands", async () => {
    await writeFile(join(tempDir, "go.mod"), "module example.com/fixture\n");
    await writeFile(
      join(tempDir, "Makefile"),
      ["test:", "\tgo test ./pkg/...", "lint:", "\tgolangci-lint run"].join(
        "\n"
      )
    );

    const result = await detectEnvironment(tempDir);

    expect(result.testCommand).toBe("make test");
    expect(result.lintCommand).toBe("make lint");
    expect(result.buildCommand).toBeNull();
  });

  it("falls back when equally explicit command runners conflict", async () => {
    await writeFile(join(tempDir, "Makefile"), "test:\n\tnpm test\n");
    await writeFile(join(tempDir, "justfile"), "test:\n    cargo test\n");

    const result = await detectEnvironment(tempDir);

    expect(result.testCommand).toBeNull();
  });

  it("ignores justfile variable assignments that are not recipes", async () => {
    await writeFile(
      join(tempDir, "justfile"),
      [
        'test := "cargo test"',
        'lint := "cargo clippy"',
        'build := "cargo build"',
      ].join("\n")
    );

    const result = await detectEnvironment(tempDir);

    expect(result.testCommand).toBeNull();
    expect(result.lintCommand).toBeNull();
    expect(result.buildCommand).toBeNull();
  });

  it("detects monorepo with lerna.json", async () => {
    await writeFile(
      join(tempDir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3 })
    );
    await writeFile(
      join(tempDir, "lerna.json"),
      JSON.stringify({
        version: "1.0.0",
        packages: ["packages/*"],
      })
    );
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-lerna",
      })
    );

    const result = await detectEnvironment(tempDir);

    expect(result.monorepo).toBe(true);
  });

  it("detects monorepo with workspaces in package.json", async () => {
    await writeFile(
      join(tempDir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3 })
    );
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-workspaces",
        workspaces: ["packages/*"],
      })
    );

    const result = await detectEnvironment(tempDir);

    expect(result.monorepo).toBe(true);
  });

  it("detects monorepo with workspaces.packages in package.json", async () => {
    await writeFile(
      join(tempDir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3 })
    );
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-workspaces-obj",
        workspaces: {
          packages: ["packages/*"],
        },
      })
    );

    const result = await detectEnvironment(tempDir);

    expect(result.monorepo).toBe(true);
  });

  it("detects Cargo workspace monorepos", async () => {
    await writeFile(join(tempDir, "Cargo.toml"), "[workspace]\nmembers = [\"crates/*\"]\n");

    const result = await detectEnvironment(tempDir);

    expect(result.monorepo).toBe(true);
  });

  it("detects Go workspace monorepos", async () => {
    await writeFile(join(tempDir, "go.work"), "go 1.22\nuse ./services/api\n");

    const result = await detectEnvironment(tempDir);

    expect(result.monorepo).toBe(true);
  });

  it("detects existing skills in .claude/skills/", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-skills",
      })
    );
    await mkdir(join(tempDir, ".claude", "skills", "skill-one"), {
      recursive: true,
    });
    await mkdir(join(tempDir, ".claude", "skills", "skill-two"), {
      recursive: true,
    });

    const result = await detectEnvironment(tempDir);

    expect(result.existingSkills).toContain("skill-one");
    expect(result.existingSkills).toContain("skill-two");
  });

  it("detects existing skills in .codex/skills/", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-codex-skills",
      })
    );
    await mkdir(join(tempDir, ".codex", "skills", "codex-skill-one"), {
      recursive: true,
    });
    await mkdir(join(tempDir, ".codex", "skills", "codex-skill-two"), {
      recursive: true,
    });

    const result = await detectEnvironment(tempDir);

    expect(result.existingSkills).toContain("codex-skill-one");
    expect(result.existingSkills).toContain("codex-skill-two");
  });

  it("detects skills from both .claude and .codex directories", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-both-skills",
      })
    );
    await mkdir(join(tempDir, ".claude", "skills", "claude-skill"), {
      recursive: true,
    });
    await mkdir(join(tempDir, ".codex", "skills", "codex-skill"), {
      recursive: true,
    });

    const result = await detectEnvironment(tempDir);

    expect(result.existingSkills).toContain("claude-skill");
    expect(result.existingSkills).toContain("codex-skill");
  });

  it("handles empty directory gracefully", async () => {
    const result = await detectEnvironment(tempDir);

    expect(result.packageManager).toBeNull();
    expect(result.lockfile).toBeNull();
    expect(result.testCommand).toBeNull();
    expect(result.buildCommand).toBeNull();
    expect(result.lintCommand).toBeNull();
    expect(result.ciPlatform).toBeNull();
    expect(result.monorepo).toBe(false);
    expect(result.existingSkills).toEqual([]);
  });

  it("prioritizes pnpm-lock.yaml over other lockfiles", async () => {
    await writeFile(join(tempDir, "pnpm-lock.yaml"), "");
    await writeFile(join(tempDir, "yarn.lock"), "");
    await writeFile(join(tempDir, "package-lock.json"), "");
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-priority",
      })
    );

    const result = await detectEnvironment(tempDir);

    expect(result.packageManager).toBe("pnpm");
    expect(result.lockfile).toBe("pnpm-lock.yaml");
  });

  it("prioritizes bun.lock over yarn.lock and package-lock.json", async () => {
    await writeFile(join(tempDir, "bun.lock"), "");
    await writeFile(join(tempDir, "yarn.lock"), "");
    await writeFile(join(tempDir, "package-lock.json"), "");
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-bun-priority",
      })
    );

    const result = await detectEnvironment(tempDir);

    expect(result.packageManager).toBe("bun");
    expect(result.lockfile).toBe("bun.lock");
  });

  it("detects CI platform with .github/workflows directory", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-ci",
      })
    );
    await mkdir(join(tempDir, ".github", "workflows"), { recursive: true });

    const result = await detectEnvironment(tempDir);

    expect(result.ciPlatform).toBe("github-actions");
  });

  it("returns null for CI platform when .github/workflows does not exist", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-no-ci",
      })
    );

    const result = await detectEnvironment(tempDir);

    expect(result.ciPlatform).toBeNull();
  });

  it("handles missing package.json gracefully", async () => {
    await writeFile(join(tempDir, "pnpm-lock.yaml"), "");

    const result = await detectEnvironment(tempDir);

    expect(result.packageManager).toBe("pnpm");
    expect(result.testCommand).toBeNull();
    expect(result.buildCommand).toBeNull();
    expect(result.lintCommand).toBeNull();
  });

  it("handles malformed package.json gracefully", async () => {
    await writeFile(join(tempDir, "package.json"), "{ invalid json");
    await writeFile(join(tempDir, "pnpm-lock.yaml"), "");

    const result = await detectEnvironment(tempDir);

    expect(result.packageManager).toBe("pnpm");
  });
});
