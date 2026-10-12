import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  claimRequestSchema,
  resultRequestSchema,
  type AgentControlPlaneClient,
  type AgentEnvelope,
  type CommandRecord,
  type LifecycleCommand,
  type PollResponse,
} from "@gh-symphony/management-protocol";
import { AgentRegistry } from "./registry.js";
import { CommandJournal } from "./journal.js";
import {
  LocalLifecycleAdapter,
  type RuntimeDriver,
  type RuntimeInspection,
  type StopTarget,
} from "./lifecycle.js";
import { CommandExecutor } from "./executor.js";
import { AgentTransportError } from "./transport.js";

let root: string;
let registry: AgentRegistry;
let journal: CommandJournal;
let executor: CommandExecutor;
let command: LifecycleCommand;
let envelope: AgentEnvelope;
let state: RuntimeInspection;
let driver: RuntimeDriver;
let effects: string[];
let targetAlive: boolean;
let claimed: CommandRecord | undefined;
let resultUploads: unknown[];
let loseClaim: boolean;
let loseResult: boolean;
let client: Pick<AgentControlPlaneClient, "claim" | "publishResult">;
const agentId = "55555555-5555-4555-8555-555555555555";
const now = () => new Date().toISOString();
function poll(commands: LifecycleCommand[] = [command]): PollResponse {
  return { ...envelope, commands, reads: [] };
}
function running(ready = true, identity = "fixture-A") {
  state = {
    ...state,
    process: { state: "running", pid: 101, identity, observedAt: now() },
    ready,
    locksReleased: false,
  };
}
function stopped(locksReleased = true) {
  state = {
    ...state,
    process: { state: "stopped", observedAt: now() },
    ready: false,
    locksReleased,
  };
  targetAlive = false;
}
function target(): StopTarget {
  return {
    ...state.runtime!,
    canonicalPath: join(root, "project"),
    pid: 101,
    processIdentity: "fixture-A",
  };
}
function createExecutor() {
  executor = new CommandExecutor(
    registry,
    journal,
    new LocalLifecycleAdapter(registry, driver, {
      timeoutMs: 20,
      pollIntervalMs: 1,
    })
  );
}
async function reopen() {
  await registry.close();
  registry = await AgentRegistry.open(join(root, "agent"));
  journal = await CommandJournal.open(registry);
  createExecutor();
}
async function marker() {
  await journal.receive(command);
  const response = await client.claim({
    ...envelope,
    commandId: command.commandId,
  });
  await journal.recordClaim(command.commandId, response.command);
  await journal.beginEffect(command.commandId);
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agent-executor-")));
  registry = await AgentRegistry.open(join(root, "agent"));
  const environmentId = randomUUID();
  await registry.saveIdentity("https://localhost:4681", {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId,
    agentId,
    credential: "fixture-private-management",
  });
  await mkdir(join(root, "project"));
  const project = await registry.add(join(root, "project"));
  envelope = {
    protocolVersion: 1,
    environmentId,
    sessionId: randomUUID(),
    requestId: randomUUID(),
  };
  command = {
    commandId: randomUUID(),
    projectId: randomUUID(),
    environmentId,
    localProjectId: project.localProjectId,
    sessionId: envelope.sessionId,
    operation: "start",
    actor: "local-owner",
    idempotencyKey: "peer-key",
    submittedAt: now(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
  journal = await CommandJournal.open(registry);
  effects = [];
  resultUploads = [];
  claimed = undefined;
  loseClaim = false;
  loseResult = false;
  targetAlive = false;
  state = {
    validation: { state: "valid" },
    process: { state: "stopped", observedAt: now() },
    runs: [],
    ready: false,
    locksReleased: true,
    runtime: {
      configDir: join(root, "config"),
      runtimeProjectId: "fixture-runtime",
    },
  };
  // Independent typed C07 peer. It persists the claim separately from the real
  // agent journal and can lose either response after committing its own state.
  client = {
    async claim(input) {
      const request = claimRequestSchema.parse(input);
      const receipt = JSON.parse(
        await readFile(join(registry.directory, "commands.json"), "utf8")
      ).entries[0];
      expect(receipt.command.commandId).toBe(request.commandId);
      if (!claimed) {
        claimed = {
          ...command,
          state: "executing",
          claimedAt: now(),
          owner: { agentId, sessionId: envelope.sessionId },
        };
        await writeFile(join(root, "peer-claim.json"), JSON.stringify(claimed));
      }
      if (loseClaim) {
        loseClaim = false;
        throw new AgentTransportError("network_failure", true);
      }
      return {
        protocolVersion: 1,
        requestId: request.requestId,
        environmentId: request.environmentId,
        sessionId: request.sessionId,
        command: JSON.parse(
          await readFile(join(root, "peer-claim.json"), "utf8")
        ),
      };
    },
    async publishResult(input) {
      const request = resultRequestSchema.parse(input);
      expect(journal.get(command.commandId)?.result).toEqual(request.result);
      resultUploads.push(structuredClone(request.result));
      await writeFile(
        join(root, "peer-result.json"),
        JSON.stringify(request.result)
      );
      if (loseResult) {
        loseResult = false;
        throw new AgentTransportError("network_failure", true);
      }
      return {
        protocolVersion: 1,
        requestId: request.requestId,
        environmentId: request.environmentId,
        sessionId: request.sessionId,
        receivedAt: now(),
      };
    },
  };
  driver = {
    async inspect() {
      return structuredClone(state);
    },
    async start(_project, deadline) {
      const durable = JSON.parse(
        await readFile(join(registry.directory, "commands.json"), "utf8")
      ).entries[0];
      expect(durable.effectStartedAt).toBeTruthy();
      expect(deadline).toBeLessThanOrEqual(
        Date.parse(durable.claim.claimedAt) + 60_000
      );
      effects.push("start");
      running();
      return { exitCode: 0 };
    },
    async stop(_project, expected) {
      expect(journal.get(command.commandId)?.stopTarget).toEqual(expected);
      effects.push("stop");
      stopped();
      return { exitCode: 0, outcome: "signal_sent" };
    },
    async targetExited() {
      return !targetAlive;
    },
  };
  createExecutor();
});
afterEach(async () => {
  await registry.close();
  await rm(root, { recursive: true, force: true });
});

it("replays a lost claim response and fences concurrent duplicate deliveries", async () => {
  loseClaim = true;
  await expect(executor.handlePoll(poll(), client)).rejects.toThrow(
    "network_failure"
  );
  expect(effects).toEqual([]);
  // Server-owned original time, not a locally renewed claim deadline.
  claimed!.claimedAt = new Date(Date.now() - 40_000).toISOString();
  claimed!.submittedAt = new Date(Date.now() - 45_000).toISOString();
  claimed!.expiresAt = new Date(Date.now() - 15_000).toISOString();
  // Persist the independent earlier receipt as if server commit preceded loss.
  command.submittedAt = claimed!.submittedAt;
  command.expiresAt = claimed!.expiresAt;
  const local = JSON.parse(
    await readFile(join(registry.directory, "commands.json"), "utf8")
  );
  local.entries[0].command = command;
  await writeFile(
    join(registry.directory, "commands.json"),
    JSON.stringify(local)
  );
  await writeFile(join(root, "peer-claim.json"), JSON.stringify(claimed));
  await reopen();
  await Promise.all([
    executor.handlePoll(poll(), client),
    executor.handlePoll(poll(), client),
  ]);
  expect(effects).toEqual(["start"]);
  expect(journal.get(command.commandId)?.claim?.claimedAt).toBe(
    claimed!.claimedAt
  );
  expect(journal.get(command.commandId)?.acknowledged).toBe(true);
});

it("resends the durable result after lost acknowledgment and restart without effects", async () => {
  loseResult = true;
  await expect(executor.handlePoll(poll(), client)).rejects.toThrow(
    "network_failure"
  );
  const saved = journal.get(command.commandId)?.result;
  expect(saved?.state).toBe("succeeded");
  expect(journal.get(command.commandId)?.acknowledged).not.toBe(true);
  await reopen();
  await executor.handlePoll(poll([]), client);
  expect(resultUploads).toEqual([saved, saved]);
  expect(effects).toEqual(["start"]);
  expect(journal.get(command.commandId)?.acknowledged).toBe(true);
});

it("executes verified stop only after the durable expected target is saved", async () => {
  command.operation = "stop";
  running();
  targetAlive = true;
  await executor.handlePoll(poll(), client);
  expect(effects).toEqual(["stop"]);
  expect(journal.get(command.commandId)?.result?.state).toBe("succeeded");
  await executor.handlePoll(poll(), client);
  expect(effects).toEqual(["stop"]);
});

it("keeps a marker-only crash unknown without invoking the original effect", async () => {
  await marker();
  await reopen();
  await executor.handlePoll(poll([]), client);
  expect(effects).toEqual([]);
  expect(journal.get(command.commandId)?.result?.state).toBe("unknown");
  expect(journal.get(command.commandId)?.result?.diagnostic?.code).toBe(
    "unresolved_command"
  );
});

it("keeps interrupted stop without a persisted target unknown", async () => {
  command.operation = "stop";
  await marker();
  running();
  await reopen();
  await executor.handlePoll(poll([]), client);
  expect(effects).toEqual([]);
  expect(journal.get(command.commandId)?.result?.state).toBe("unknown");
});

it("resolves an acknowledged unknown from later evidence without replay", async () => {
  await marker();
  await executor.handlePoll(poll([]), client);
  expect(journal.get(command.commandId)?.result?.state).toBe("unknown");
  running();
  await reopen();
  await executor.handlePoll(poll([]), client);
  expect(journal.get(command.commandId)?.result?.state).toBe("succeeded");
  expect(effects).toEqual([]);
  expect(resultUploads).toHaveLength(2);
});

it.each([true, false])(
  "reconciles interrupted start only with verified readiness=%s",
  async (ready) => {
    await marker();
    running(ready);
    await reopen();
    await executor.handlePoll(poll([]), client);
    expect(effects).toEqual([]);
    expect(journal.get(command.commandId)?.result?.state).toBe(
      ready ? "succeeded" : "unknown"
    );
    expect(
      JSON.stringify(journal.get(command.commandId)?.result)
    ).not.toContain("fixture-A");
  }
);

it.each(["exited", "locked", "alive", "replacement", "runtime"] as const)(
  "reconciles stop using persisted target: %s",
  async (condition) => {
    command.operation = "stop";
    running();
    targetAlive = true;
    await marker();
    await journal.persistStopTarget(command.commandId, target());
    if (condition === "exited") stopped();
    if (condition === "locked") stopped(false);
    if (condition === "alive") {
      stopped();
      targetAlive = true;
    }
    if (condition === "replacement") running(true, "fixture-B");
    if (condition === "runtime")
      state.runtime = {
        ...state.runtime!,
        runtimeProjectId: "replacement-runtime",
      };
    await reopen();
    await executor.handlePoll(poll([]), client);
    expect(effects).toEqual([]);
    const result = journal.get(command.commandId)?.result;
    expect(result?.state).toBe(
      condition === "exited"
        ? "succeeded"
        : ["replacement", "runtime"].includes(condition)
          ? "failed"
          : "unknown"
    );
    if (["replacement", "runtime"].includes(condition))
      expect(result?.diagnostic?.code).toBe("superseded_target");
  }
);

it.each(["unknown", "succeeded", "failed"] as const)(
  "never begins effects from a %s claim replay",
  async (status) => {
    await journal.receive(command);
    await client.claim({ ...envelope, commandId: command.commandId });
    claimed!.state = status;
    if (status !== "unknown") {
      claimed!.completedAt = now();
      claimed!.evidence = { verified: true };
    }
    await writeFile(join(root, "peer-claim.json"), JSON.stringify(claimed));
    await executor.handlePoll(poll(), client);
    expect(effects).toEqual([]);
    expect(journal.get(command.commandId)?.effectStartedAt).toBeUndefined();
    if (status === "unknown")
      expect(journal.get(command.commandId)?.result?.state).toBe("unknown");
    else expect(journal.get(command.commandId)?.retiredAt).toBeTruthy();
  }
);

it("rejects a foreign owner and a mismatched request before a marker", async () => {
  await journal.receive(command);
  const response = await client.claim({
    ...envelope,
    commandId: command.commandId,
  });
  const original = client.claim;
  client.claim = async (request) => ({
    ...(await original(request)),
    command: {
      ...response.command,
      owner: { agentId: randomUUID(), sessionId: envelope.sessionId },
    },
  });
  await expect(executor.handlePoll(poll(), client)).rejects.toThrow();
  expect(journal.get(command.commandId)?.effectStartedAt).toBeUndefined();
  client.claim = async (request) => ({
    ...(await original(request)),
    requestId: randomUUID(),
  });
  await expect(executor.handlePoll(poll(), client)).rejects.toThrow(
    "response_identity_mismatch"
  );
  expect(effects).toEqual([]);
});

it.each([true, false])(
  "reconciles transferred same-agent ownership without renewed permission; marker=%s",
  async (hasMarker) => {
    if (hasMarker) await marker();
    else {
      await journal.receive(command);
      await client.claim({ ...envelope, commandId: command.commandId });
    }
    running();
    envelope.sessionId = randomUUID();
    claimed!.owner!.sessionId = envelope.sessionId;
    claimed!.state = "unknown";
    await writeFile(join(root, "peer-claim.json"), JSON.stringify(claimed));
    await reopen();
    await executor.handlePoll(poll([]), client);
    expect(effects).toEqual([]);
    expect(journal.get(command.commandId)?.claim?.owner?.sessionId).toBe(
      envelope.sessionId
    );
    expect(journal.get(command.commandId)?.result?.state).toBe(
      hasMarker ? "succeeded" : "unknown"
    );
  }
);

it("does not reset an elapsed original execution observation deadline", async () => {
  command.submittedAt = new Date(Date.now() - 90_000).toISOString();
  command.expiresAt = new Date(Date.now() - 60_000).toISOString();
  await journal.receive(command);
  claimed = {
    ...command,
    state: "executing",
    claimedAt: new Date(Date.now() - 70_000).toISOString(),
    owner: { agentId, sessionId: envelope.sessionId },
  };
  await writeFile(join(root, "peer-claim.json"), JSON.stringify(claimed));
  await executor.handlePoll(poll(), client);
  expect(journal.get(command.commandId)?.effectStartedAt).toBeUndefined();
  expect(journal.get(command.commandId)?.result?.state).toBe("unknown");
  expect(effects).toEqual([]);
});

it("persists a sanitized unknown outcome when a local effect throws", async () => {
  driver.start = async () => {
    throw new Error("fixture-private-management local driver failed");
  };
  await executor.handlePoll(poll(), client);
  expect(journal.get(command.commandId)?.result?.state).toBe("unknown");
  expect(JSON.stringify(resultUploads)).not.toContain(
    "fixture-private-management"
  );
});

it("retires authoritative expired claims without effects or an unknown result", async () => {
  client.claim = async () => {
    throw new AgentTransportError("command_expired", false);
  };
  await executor.handlePoll(poll(), client);
  expect(journal.get(command.commandId)?.retiredAt).toBeTruthy();
  expect(journal.get(command.commandId)?.result).toBeUndefined();
  expect(effects).toEqual([]);
  await executor.handlePoll(poll([]), client);
});
