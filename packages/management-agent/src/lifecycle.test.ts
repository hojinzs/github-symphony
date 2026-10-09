import { mkdtemp, open, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AgentRegistry } from "./registry.js";
import {
  LocalLifecycleAdapter,
  type RuntimeDriver,
  type RuntimeInspection,
  type StopTarget,
  type StopTargetJournal,
} from "./lifecycle.js";
let root: string;
let registry: AgentRegistry;
let id: string;
let state: RuntimeInspection;
let effects: string[];
let driver: RuntimeDriver;
let adapter: LocalLifecycleAdapter;
const journal: StopTargetJournal = {
  async persistStopTarget(target) {
    effects.push("persist");
    const file = await open(join(root, "stop-target.json"), "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(target));
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open(root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  },
};
function running(identity = "fixture-process-A"): void {
  state = {
    ...state,
    process: {
      state: "running",
      pid: 41,
      identity,
      observedAt: new Date().toISOString(),
    },
    ready: true,
    locksReleased: false,
  };
}
function stopped(): void {
  state = {
    ...state,
    process: { state: "stopped", observedAt: new Date().toISOString() },
    ready: false,
    locksReleased: true,
  };
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "lifecycle-contract-")));
  await mkdir(join(root, "prepared"));
  registry = await AgentRegistry.open(join(root, "agent"));
  id = (await registry.add(join(root, "prepared"))).localProjectId;
  effects = [];
  state = {
    validation: { state: "valid" },
    process: { state: "stopped", observedAt: new Date().toISOString() },
    runs: [],
    runtime: {
      configDir: join(root, "cli"),
      runtimeProjectId: "legacy-alias-runtime",
    },
    ready: false,
    locksReleased: true,
  };
  // Independent typed peer fixture for the C02 local CLI boundary. Tests below
  // exercise the real registry, serialization, persistence ordering and polling.
  driver = {
    async inspect() {
      return structuredClone(state);
    },
    async start() {
      effects.push("start");
      running();
      return { exitCode: 0 };
    },
    async stop(_project, target) {
      effects.push("stop");
      expect(
        JSON.parse(await readFile(join(root, "stop-target.json"), "utf8"))
      ).toEqual(target);
      stopped();
      return { exitCode: 0, outcome: "signal_sent" };
    },
    async targetExited() {
      return state.process.state === "stopped";
    },
  };
  adapter = new LocalLifecycleAdapter(registry, driver, {
    timeoutMs: 30,
    pollIntervalMs: 1,
  });
});
afterEach(async () => {
  await registry.close();
  await rm(root, { recursive: true, force: true });
});

it("serializes duplicate starts and verifies readiness before success", async () => {
  driver.start = async () => {
    effects.push("start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    running();
    return { exitCode: 0 };
  };
  const results = await Promise.all([adapter.start(id), adapter.start(id)]);
  expect(results.map((result) => result.state)).toEqual([
    "succeeded",
    "succeeded",
  ]);
  expect(effects).toEqual(["start"]);
});
it("rejects invalid start but permits verified stop with invalid workflow", async () => {
  state.validation = {
    state: "invalid",
    diagnostic: { code: "project_invalid", message: "Invalid workflow" },
  };
  expect((await adapter.start(id)).diagnostic?.code).toBe("project_invalid");
  expect(effects).toEqual([]);
  running();
  expect((await adapter.stop(id, journal)).state).toBe("succeeded");
  expect(effects).toEqual(["persist", "stop"]);
});
it("journals canonical folder and legacy runtime identity before stop effects", async () => {
  running();
  const result = await adapter.stop(id, journal);
  expect(result.state).toBe("succeeded");
  expect(effects).toEqual(["persist", "stop"]);
  expect(
    JSON.parse(await readFile(join(root, "stop-target.json"), "utf8"))
  ).toEqual({
    canonicalPath: join(root, "prepared"),
    configDir: join(root, "cli"),
    runtimeProjectId: "legacy-alias-runtime",
    pid: 41,
    processIdentity: "fixture-process-A",
  });
});
it("does not signal after persistence failure or retarget a recovered stop", async () => {
  running();
  await expect(
    adapter.stop(id, {
      async persistStopTarget() {
        throw new Error("journal fsync failed");
      },
    })
  ).rejects.toThrow("journal fsync failed");
  expect(effects).toEqual([]);
  const target: StopTarget = {
    canonicalPath: join(root, "prepared"),
    configDir: join(root, "cli"),
    runtimeProjectId: "legacy-alias-runtime",
    pid: 40,
    processIdentity: "old-process",
  };
  const result = await adapter.stop(id, journal, target);
  expect(result.diagnostic?.code).toBe("superseded_target");
  expect(effects).toEqual([]);
});
it("does not treat CLI signal delivery as verified stop completion", async () => {
  running();
  driver.stop = async () => {
    effects.push("stop");
    return { exitCode: 0, outcome: "signal_sent" };
  };
  const result = await adapter.stop(id, journal);
  expect(result.state).toBe("unknown");
  expect(result.process.state).toBe("running");
  expect(result.diagnostic?.code).toBe("unresolved_command");
});
it("requires exit and lock release and detects a replacement after signaling", async () => {
  running();
  driver.stop = async () => {
    stopped();
    state.locksReleased = false;
    return { exitCode: 0, outcome: "signal_sent" };
  };
  expect((await adapter.stop(id, journal)).state).toBe("unknown");
  running();
  driver.stop = async () => {
    running("fixture-process-B");
    return { exitCode: 0, outcome: "signal_sent" };
  };
  expect((await adapter.stop(id, journal)).diagnostic?.code).toBe(
    "superseded_target"
  );
});
it("revokes new effects after allowlist removal and refuses unverified ownership", async () => {
  state.process = {
    state: "unknown",
    observedAt: new Date().toISOString(),
    diagnostic: { code: "process_unverified", message: "Ownership uncertain" },
  };
  expect((await adapter.start(id)).diagnostic?.code).toBe("process_unverified");
  expect((await adapter.stop(id, journal)).diagnostic?.code).toBe(
    "process_unverified"
  );
  await registry.remove(id);
  await expect(adapter.start(id)).rejects.toThrow("project_unmanaged");
  expect(effects).toEqual([]);
});

it("keeps OS command identities local in inventory and lifecycle results", async () => {
  running("node --credential fixture-OS-secret project start");
  const result = await adapter.start(id);
  expect(result.state).toBe("succeeded");
  expect(JSON.stringify(result)).not.toContain("fixture-OS-secret");
  const inventory = await registry.inventory(driver, "3.0.0");
  expect(JSON.stringify(inventory)).not.toContain("fixture-OS-secret");
});
it("never reports CLI startup completion without readiness", async () => {
  driver.start = async () => {
    running();
    state.ready = false;
    return { exitCode: 0 };
  };
  const result = await adapter.start(id);
  expect(result.state).toBe("unknown");
  expect(result.process.state).toBe("running");
});
