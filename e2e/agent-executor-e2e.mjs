// C08: actual bundled executor/journal, C07 SQLite ledger and real CLI daemons.
// Session/project projection is an independent peer fixture, not fleet routing.
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  AgentRegistry,
  CommandJournal,
  CommandExecutor,
  AgentTransportError,
} from "../packages/cli/dist/management-agent.js";
import { createLocalManagementAdapter } from "../packages/cli/dist/management-local.js";
import { LocalLifecycleAdapter } from "../packages/management-agent/dist/index.js";
import {
  openFleetStore,
  createEnrollmentService,
  createCommandService,
} from "../packages/fleet-control-plane/dist/index.js";

const script = fileURLToPath(import.meta.url);
const cli = fileURLToPath(
  new URL("../packages/cli/dist/index.js", import.meta.url)
);
const probe = process.env.C08_PLANT_FORBIDDEN;
const workflow = `---
tracker:
  kind: file
  provider:
    path: $GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH
    project_id: c08-blackbox
  active_states: [Ready]
polling:
  interval_ms: 1000
codex:
  command: codex
repository:
  slug: fixture/project
---
PRIVATE_WORKFLOW_CANARY
`;
function localOptions(root) {
  return {
    configDir: join(root, "cli"),
    executable: process.execPath,
    argumentPrefix: [cli],
    launchContext: { kind: "foreground" },
    environment: {
      ...process.env,
      GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH: join(root, "issues.json"),
    },
    timeoutMs: 10_000,
    pollIntervalMs: 25,
  };
}
async function until(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}

if (process.argv.includes("--agent")) {
  const root = process.env.C08_ROOT;
  const registry = await AgentRegistry.open(join(root, "agent"));
  const journal = await CommandJournal.open(registry);
  const local = createLocalManagementAdapter(registry, localOptions(root));
  let fault,
    currentCommand,
    sequence = 0;
  const requests = new Map();
  const rpc = (method, input) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new AgentTransportError("network_failure", true));
      }, 10_000);
      requests.set(id, { resolve, reject, timer });
      process.send({ type: "rpc", id, method, input });
    });
  const client = {
    claim: (input) => rpc("claim", input),
    publishResult: (input) => rpc("result", input),
  };
  async function checkpoint() {
    process.send({ type: "checkpoint", commandId: currentCommand });
    await new Promise(() => {}); // Parent kills only this agent at the fault boundary.
  }
  const driver = {
    ...local.reader,
    async inspect(project) {
      const observed = await local.reader.inspect(project);
      return fault === "unverified-stop" && probe !== "unsafe-invalid-stop"
        ? {
            ...observed,
            process: { state: "unknown", observedAt: new Date().toISOString() },
          }
        : observed;
    },
    async start(...args) {
      if (fault === "marker") await checkpoint();
      process.send({ type: "effect", operation: "start" });
      return local.reader.start(...args);
    },
    async stop(...args) {
      process.send({ type: "effect", operation: "stop" });
      let result;
      if (fault === "deferred-exit") {
        // Independent driver-port fixture: queue a real SIGTERM while this
        // ephemeral CLI daemon is OS-paused. The production C02 socket cannot
        // answer while paused; other stop cases use that concrete CLI path.
        const observed = await local.reader.inspect(args[0]);
        assert.equal(observed.process.pid, args[1].pid);
        assert.equal(observed.process.identity, args[1].processIdentity);
        process.kill(args[1].pid, "SIGTERM");
        result = { exitCode: 0, outcome: "signal_sent" };
      } else result = await local.reader.stop(...args);
      process.send({ type: "stop-return", commandId: currentCommand });
      if (fault === "stop") await checkpoint();
      return result;
    },
  };
  const executor = new CommandExecutor(
    registry,
    journal,
    new LocalLifecycleAdapter(registry, driver, {
      timeoutMs: 10_000,
      pollIntervalMs: 25,
    })
  );
  process.on("message", async (message) => {
    if (message.type === "rpc-response") {
      const pending = requests.get(message.id);
      if (!pending) return;
      requests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.errorCode)
        pending.reject(
          new AgentTransportError(
            message.errorCode,
            message.errorCode === "network_failure"
          )
        );
      else pending.resolve(message.value);
    } else if (message.type === "run") {
      fault = message.fault;
      currentCommand = message.response.commands[0]?.commandId;
      try {
        await executor.handlePoll(message.response, client);
        process.send({ type: "complete", id: message.id });
      } catch (error) {
        process.send({
          type: "complete",
          id: message.id,
          errorCode: error.code ?? "local_failure",
        });
      }
    } else if (message.type === "close") {
      await registry.close();
      process.exit(0);
    }
  });
  process.send({ type: "ready" });
} else {
  const root = await realpath(await mkdtemp(join(tmpdir(), "c08-blackbox-")));
  const folder = join(root, "prepared");
  const agents = new Set();
  const effects = [];
  const uploads = [];
  let clock = Date.now(),
    store,
    enrollment,
    commands,
    identity,
    projectId,
    project;
  let observer, local, agent, pausedPid;
  let reportedValid = true;
  let loseClaim = false,
    loseResult = false,
    expireClaim = false;
  let reached = 0;
  function check(condition, label) {
    reached++;
    console.log(`reached: ${label}`);
    assert.ok(condition, label);
  }
  const envelope = () => ({
    protocolVersion: 1,
    environmentId: identity.environmentId,
    sessionId: identity.sessionId,
    requestId: randomUUID(),
  });
  const poll = (entries = []) => ({
    ...envelope(),
    commands: entries.map(
      ({
        commandId,
        projectId,
        environmentId,
        localProjectId,
        sessionId,
        operation,
        actor,
        idempotencyKey,
        submittedAt,
        expiresAt,
      }) => ({
        commandId,
        projectId,
        environmentId,
        localProjectId,
        sessionId,
        operation,
        actor,
        idempotencyKey,
        submittedAt,
        expiresAt,
      })
    ),
    reads: [],
  });
  const entries = async () =>
    JSON.parse(await readFile(join(root, "agent", "commands.json"), "utf8"))
      .entries;
  const entry = async (id) =>
    (await entries()).find((value) => value.command.commandId === id);
  async function plant(id, transform) {
    const state = JSON.parse(
      await readFile(join(root, "agent", "commands.json"), "utf8")
    );
    transform(state.entries.find((value) => value.command.commandId === id));
    await writeFile(
      join(root, "agent", "commands.json"),
      JSON.stringify(state)
    );
  }
  function openControl() {
    store = openFleetStore(join(root, "fleet"));
    store.database
      .exec(`CREATE TABLE IF NOT EXISTS c08_sessions(environment_id TEXT PRIMARY KEY,agent_id TEXT,session_id TEXT);
      CREATE TABLE IF NOT EXISTS c08_projects(project_id TEXT PRIMARY KEY,environment_id TEXT,local_id TEXT,online INTEGER);`);
    enrollment = createEnrollmentService(store, {
      now: () => new Date(clock),
      invalidateManagementAccess() {},
    });
    commands = createCommandService(store, {
      now: () => new Date(clock),
      peers: {
        verifyAgent(database, candidate) {
          enrollment.authenticate(candidate);
          return !!database
            .prepare(
              "SELECT 1 FROM c08_sessions WHERE environment_id=? AND agent_id=? AND session_id=?"
            )
            .get(
              candidate.environmentId,
              candidate.agentId,
              candidate.sessionId
            );
        },
        resolveTarget(database, id) {
          const row = database
            .prepare(
              "SELECT p.*,s.agent_id,s.session_id FROM c08_projects p JOIN c08_sessions s USING(environment_id) WHERE project_id=?"
            )
            .get(id);
          return row
            ? {
                projectId: id,
                environmentId: row.environment_id,
                localProjectId: row.local_id,
                agentId: row.agent_id,
                sessionId: row.session_id,
                online: row.online === 1,
                managed: true,
                valid: reportedValid,
                supported: true,
              }
            : undefined;
        },
      },
    });
  }
  async function deliver(method, input) {
    const candidate = { ...identity, sessionId: input.sessionId };
    if (method === "claim") {
      if (expireClaim) {
        expireClaim = false;
        clock += 30_001;
      }
      const value = await commands.claim(candidate, input);
      if (loseClaim) {
        loseClaim = false;
        throw new AgentTransportError("network_failure", true);
      }
      return value;
    }
    const saved = await entry(input.result.commandId);
    assert.deepEqual(
      input.result,
      saved.result,
      "Upload must follow durable result save"
    );
    uploads.push(structuredClone(input.result));
    const value = await commands.publishResult(candidate, input);
    if (loseResult) {
      loseResult = false;
      throw new AgentTransportError("network_failure", true);
    }
    return value;
  }
  async function startAgent() {
    const child = fork(script, ["--agent"], {
      env: { ...process.env, C08_ROOT: root },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    agents.add(child);
    let sequence = 0,
      checkpoint = false,
      stopReturned = false;
    const pending = new Map();
    child.on("message", async (message) => {
      if (message.type === "rpc") {
        try {
          child.send({
            type: "rpc-response",
            id: message.id,
            value: await deliver(message.method, message.input),
          });
        } catch (error) {
          if (child.connected)
            child.send({
              type: "rpc-response",
              id: message.id,
              errorCode: error.code ?? "fixture_error",
            });
        }
      } else if (message.type === "effect") effects.push(message.operation);
      else if (message.type === "checkpoint") checkpoint = true;
      else if (message.type === "stop-return") stopReturned = true;
      else if (message.type === "complete") {
        pending.get(message.id)?.(message.errorCode);
        pending.delete(message.id);
      }
    });
    child.on("exit", () => {
      for (const resolve of pending.values()) resolve("agent_crashed");
      pending.clear();
      agents.delete(child);
    });
    await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error("Agent startup failed");
      }),
      delay(10_000, undefined, { ref: false }).then(() => {
        throw new Error("Agent startup timeout");
      }),
    ]);
    return {
      run(response = poll(), fault) {
        checkpoint = false;
        stopReturned = false;
        const id = ++sequence;
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve("agent_timeout");
          }, 20_000);
          timer.unref();
          pending.set(id, (result) => {
            clearTimeout(timer);
            resolve(result);
          });
          child.send({ type: "run", id, response, fault });
        });
      },
      checkpoint: () => until(() => checkpoint, "durable crash boundary"),
      stopReturned: () => until(() => stopReturned, "CLI stop signal return"),
      async close(crash = false) {
        const exited = once(child, "exit");
        if (crash) child.kill("SIGKILL");
        else child.send({ type: "close" });
        await exited;
      },
    };
  }
  async function submit(key, operation = "start") {
    clock = Math.max(clock, Date.now());
    const accepted = await commands.submitCommand(projectId, key, {
      operation,
    });
    return commands.getCommand(accepted.commandId);
  }
  async function status() {
    return local.reader.inspect(project);
  }
  function manualStart() {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "--config",
        join(root, "cli"),
        "--json",
        "project",
        "start",
        "--project-dir",
        folder,
        "--daemon",
      ],
      {
        env: localOptions(root).environment,
        cwd: folder,
        encoding: "utf8",
        timeout: 15_000,
      }
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  async function owners() {
    const current = await status();
    return Promise.all(
      [
        join(folder, ".gh-symphony-start.lock"),
        join(
          current.runtime.configDir,
          "projects",
          current.runtime.runtimeProjectId,
          ".lock"
        ),
        join(
          current.runtime.configDir,
          "projects",
          current.runtime.runtimeProjectId,
          "daemon.pid"
        ),
      ].map(async (path) => {
        const { heartbeatAt: _heartbeat, ...owner } = JSON.parse(
          await readFile(path, "utf8")
        );
        return owner;
      })
    );
  }
  try {
    await mkdir(folder);
    await mkdir(join(root, "cli"));
    await writeFile(join(root, "issues.json"), "[]");
    await writeFile(join(folder, "WORKFLOW.md"), workflow);
    openControl();
    const token = await enrollment.createEnvironment({
      name: "C08 process fault host",
    });
    const enrolled = await enrollment.enroll({
      protocolVersion: 1,
      requestId: randomUUID(),
      token: token.token,
    });
    identity = { ...enrolled, sessionId: randomUUID() };
    const registry = await AgentRegistry.open(join(root, "agent"));
    await registry.saveIdentity("https://fixture.example", enrolled);
    project = await registry.add(folder);
    await registry.close();
    projectId = randomUUID();
    store.database
      .prepare("INSERT INTO c08_sessions VALUES (?,?,?)")
      .run(identity.environmentId, identity.agentId, identity.sessionId);
    store.database
      .prepare("INSERT INTO c08_projects VALUES (?,?,?,1)")
      .run(projectId, identity.environmentId, project.localProjectId);
    observer = await AgentRegistry.open(join(root, "observer"));
    await observer.add(folder);
    local = createLocalManagementAdapter(observer, localOptions(root));
    agent = await startAgent();

    await writeFile(join(folder, "WORKFLOW.md"), "invalid workflow");
    const invalid = await submit("invalid-start");
    loseResult = true;
    const invalidRun = await agent.run(poll([invalid]));
    const invalidResult = await commands.getCommand(invalid.commandId);
    check(
      invalidRun === "network_failure" &&
        invalidResult.state === "failed" &&
        invalidResult.diagnostic.code === "project_invalid" &&
        effects.length === 0,
      "CP04 invalid local workflow fails without spawning a daemon"
    );
    await agent.close(true);
    await rename(folder, join(root, "moved-folder"));
    if (probe === "duplicate-result")
      await plant(invalid.commandId, (value) => {
        delete value.result;
      });
    agent = await startAgent();
    const duplicateRun = await agent.run(poll([invalid]));
    const duplicateUploads = uploads.filter(
      (value) => value.commandId === invalid.commandId
    );
    check(
      !duplicateRun &&
        (await entry(invalid.commandId)).acknowledged &&
        duplicateUploads.length === 2 &&
        JSON.stringify(duplicateUploads[0]) ===
          JSON.stringify(duplicateUploads[1]) &&
        effects.length === 0,
      "CP07 duplicate result resends after managed folder disappears"
    );
    await rename(join(root, "moved-folder"), folder);
    await writeFile(join(folder, "WORKFLOW.md"), workflow);

    let command = await submit("lost-claim");
    loseClaim = true;
    check(
      (await agent.run(poll([command]))) === "network_failure",
      "CP18 committed claim response is lost before any effect"
    );
    const claimedAt = (await commands.getCommand(command.commandId)).claimedAt;
    check(
      effects.length === 0 && !(await entry(command.commandId)).effectStartedAt,
      "CP18 durable receipt precedes claim and has no effect marker"
    );
    await agent.close(true);
    clock += 30_001;
    agent = await startAgent();
    check(
      !(await agent.run(poll([command]))),
      "CP18 original claim replay executes after claim deadline"
    );
    if (probe === "claim-time")
      store.database
        .prepare(
          "UPDATE lifecycle_commands SET claimed_at=? WHERE command_id=?"
        )
        .run(
          new Date(Date.parse(claimedAt) + 1).toISOString(),
          command.commandId
        );
    const original = await commands.getCommand(command.commandId);
    check(
      original.state === "succeeded" && original.claimedAt === claimedAt,
      "CP18 original ownership and claim time retained"
    );
    await agent.run(poll([command]));
    check(
      effects.filter((value) => value === "start").length === 1,
      "CP04 CP19 duplicate delivery retains one verified orchestrator"
    );
    const a = await status();
    check(
      a.process.state === "running" && a.ready,
      "CP04 real daemon identity and readiness verified"
    );

    // CP-03 / C07 #1011: publish the true invalid state, preserving process truth.
    await writeFile(join(folder, "WORKFLOW.md"), "invalid workflow");
    const invalidRunning = await status();
    reportedValid = invalidRunning.validation.state === "valid";
    if (probe === "invalid-start") reportedValid = true;
    let rejectedStart = false;
    try {
      await submit("invalid-running-start");
    } catch (error) {
      rejectedStart = error.code === "project_invalid";
    }
    check(
      !reportedValid &&
        invalidRunning.process.state === "running" &&
        rejectedStart,
      "CP03 invalid running workflow rejects fleet start"
    );

    let stopSubmissionError;
    try {
      command = await submit("invalid-unverified-stop", "stop");
    } catch (error) {
      stopSubmissionError = error;
    }
    check(
      !stopSubmissionError,
      "CP03 invalid workflow permits fleet stop submission"
    );
    const beforeUnsafeStop = effects.length;
    await agent.run(poll([command]), "unverified-stop");
    const unverified = await commands.getCommand(command.commandId);
    check(
      unverified.state === "failed" &&
        unverified.diagnostic.code === "process_unverified" &&
        effects.length === beforeUnsafeStop &&
        (await status()).process.state === "running",
      "CP03 invalid workflow unverified stop sends no signal"
    );

    command = await submit("lost-result", "stop");
    loseResult = true;
    check(
      (await agent.run(poll([command]))) === "network_failure",
      "CP07 result commits but acknowledgment is lost"
    );
    const saved = (await entry(command.commandId)).result;
    check(
      saved.state === "succeeded" &&
        !(await entry(command.commandId)).acknowledged,
      "CP07 verified stop result is durable before acknowledgment"
    );
    const stoppedInvalid = await status();
    if (probe === "invalid-stop-completion")
      stoppedInvalid.locksReleased = false;
    check(
      stoppedInvalid.validation.state === "invalid" &&
        stoppedInvalid.process.state === "stopped" &&
        stoppedInvalid.locksReleased &&
        (await commands.getCommand(command.commandId)).state === "succeeded",
      "CP03 invalid workflow verified fleet stop exits and releases locks"
    );
    await writeFile(join(folder, "WORKFLOW.md"), workflow);
    reportedValid = true;
    await agent.close(true);
    store.close();
    openControl();
    identity = { ...identity, sessionId: randomUUID() };
    store.database
      .prepare("UPDATE c08_sessions SET session_id=? WHERE environment_id=?")
      .run(identity.sessionId, identity.environmentId);
    commands.transferOwnership(identity, command.commandId);
    if (probe === "result")
      await plant(command.commandId, (value) => {
        value.result.observedAt = new Date(
          Date.parse(saved.observedAt) + 1
        ).toISOString();
      });
    agent = await startAgent();
    await agent.run(poll());
    const retried = uploads.filter(
      (value) => value.commandId === command.commandId
    );
    check(
      retried.length === 2 &&
        JSON.stringify(retried[0]) === JSON.stringify(retried[1]) &&
        (await entry(command.commandId)).acknowledged,
      "CP07 unchanged result survives agent and fleet restart and ownership transfer"
    );

    command = await submit("marker-crash");
    const interrupted = agent.run(poll([command]), "marker");
    await agent.checkpoint();
    await agent.close(true);
    await interrupted;
    if (probe === "marker")
      await plant(command.commandId, (value) => {
        delete value.effectStartedAt;
      });
    const beforeRecovery = effects.length;
    agent = await startAgent();
    await agent.run(poll());
    check(
      (await commands.getCommand(command.commandId)).state === "unknown" &&
        effects.length === beforeRecovery,
      "CP09 marker-only agent crash remains unknown without effect replay"
    );
    await assert.rejects(
      commands.submitCommand(projectId, "forbidden-replacement", {
        operation: "start",
      }),
      (error) => error.code === "unresolved_command"
    );
    check(true, "CP09 unknown outcome fences replacement command");
    await commands.closeUnresolved(command.commandId, {
      acknowledged: true,
      reason: "Verified fixture crash window; explicitly close unresolved",
    });
    await agent.run(poll());
    check(
      (await entry(command.commandId)).retiredAt &&
        (await commands.getCommand(command.commandId)).state === "unknown",
      "CP09 explicit closure retires journal without fabricating success"
    );
    check(
      !!store.database
        .prepare(
          "SELECT 1 FROM audit_records WHERE target=? AND operation='command.close-unresolved' AND actor='local-owner' AND outcome='unknown'"
        )
        .get(command.commandId),
      "CP09 unresolved closure is durably audited"
    );

    command = await submit("unclaimed-expiry");
    expireClaim = true;
    await agent.run(poll([command]));
    if (probe === "expiry")
      await plant(command.commandId, (value) => {
        value.result = { state: "unknown" };
      });
    check(
      (await commands.getCommand(command.commandId)).state === "expired" &&
        !(await entry(command.commandId)).effectStartedAt &&
        !(await entry(command.commandId)).result,
      "CP06 expired unclaimed receipt never invokes effects or becomes unknown"
    );

    command = await submit("resume-before-stop");
    await agent.run(poll([command]));
    pausedPid = (await status()).process.pid;
    process.kill(pausedPid, "SIGSTOP");
    command = await submit("stop-awaits-exit", "stop");
    const stopping = agent.run(poll([command]), "deferred-exit");
    await agent.stopReturned();
    await delay(100);
    check(
      (await commands.getCommand(command.commandId)).state === "executing" &&
        !(await entry(command.commandId)).result &&
        (await status()).process.state === "running",
      "CP08 signal return alone cannot complete stopped process"
    );
    process.kill(pausedPid, "SIGCONT");
    pausedPid = undefined;
    check(
      !(await stopping) &&
        (await commands.getCommand(command.commandId)).state === "succeeded" &&
        (await status()).locksReleased,
      "CP08 verified target exit and released locks complete stop"
    );

    command = await submit("restart-for-replacement");
    await agent.run(poll([command]));
    command = await submit("interrupted-stop", "stop");
    const replacementCrash = agent.run(poll([command]), "stop");
    await agent.checkpoint();
    await agent.close(true);
    await replacementCrash;
    await until(
      async () =>
        (await status()).process.state === "stopped" &&
        (await status()).locksReleased,
      "target A shutdown"
    );
    manualStart();
    const b = await status();
    const ownership = await owners();
    const effectCount = effects.length;
    if (probe === "replacement") {
      process.kill(b.process.pid, "SIGTERM");
      await until(
        async () => (await status()).process.state === "stopped",
        "planted replacement shutdown"
      );
    }
    agent = await startAgent();
    await agent.run(poll());
    const recovered = await commands.getCommand(command.commandId);
    check(
      recovered.state === "failed" &&
        recovered.diagnostic.code === "superseded_target" &&
        effects.length === effectCount &&
        (await status()).process.pid === b.process.pid,
      "CP08 replacement B survives saved-target recovery without a new signal"
    );
    check(
      JSON.stringify(await owners()) === JSON.stringify(ownership),
      "CP08 replacement ownership records remain intact"
    );
    check(
      JSON.stringify((await entry(command.commandId)).result).indexOf(
        b.process.identity
      ) === -1,
      "CP15 uploaded recovery evidence excludes raw OS identity"
    );

    const runningPid = b.process.pid;
    await agent.close(true);
    check(
      (await status()).process.pid === runningPid && (await status()).ready,
      "CP05 agent crash preserves managed orchestrator"
    );
    const oldSession = identity.sessionId;
    identity = { ...identity, sessionId: randomUUID() };
    store.database
      .prepare("UPDATE c08_sessions SET session_id=? WHERE environment_id=?")
      .run(identity.sessionId, identity.environmentId);
    await assert.rejects(
      commands.claim(
        { ...identity, sessionId: oldSession },
        { ...envelope(), sessionId: oldSession, commandId: command.commandId }
      ),
      (error) =>
        ["claim_owner_conflict", "unauthenticated"].includes(error.code)
    );
    check(true, "CP19 stale session cannot replay claim");
    console.log(
      `agent executor black-box passed: ${reached} reached assertions; host OS=${platform()}; real CLI/agent processes, simulated session/projection and server clock; no native service isolation claim`
    );
  } finally {
    if (pausedPid) {
      try {
        process.kill(pausedPid, "SIGCONT");
      } catch {}
    }
    for (const child of agents) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    if (local && project) {
      const current = await status();
      if (current.process.state === "running")
        await local.adapter.stop(project.localProjectId, {
          async persistStopTarget() {},
        });
    }
    await observer?.close();
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
}
