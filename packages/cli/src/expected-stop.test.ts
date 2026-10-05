import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectLockHandle } from "@gh-symphony/orchestrator";
import type { CliProjectConfig, DaemonPidRecord } from "./config.js";

const probes = vi.hoisted(() => ({
  cwd: vi.fn(),
  identity: vi.fn(),
  running: vi.fn(),
}));
vi.mock("@gh-symphony/orchestrator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gh-symphony/orchestrator")>()),
  getProcessCwd: probes.cwd,
  getProcessIdentity: probes.identity,
  isProcessRunning: probes.running,
}));

import {
  expectedStopSocketPath,
  inspectExpectedStopTarget,
  startExpectedStopServer,
  stopExpectedTarget,
  type ExpectedStopContext,
} from "./expected-stop.js";
import stopCommand from "./commands/stop.js";

let root: string;
let context: ExpectedStopContext;
let paths: string[];
let contents: string[];
let server: Server | undefined;
const target = { pid: process.pid, processIdentity: "fixture-start-identity" };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "expected-stop-"));
  context = { configDir: root, projectId: "fixture", projectDir: root };
  await mkdir(join(root, "projects", "fixture"), { recursive: true });
  const lock: ProjectLockHandle = {
    lockPath: "unused",
    pid: target.pid,
    processIdentity: target.processIdentity,
    ownerToken: "fixture-owner",
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    cwd: root,
  };
  const pid: DaemonPidRecord = {
    pid: target.pid,
    processIdentity: target.processIdentity,
    startedAt: lock.startedAt,
    cwd: root,
  };
  paths = [
    join(root, "projects", "fixture", "daemon.pid"),
    join(root, "projects", "fixture", ".lock"),
    join(root, ".gh-symphony-start.lock"),
  ];
  contents = [JSON.stringify(pid), JSON.stringify(lock), JSON.stringify(lock)];
  await Promise.all(
    paths.map((path, index) => writeFile(path, contents[index]!))
  );
  probes.cwd.mockReturnValue(root);
  probes.identity.mockReturnValue(target.processIdentity);
  probes.running.mockReturnValue(true);
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolveClose) =>
      server!.close(() => resolveClose())
    );
    server = undefined;
  }
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetAllMocks();
  process.exitCode = undefined;
});

async function assertRecordsPreserved(): Promise<void> {
  expect(
    await Promise.all(paths.map((path) => readFile(path, "utf8")))
  ).toEqual(contents);
}

async function requestSocket(expected: typeof target): Promise<string> {
  return new Promise((resolveResponse, reject) => {
    const socket = createConnection(expectedStopSocketPath(context));
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`${JSON.stringify(expected)}\n`));
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => resolveResponse(response.trim()));
  });
}

describe("expected-target local stop", () => {
  it("delivers graceful self-signal through a verified socket and retains all records", async () => {
    server = await startExpectedStopServer(context);
    expect(await stopExpectedTarget(context, target)).toBe("signal_sent");
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(
      process.pid,
      "SIGTERM"
    );
    await assertRecordsPreserved();
  });

  it.each([0, 1, 2])(
    "rejects replacement PID ownership in record %i without signals or deletion",
    async (index) => {
      contents[index] = contents[index]!.replace(
        `"pid":${target.pid}`,
        `"pid":${target.pid + 1}`
      );
      await writeFile(paths[index]!, contents[index]!);
      expect(await stopExpectedTarget(context, target)).toBe(
        "superseded_target"
      );
      expect(process.kill).not.toHaveBeenCalled();
      await assertRecordsPreserved();
    }
  );

  it("rejects PID reuse with a different OS identity", async () => {
    probes.identity.mockReturnValue("replacement-start-identity");
    expect(await stopExpectedTarget(context, target)).toBe("superseded_target");
    expect(process.kill).not.toHaveBeenCalled();
    await assertRecordsPreserved();
  });

  it("rejects changed recorded identity without legacy command-line fallback", async () => {
    contents[0] = contents[0]!.replace(
      target.processIdentity,
      "node gh-symphony repo start"
    );
    await writeFile(paths[0]!, contents[0]!);
    expect(await stopExpectedTarget(context, target)).toBe("superseded_target");
    expect(process.kill).not.toHaveBeenCalled();
    await assertRecordsPreserved();
  });

  it.each(["identity", "cwd", "lock", "record", "legacy", "record-cwd"])(
    "fails closed on missing/invalid %s evidence",
    async (kind) => {
      if (kind === "identity") probes.identity.mockReturnValue(null);
      if (kind === "cwd") probes.cwd.mockReturnValue(tmpdir());
      if (kind === "lock") await rm(paths[2]!);
      if (kind === "record") await writeFile(paths[0]!, "{invalid");
      if (kind === "legacy") await writeFile(paths[0]!, String(target.pid));
      if (kind === "record-cwd")
        await writeFile(paths[1]!, contents[1]!.replace(root, tmpdir()));
      const before = await Promise.all(
        paths.map((path) => readFile(path, "utf8").catch(() => null))
      );
      expect(await stopExpectedTarget(context, target)).toBe(
        "process_unverified"
      );
      expect(process.kill).not.toHaveBeenCalled();
      expect(
        await Promise.all(
          paths.map((path) => readFile(path, "utf8").catch(() => null))
        )
      ).toEqual(before);
    }
  );

  it("requires exit and released records before reporting already stopped", async () => {
    probes.identity.mockReturnValue(null);
    probes.running.mockReturnValue(false);
    expect(inspectExpectedStopTarget(context, target)).toBe(
      "process_unverified"
    );
    await Promise.all(paths.slice(1).map((path) => rm(path)));
    expect(await stopExpectedTarget(context, target)).toBe("already_stopped");
    expect(await readFile(paths[0]!, "utf8")).toBe(contents[0]);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("fails closed for an older daemon with no local endpoint", async () => {
    expect(await stopExpectedTarget(context, target)).toBe(
      "process_unverified"
    );
    expect(process.kill).not.toHaveBeenCalled();
    await assertRecordsPreserved();
  });

  it("rechecks ownership at the server after caller verification", async () => {
    server = await startExpectedStopServer(context);
    expect(inspectExpectedStopTarget(context, target)).toBe("verified");
    contents[2] = contents[2]!.replace(
      `"pid":${target.pid}`,
      `"pid":${target.pid + 1}`
    );
    await writeFile(paths[2]!, contents[2]!);
    expect(await requestSocket(target)).toBe("superseded_target");
    expect(process.kill).not.toHaveBeenCalled();
    await assertRecordsPreserved();
  });

  it("rejects a connection to replacement B even if the caller verified A", async () => {
    server = await startExpectedStopServer(context);
    expect(await requestSocket({ ...target, pid: process.pid + 1 })).toBe(
      "superseded_target"
    );
    expect(
      await requestSocket({ ...target, processIdentity: "old-target-A" })
    ).toBe("superseded_target");
    expect(process.kill).not.toHaveBeenCalled();
    await assertRecordsPreserved();
  });

  it.each([
    ["--expected-pid", "123"],
    ["--expected-process-identity", "identity"],
    ["--expected-pid", "0", "--expected-process-identity", "identity"],
    ["--expected-pid", "1.5", "--expected-process-identity", "identity"],
    [
      "--expected-pid",
      "9007199254740992",
      "--expected-process-identity",
      "identity",
    ],
    ["--expected-pid", "123", "--expected-process-identity", " "],
    ["--expected-pid", "123", "--expected-process-identity"],
    [
      "--expected-pid",
      "123",
      "--expected-pid",
      "123",
      "--expected-process-identity",
      "identity",
    ],
    [
      "--expected-pid",
      "123",
      "--expected-process-identity",
      "identity",
      "--expected-process-identity",
      "identity",
    ],
    [
      "--force",
      "--expected-pid",
      "123",
      "--expected-process-identity",
      "identity",
    ],
  ])(
    "rejects invalid target arguments %j before reading project state",
    async (...args) => {
      await stopCommand(args, {
        configDir: root,
        projectId: "fixture",
        invocation: "project",
        verbose: false,
        json: false,
        noColor: true,
      });
      expect(process.exitCode).toBe(2);
      expect(process.kill).not.toHaveBeenCalled();
      await assertRecordsPreserved();
    }
  );

  it("exposes typed outcomes through the CLI JSON contract without stale cleanup", async () => {
    const config: CliProjectConfig = {
      projectId: "fixture",
      slug: "fixture",
      projectDir: root,
      workspaceDir: root,
      tracker: { adapter: "file", bindingId: "fixture" },
    };
    await writeFile(
      join(root, "projects", "fixture", "project.json"),
      JSON.stringify(config)
    );
    contents[0] = contents[0]!.replace(
      `"pid":${target.pid}`,
      `"pid":${target.pid + 1}`
    );
    await writeFile(paths[0]!, contents[0]!);
    await stopCommand(
      [
        "--expected-pid",
        String(target.pid),
        "--expected-process-identity",
        target.processIdentity,
      ],
      {
        configDir: root,
        projectId: "fixture",
        invocation: "project",
        verbose: false,
        json: true,
        noColor: true,
      }
    );
    expect(process.stdout.write).toHaveBeenCalledWith(
      `${JSON.stringify({ outcome: "superseded_target", pid: target.pid })}\n`
    );
    expect(process.exitCode).toBe(1);
    expect(process.kill).not.toHaveBeenCalled();
    await assertRecordsPreserved();
  });
});
