import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  CommandRecord,
  LifecycleCommand,
} from "@gh-symphony/management-protocol";
import { AgentRegistry } from "./registry.js";
import { CommandJournal, type CommandResult } from "./journal.js";

let root: string;
let registry: AgentRegistry;
let journal: CommandJournal;
let command: LifecycleCommand;
const agentId = "55555555-5555-4555-8555-555555555555";
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "command-journal-")));
  registry = await AgentRegistry.open(join(root, "agent"));
  await registry.saveIdentity("https://localhost:4681", {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: randomUUID(),
    agentId,
    credential: "fixture-only-credential",
  });
  await mkdir(join(root, "project"));
  const project = await registry.add(join(root, "project"));
  command = {
    commandId: randomUUID(),
    projectId: randomUUID(),
    environmentId: registry.identity!.environmentId,
    localProjectId: project.localProjectId,
    sessionId: randomUUID(),
    operation: "stop",
    actor: "local-owner",
    idempotencyKey: "independent-peer-key",
    submittedAt: "2026-10-05T00:00:00Z",
    expiresAt: "2026-10-05T00:00:30Z",
  };
  journal = await CommandJournal.open(registry);
});
afterEach(async () => {
  await registry.close();
  await rm(root, { recursive: true, force: true });
});
function claim(): CommandRecord {
  return {
    ...command,
    state: "executing",
    claimedAt: "2026-10-05T00:00:01Z",
    owner: { agentId, sessionId: command.sessionId },
  };
}
function result(): CommandResult {
  return {
    kind: "command",
    commandId: command.commandId,
    state: "succeeded",
    observedAt: "2026-10-05T00:00:02Z",
    evidence: { verified: true },
  };
}
async function reopen() {
  await registry.close();
  registry = await AgentRegistry.open(join(root, "agent"));
  journal = await CommandJournal.open(registry);
}

it("persists receipt, original claim, target, result and acknowledgment across restart", async () => {
  await journal.receive(command);
  await journal.recordClaim(command.commandId, claim());
  expect(await journal.beginEffect(command.commandId)).toBe(true);
  const target = {
    canonicalPath: join(root, "project"),
    configDir: join(root, "config"),
    runtimeProjectId: "fixture-runtime",
    pid: 1234,
    processIdentity: "fixture-os-identity",
  };
  await journal.persistStopTarget(command.commandId, target);
  await journal.saveResult(command.commandId, result());
  await reopen();
  const entry = journal.get(command.commandId)!;
  expect(entry).toMatchObject({
    command,
    claim: claim(),
    stopTarget: target,
    result: result(),
  });
  expect(entry.effectStartedAt).toBeTruthy();
  expect(await journal.beginEffect(command.commandId)).toBe(false);
  await journal.acknowledge(command.commandId);
  await reopen();
  expect(journal.get(command.commandId)?.acknowledged).toBe(true);
  expect(
    (await stat(join(registry.directory, "commands.json"))).mode & 0o777
  ).toBe(0o600);
  expect(
    await readFile(join(registry.directory, "commands.json"), "utf8")
  ).not.toContain("fixture-only-credential");
});

it("serializes concurrent markers and prevents replay after a marker-only crash", async () => {
  await journal.receive(command);
  await journal.recordClaim(command.commandId, claim());
  expect(await CommandJournal.open(registry)).toBe(journal);
  expect(
    await Promise.all([
      journal.beginEffect(command.commandId),
      journal.beginEffect(command.commandId),
    ])
  ).toEqual([true, false]);
  await reopen();
  expect(await journal.beginEffect(command.commandId)).toBe(false);
  expect(journal.get(command.commandId)?.result).toBeUndefined();
});

it("rejects conflicting receipt, foreign claim, changed claim time and non-executing permission", async () => {
  await journal.receive(command);
  await expect(
    journal.receive({ ...command, operation: "start" })
  ).rejects.toThrow("conflicts");
  await expect(
    journal.receive({ ...command, projectId: randomUUID() })
  ).rejects.toThrow("conflicts");
  await expect(
    journal.recordClaim(command.commandId, {
      ...claim(),
      owner: { agentId: randomUUID(), sessionId: command.sessionId },
    })
  ).rejects.toThrow("own");
  await expect(journal.beginEffect(command.commandId)).rejects.toThrow(
    "Executing claim"
  );
  await journal.recordClaim(command.commandId, claim());
  await expect(
    journal.recordClaim(command.commandId, {
      ...claim(),
      claimedAt: "2026-10-05T00:00:02Z",
    })
  ).rejects.toThrow("claim time");
  await journal.recordClaim(command.commandId, {
    ...claim(),
    state: "unknown",
  });
  await expect(journal.beginEffect(command.commandId)).rejects.toThrow(
    "Executing claim"
  );
});

it("keeps stop target and result immutable and forbids acknowledgment without a result", async () => {
  await journal.receive(command);
  await journal.recordClaim(command.commandId, claim());
  const target = {
    canonicalPath: join(root, "project"),
    configDir: join(root, "config"),
    runtimeProjectId: "fixture-runtime",
    pid: 1234,
    processIdentity: "fixture-os-identity",
  };
  await expect(
    journal.persistStopTarget(command.commandId, target)
  ).rejects.toThrow("matching durable effect");
  await journal.beginEffect(command.commandId);
  await journal.persistStopTarget(command.commandId, target);
  await expect(
    journal.persistStopTarget(command.commandId, { ...target, pid: 4321 })
  ).rejects.toThrow("replace");
  await expect(journal.acknowledge(command.commandId)).rejects.toThrow(
    "missing result"
  );
  await journal.saveResult(command.commandId, result());
  await expect(
    journal.saveResult(command.commandId, { ...result(), state: "failed" })
  ).rejects.toThrow("replace");
});

it("rejects unsafe files, corrupted state and another enrolled owner on reopen", async () => {
  await journal.receive(command);
  const path = join(registry.directory, "commands.json");
  const saved = await readFile(path, "utf8");
  await registry.close();
  await chmod(path, 0o644);
  registry = await AgentRegistry.open(join(root, "agent"));
  await expect(CommandJournal.open(registry)).rejects.toThrow("private");
  await registry.close();
  await chmod(path, 0o600);
  await writeFile(path, '{"version":2,"entries":[]}');
  registry = await AgentRegistry.open(join(root, "agent"));
  await expect(CommandJournal.open(registry)).rejects.toThrow("version");
  await registry.close();
  const state = JSON.parse(saved);
  state.entries[0].agentId = randomUUID();
  await writeFile(path, JSON.stringify(state));
  registry = await AgentRegistry.open(join(root, "agent"));
  await expect(CommandJournal.open(registry)).rejects.toThrow(
    "another enrolled"
  );
  await registry.close();
  await rm(path);
  await writeFile(join(root, "external"), saved, { mode: 0o600 });
  await symlink(join(root, "external"), path);
  registry = await AgentRegistry.open(join(root, "agent"));
  await expect(CommandJournal.open(registry)).rejects.toThrow("private");
});

it("retains acknowledged results for 30 days and never prunes unresolved effects", async () => {
  await journal.receive(command);
  await journal.recordClaim(command.commandId, claim());
  await journal.beginEffect(command.commandId);
  await journal.prune(new Date(Date.now() + 31 * 86_400_000));
  expect(journal.get(command.commandId)?.effectStartedAt).toBeTruthy();
  await journal.saveResult(command.commandId, result());
  await journal.acknowledge(command.commandId);
  const acknowledgedAt = journal.get(command.commandId)!.acknowledgedAt!;
  await journal.prune(
    new Date(Date.parse(acknowledgedAt) + 30 * 86_400_000 - 1)
  );
  expect(journal.get(command.commandId)).toBeDefined();
  await journal.prune(new Date(Date.parse(acknowledgedAt) + 30 * 86_400_000));
  expect(journal.get(command.commandId)).toBeUndefined();
  await reopen();
  expect(journal.list()).toEqual([]);
});

it("sanitizes malformed journal JSON without echoing private process evidence", async () => {
  await journal.receive(command);
  await registry.close();
  await writeFile(
    join(registry.directory, "commands.json"),
    '{"fixture-private-process-evidence": invalid-json}'
  );
  registry = await AgentRegistry.open(join(root, "agent"));
  await expect(CommandJournal.open(registry)).rejects.toThrow(
    "Malformed command journal JSON"
  );
});

it("never prunes an acknowledged unknown until explicit fleet retirement", async () => {
  await journal.receive(command);
  await journal.recordClaim(command.commandId, claim());
  await journal.beginEffect(command.commandId);
  await journal.saveResult(command.commandId, {
    ...result(),
    state: "unknown",
  });
  await journal.acknowledge(command.commandId);
  await journal.prune(new Date(Date.now() + 31 * 86_400_000));
  expect(journal.get(command.commandId)?.result?.state).toBe("unknown");
  await journal.retire(command.commandId);
  await journal.prune(new Date(Date.now() + 31 * 86_400_000));
  expect(journal.get(command.commandId)).toBeUndefined();
});
