import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG_DIR,
  REPO_RUNTIME_DIR,
  resolveConfigDir,
} from "./config.js";

const originalCwd = process.cwd();
const originalConfigDir = process.env.GH_SYMPHONY_CONFIG_DIR;

afterEach(() => {
  process.chdir(originalCwd);
  if (originalConfigDir === undefined) {
    delete process.env.GH_SYMPHONY_CONFIG_DIR;
  } else {
    process.env.GH_SYMPHONY_CONFIG_DIR = originalConfigDir;
  }
});

describe("resolveConfigDir", () => {
  it("prefers an explicit override", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-config-cwd-"));
    const override = await mkdtemp(join(tmpdir(), "cli-config-override-"));
    const envDir = await mkdtemp(join(tmpdir(), "cli-config-env-"));
    process.chdir(cwd);
    process.env.GH_SYMPHONY_CONFIG_DIR = envDir;

    expect(resolveConfigDir(override)).toBe(override);
  });

  it("prefers GH_SYMPHONY_CONFIG_DIR over cwd runtime discovery", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-config-cwd-"));
    const envDir = await mkdtemp(join(tmpdir(), "cli-config-env-"));
    const runtimeDir = join(cwd, REPO_RUNTIME_DIR);
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "config.json"), "{}\n", "utf8");
    process.chdir(cwd);
    process.env.GH_SYMPHONY_CONFIG_DIR = envDir;

    expect(resolveConfigDir()).toBe(envDir);
  });

  it("uses an initialized cwd repository runtime when no override is set", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-config-cwd-"));
    const runtimeDir = join(cwd, REPO_RUNTIME_DIR);
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "config.json"), "{}\n", "utf8");
    process.chdir(cwd);
    delete process.env.GH_SYMPHONY_CONFIG_DIR;

    expect(resolveConfigDir()).toBe(join(process.cwd(), REPO_RUNTIME_DIR));
  });

  it("falls back to the home config when cwd runtime is not initialized", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-config-cwd-"));
    await mkdir(join(cwd, REPO_RUNTIME_DIR), { recursive: true });
    process.chdir(cwd);
    delete process.env.GH_SYMPHONY_CONFIG_DIR;

    expect(resolveConfigDir()).toBe(DEFAULT_CONFIG_DIR);
  });
});
