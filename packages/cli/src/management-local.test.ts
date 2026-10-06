import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AgentRegistry } from "@gh-symphony/management-agent";
import { getProcessIdentity } from "@gh-symphony/orchestrator";
import { saveProjectConfig, type CliProjectConfig } from "./config.js";
import { standaloneProjectId } from "./standalone-project.js";
import {
  inspectLocalProject,
  resolveCanonicalRuntime,
} from "./management-local.js";
let root: string;
let configDir: string;
let folder: string;
let registry: AgentRegistry;
let child: ChildProcess | undefined;
const workflow = `---
tracker:
  kind: file
  provider:
    project_id: fixture-project
    path: ./issues.json
repository:
  slug: fixture/project
codex:
  command: codex app-server
---
PROMPT_SECRET_CANARY
`;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "management-local-")));
  folder = join(root, "prepared");
  configDir = join(root, "cli");
  await mkdir(folder);
  await mkdir(configDir);
  await writeFile(join(folder, "WORKFLOW.md"), workflow);
  await writeFile(join(folder, ".env"), "LOCAL_SECRET_CANARY=private");
  registry = await AgentRegistry.open(join(root, "agent"));
});
afterEach(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) =>
      child!.once("exit", () => resolve())
    );
    child.kill("SIGTERM");
    await exited;
  }
  child = undefined;
  await registry.close();
  await rm(root, { recursive: true, force: true });
});
async function installAliasRuntime(): Promise<{
  runtimeId: string;
  pid: number;
  processIdentity: string;
}> {
  const alias = join(root, "alias");
  await symlink(folder, alias);
  const runtimeId = standaloneProjectId(alias);
  const project: CliProjectConfig = {
    projectId: runtimeId,
    slug: "fixture",
    projectDir: alias,
    workspaceDir: join(folder, ".runtime"),
    repository: { owner: "fixture", name: "project", cloneUrl: "unused" },
    workflowSource: { type: "external", path: join(alias, "WORKFLOW.md") },
    tracker: {
      adapter: "file",
      bindingId: "fixture-project",
      priority: 0,
      settings: {},
    },
  };
  await saveProjectConfig(configDir, runtimeId, project);
  child = spawn(
    process.execPath,
    [
      "-e",
      'process.title="gh-symphony fixture-lifetime project start"; console.log("ready"); setInterval(()=>{},1000);',
    ],
    { cwd: folder, stdio: ["ignore", "pipe", "ignore"] }
  );
  await new Promise<void>((resolve, reject) => {
    child!.stdout!.once("data", () => resolve());
    child!.once("error", reject);
  });
  const pid = child.pid!;
  const processIdentity = getProcessIdentity(pid)!;
  expect(processIdentity).toBeTruthy();
  const record = {
    pid,
    processIdentity,
    cwd: folder,
    ownerToken: "fixture-owner",
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  await Promise.all(
    [
      join(configDir, "projects", runtimeId, "daemon.pid"),
      join(configDir, "projects", runtimeId, ".lock"),
      join(folder, ".gh-symphony-start.lock"),
    ].map((path) => writeFile(path, JSON.stringify(record)))
  );
  return { runtimeId, pid, processIdentity };
}
it("validates unstarted folders and projects only non-secret workflow metadata", async () => {
  const project = await registry.add(folder);
  const inspected = await inspectLocalProject(configDir, project);
  expect(inspected.validation.state).toBe("valid");
  expect(inspected.process.state).toBe("stopped");
  expect(inspected.locksReleased).toBe(true);
  const inventory = await registry.inventory(
    { inspect: (entry) => inspectLocalProject(configDir, entry) },
    "3.0.0"
  );
  expect(JSON.stringify(inventory)).not.toContain("CANARY");
  expect(inventory[0].snapshot).toMatchObject({
    workflowRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
    trackerScope: {
      adapter: "file",
      bindingId: "fixture-project",
      repository: "fixture/project",
    },
  });
});
it("retains alias runtime identity and verifies OS process and both ownership locks", async () => {
  const expected = await installAliasRuntime();
  const project = await registry.add(folder);
  const runtime = await resolveCanonicalRuntime(configDir, folder);
  expect(runtime?.runtimeProjectId).toBe(expected.runtimeId);
  const observed = await inspectLocalProject(configDir, project);
  expect(observed.process).toMatchObject({
    state: "running",
    pid: expected.pid,
    identity: expected.processIdentity,
  });
  expect(observed.ready).toBe(true);
  expect(observed.runtime?.runtimeProjectId).toBe(expected.runtimeId);
  // Missing workflow never hides a verified running process from stop.
  await rm(join(folder, "WORKFLOW.md"));
  const invalid = await inspectLocalProject(configDir, project);
  expect(invalid.validation.state).toBe("invalid");
  expect(invalid.process.state).toBe("running");
});
it("fails closed on stale or conflicting ownership records without deleting them", async () => {
  const expected = await installAliasRuntime();
  const project = await registry.add(folder);
  const path = join(folder, ".gh-symphony-start.lock");
  const malformed =
    '{"pid":1,"processIdentity":"replacement","cwd":"/elsewhere"}';
  await writeFile(path, malformed);
  const observed = await inspectLocalProject(configDir, project);
  expect(observed.process.state).toBe("unknown");
  expect(observed.locksReleased).toBe(false);
  expect(await readFile(path, "utf8")).toBe(malformed);
  expect(
    (await resolveCanonicalRuntime(configDir, folder))?.runtimeProjectId
  ).toBe(expected.runtimeId);
});

it("routes canonical expected-stop requests to the existing alias runtime without signaling an unverified endpoint", async () => {
  const target = await installAliasRuntime();
  const { default: projectCommand } = await import("./commands/project.js");
  const { vi } = await import("vitest");
  const output: string[] = [];
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    await projectCommand(
      [
        "stop",
        "--project-dir",
        folder,
        "--expected-pid",
        String(target.pid),
        "--expected-process-identity",
        target.processIdentity,
      ],
      { configDir, verbose: false, json: true, noColor: true }
    );
    expect(output.join("")).toContain('"outcome"');
    expect(JSON.parse(output.join(""))).toEqual({
      outcome: "process_unverified",
      pid: target.pid,
    });
    expect(child!.exitCode).toBeNull();
    expect(
      await readFile(
        join(configDir, "projects", target.runtimeId, ".lock"),
        "utf8"
      )
    ).toContain(target.processIdentity);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    process.exitCode = undefined;
  }
});

it("rejects native-service launches without an explicit isolated project launcher", async () => {
  const { createLocalManagementAdapter } =
    await import("./management-local.js");
  const invalid = {
    configDir,
    executable: process.execPath,
    launchContext: { kind: "native-service" },
  } as unknown as Parameters<typeof createLocalManagementAdapter>[1];
  expect(() => createLocalManagementAdapter(registry, invalid)).toThrow(
    "isolated project launcher"
  );
});

it("restarts cached aliases through their verified path and original config root", async () => {
  const expected = await installAliasRuntime();
  const project = await registry.add(folder);
  const { createLocalManagementAdapter } =
    await import("./management-local.js");
  const requests: import("./management-local.js").IsolatedProjectLaunch[] = [];
  const { reader } = createLocalManagementAdapter(registry, {
    configDir,
    executable: process.execPath,
    launchContext: {
      kind: "native-service",
      async launchIsolatedProject(request) {
        requests.push(request);
        return { exitCode: 0 };
      },
    },
  });
  await reader.start(project, Date.now() + 5000);
  expect(requests[0].args).toContain(join(root, "alias"));
  expect(requests[0].args).toContain(configDir);
  expect(requests[0].cwd).toBe(folder);
  expect(
    (await resolveCanonicalRuntime(configDir, folder))?.runtimeProjectId
  ).toBe(expected.runtimeId);
  // Cached aliases must not redirect a later launch after retargeting.
  await rm(join(root, "alias"));
  const other = join(root, "other");
  await mkdir(other);
  await symlink(other, join(root, "alias"));
  await expect(reader.start(project, Date.now() + 5000)).rejects.toThrow(
    "Cached runtime path"
  );
  expect(requests).toHaveLength(1);
});
