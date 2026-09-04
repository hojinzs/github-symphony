import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG_DIR,
  REPO_RUNTIME_DIR,
  loadGlobalConfig,
  loadProjectConfig,
  parseDaemonPidRecord,
  resolveConfigDir,
  saveGlobalConfig,
  saveProjectConfig,
  updateGlobalConfig,
  withConfigLock,
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

describe("config persistence", () => {
  it("loads legacy project configs with removed fields ignored", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-project-config-"));
    const projectId = "project-1";
    const projectDir = join(configDir, "projects", projectId);
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "project.json"),
      JSON.stringify({
        projectId,
        slug: projectId,
        workspaceDir: "/tmp/project-1",
        repositoryDir: "/repos/project-1",
        tracker: { adapter: "file", bindingId: "project-1" },
        workflowSource: { type: "repo" },
        populateStrategy: "clone",
      }),
      "utf8"
    );

    const loaded = await loadProjectConfig(configDir, projectId);
    expect(loaded).not.toHaveProperty("repositoryDir");
    expect(loaded).not.toHaveProperty("workflowSource");
    expect(loaded).not.toHaveProperty("populateStrategy");

    await expect(
      saveProjectConfig(configDir, projectId, {
        projectId,
        slug: projectId,
        workspaceDir: "/tmp/project-1",
        tracker: { adapter: "file", bindingId: "project-1" },
        workflowSource: {
          type: "external",
          path: "relative/WORKFLOW.md",
        },
      })
    ).rejects.toThrow('Project "project-1" external workflow source path');

    await expect(
      saveProjectConfig(configDir, projectId, {
        projectId,
        slug: projectId,
        workspaceDir: "/tmp/project-1",
        projectDir: "relative/project",
        tracker: { adapter: "file", bindingId: "project-1" },
      })
    ).rejects.toThrow('Project "project-1" project directory');
  });

  it("serializes concurrent load-modify-save updates", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-config-lock-"));
    await saveGlobalConfig(configDir, {
      activeProject: null,
      projects: [],
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        updateGlobalConfig(configDir, (config) => ({
          ...config,
          projects: [...config.projects, `project-${index}`],
        }))
      )
    );

    const config = await loadGlobalConfig(configDir);
    expect(config?.projects).toHaveLength(8);
    expect(new Set(config?.projects).size).toBe(8);
    expect(
      JSON.parse(await readFile(join(configDir, "config.json"), "utf8"))
    ).toEqual(config);
    expect(await readdir(configDir)).toEqual(["config.json"]);
  }, 10_000);

  it("recovers an expired partial config lock left by a crash", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-config-lock-"));
    const lockPath = join(configDir, ".config.lock");
    await writeFile(lockPath, '{"ownerToken":"partial"', "utf8");
    const expired = new Date(Date.now() - 31_000);
    await utimes(lockPath, expired, expired);

    await saveGlobalConfig(configDir, {
      activeProject: "project-1",
      projects: ["project-1"],
    });

    await expect(loadGlobalConfig(configDir)).resolves.toEqual({
      activeProject: "project-1",
      projects: ["project-1"],
    });
    expect(await readdir(configDir)).toEqual(["config.json"]);
  });

  it("reclaims an aged lock whose live owner cannot be identified", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-config-lock-"));
    const lockPath = join(configDir, ".config.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        ownerToken: "unverifiable-owner",
        pid: process.pid,
        startedAt: new Date(Date.now() - 31_000).toISOString(),
        processIdentity: null,
      }),
      "utf8"
    );
    const expired = new Date(Date.now() - 31_000);
    await utimes(lockPath, expired, expired);

    await expect(
      withConfigLock(configDir, async () => "acquired")
    ).resolves.toBe("acquired");
  });

  it("reclaims an aged lock whose owner process is gone", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-config-lock-"));
    const lockPath = join(configDir, ".config.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        ownerToken: "dead-owner",
        pid: 999_999_999,
        startedAt: new Date(Date.now() - 31_000).toISOString(),
        processIdentity: null,
      }),
      "utf8"
    );
    const expired = new Date(Date.now() - 31_000);
    await utimes(lockPath, expired, expired);

    await expect(
      withConfigLock(configDir, async () => "acquired")
    ).resolves.toBe("acquired");
  });

  it("reads structured and legacy daemon PID records", () => {
    expect(parseDaemonPidRecord("1234\n")).toEqual({
      pid: 1234,
      startedAt: "",
      processIdentity: null,
      cwd: null,
    });
    expect(
      parseDaemonPidRecord(
        JSON.stringify({
          pid: 5678,
          startedAt: "2026-07-15T00:00:00.000Z",
          processIdentity: "node gh-symphony repo start",
        })
      )
    ).toEqual({
      pid: 5678,
      startedAt: "2026-07-15T00:00:00.000Z",
      processIdentity: "node gh-symphony repo start",
      cwd: null,
    });
    expect(parseDaemonPidRecord("not-a-pid")).toBeNull();
  });
});
