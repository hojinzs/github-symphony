// C11: real bundled C03/C05/C11 composition. Native mode uses actual systemd;
// simulation substitutes only the OS manager/readback, never the managed CLI.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer, request } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import * as management from "../packages/cli/dist/management-agent.js";
import {
  createLocalManagementAdapter,
  inspectLocalProject,
} from "../packages/cli/dist/management-local.js";
import {
  pollResponseSchema,
  observationRequestSchema,
  sessionRequestSchema,
} from "../packages/management-protocol/dist/index.js";

const self = fileURLToPath(import.meta.url);
const cli = join(dirname(self), "../packages/cli/dist/index.js");
const probe = process.env.C11_PLANT_FORBIDDEN;
const agentGroup = "/fixture/gh-symphony-agent.service";
function check(condition, label) {
  console.log(`reached: ${label}`);
  assert.ok(condition, label);
}
async function until(predicate, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function jsonRpc(origin, ca, path, body, credential) {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, origin),
      {
        method: "POST",
        ca,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential}`,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (b) => {
          text += b;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error("Fixture response invalid"));
          }
        });
      }
    );
    req.setTimeout(60_000, () =>
      req.destroy(new Error("Fixture request timeout"))
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
async function execute(executable, args, environment = process.env) {
  const child = spawn(executable, args, {
    env: environment,
    timeout: 15_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout.on("data", (b) => {
    stdout += b;
  });
  const [exitCode] = await once(child, "close");
  return { exitCode, stdout };
}

// Independent C06 delivery/journal fixture: exercise C03 and C05 contracts without
// claiming production command claims/replay semantics. Journal retains the effect
// result across agent restart so the test never auto-replays a start.
export async function agentEntrypoint() {
  const args = process.argv.slice(2);
  assert.ok(args.includes("--native-service=linux"));
  const configPath = args[args.indexOf("--config") + 1];
  const directory = args[args.indexOf("--data-dir") + 1];
  const cfg = JSON.parse(await readFile(configPath, "utf8"));
  const ca = await readFile(cfg.certPath);
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  let local;
  await management.runForegroundAgent({
    directory,
    agentVersion: "C11-fixture",
    signal: controller.signal,
    client: (identity, signal) =>
      management.createAgentTransport({
        serverOrigin: identity.serverOrigin,
        identity: () => identity,
        ca,
        signal,
      }),
    snapshot: async (registry) => {
      local ??= createLocalManagementAdapter(registry, {
        configDir: cfg.cliConfig,
        executable: process.execPath,
        argumentPrefix: [cfg.cliBoundary],
        environment: {
          ...process.env,
          GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH: cfg.issuesPath,
          GH_SYMPHONY_AGENT_CREDENTIAL: registry.identity.credential,
          ACCIDENTAL_COPY: registry.identity.credential,
        },
        launchContext: management.createLinuxProjectLaunchContext({
          managementCredentials: [registry.identity.credential],
          ...(cfg.simulation
            ? {
                runner: (command) =>
                  jsonRpc(
                    cfg.origin,
                    ca,
                    "/fixture/systemd",
                    command,
                    registry.identity.credential
                  ),
                currentControlGroup: async () => agentGroup,
                cgroupRoot: cfg.cgroupRoot,
              }
            : {}),
        }),
        timeoutMs: 10_000,
        pollIntervalMs: 50,
      });
      return (await registry.inventory(local.reader, "C11-fixture")).map(
        (p) => ({ ...p, projectId: cfg.projectIds[p.localProjectId] })
      );
    },
    handlePoll: async (response) => {
      for (const command of response.commands) {
        const path = join(
          directory,
          `fixture-journal-${command.commandId}.json`
        );
        if (
          await access(path).then(
            () => true,
            () => false
          )
        )
          continue;
        await writeFile(
          path,
          JSON.stringify({ commandId: command.commandId, state: "executing" }),
          { mode: 0o600 }
        );
        const result = await local.adapter.start(command.localProjectId);
        await writeFile(
          path,
          JSON.stringify({ commandId: command.commandId, ...result }),
          { mode: 0o600 }
        );
      }
    },
  });
}

async function main() {
  const native = process.argv.includes("--native");
  if (
    native &&
    (process.platform !== "linux" ||
      !(await access("/sys/fs/cgroup/cgroup.controllers").then(
        () => true,
        () => false
      )))
  ) {
    console.error(
      "C11 native prerequisite unavailable: Linux unified cgroup v2 required"
    );
    process.exitCode = 69;
    return;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "c11-blackbox-")));
  const dataDirectory = join(root, "agent");
  const projectFolder = join(root, "prepared $ literal % space");
  const cliConfig = join(root, "cli");
  const unitConfig = {
    homeDirectory: native ? homedir() : join(root, "home"),
    nodePath: process.execPath,
    entryPath: join(root, "entry % $ literal.mjs"),
    configPath: join(root, "service config.json"),
    dataDirectory,
  };
  const unitPath = join(
    unitConfig.homeDirectory,
    ".config/systemd/user/gh-symphony-agent.service"
  );
  let fixtureProjectUnit;
  let forbiddenDefinitionCreated = false;
  let service,
    installed = false,
    serviceChild,
    registry,
    server,
    savedUnit,
    identity,
    localId;
  let commands = [],
    sessionId,
    observed = false;
  const unitRecords = new Map();
  let diagnostics = "";
  const stopChild = async () => {
    if (
      !serviceChild ||
      serviceChild.exitCode !== null ||
      serviceChild.signalCode !== null
    )
      return;
    const child = serviceChild;
    process.kill(-child.pid, "SIGTERM");
    await until(
      () => child.exitCode !== null || child.signalCode !== null,
      "fixture agent shutdown"
    );
  };
  try {
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
        cwd: join(dirname(cli), ".."),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    )[0];
    const files = new Set(packed.files.map((f) => f.path));
    if (probe === "package") files.delete("dist/management-agent.d.ts");
    check(
      files.has("dist/management-agent.js") &&
        files.has("dist/management-agent.d.ts") &&
        typeof management.LinuxAgentService === "function" &&
        typeof management.createLinuxProjectLaunchContext === "function",
      "C11 packaged typed Linux adapter"
    );
    if (
      native &&
      (await access(unitPath).then(
        () => true,
        () => false
      ))
    )
      throw new Error(
        "Native fixture refuses to replace an existing agent service"
      );
    if (!native) await mkdir(unitConfig.homeDirectory, { mode: 0o700 });
    await mkdir(projectFolder);
    await mkdir(cliConfig);
    const issuesPath = join(root, "issues.json");
    await writeFile(issuesPath, "[]");
    await writeFile(
      join(projectFolder, "WORKFLOW.md"),
      `---
tracker:
  kind: file
  provider:
    path: $GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH
    project_id: c11-fixture
  active_states: [Ready]
polling:
  interval_ms: 1000
codex:
  command: codex
repository:
  slug: fixture/project
---
Fixture prompt
`
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(root, "key"),
        "-out",
        join(root, "cert"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" }
    );
    const ca = await readFile(join(root, "cert"));
    const cgroupRoot = join(root, "fixture-cgroups");
    const emptyUnit =
      "gh-symphony-project-11111111-1111-1111-1111-111111111111.service";
    const liveUnit =
      "gh-symphony-project-22222222-2222-2222-2222-222222222222.service";
    if (!native) {
      for (const [unit, populated] of [
        [emptyUnit, 0],
        [liveUnit, 1],
      ]) {
        const controlGroup = `/fixture/${unit}`;
        await mkdir(join(cgroupRoot, controlGroup), { recursive: true });
        await writeFile(
          join(cgroupRoot, controlGroup, "cgroup.events"),
          `populated ${populated}\n`
        );
        unitRecords.set(unit, {
          ActiveState: "active",
          SubState: "exited",
          Transient: "yes",
          Type: "oneshot",
          RemainAfterExit: "yes",
          InvocationID: "a".repeat(32),
          ControlGroup: controlGroup,
        });
      }
    }
    const fixtureRunner = async (command) => {
      const args = command.args;
      if (args.includes("--version"))
        return { exitCode: 0, stdout: "systemd 254\n" };
      if (args.includes("show-user")) return { exitCode: 0, stdout: "no\n" };
      if (args.includes("list-units"))
        return {
          exitCode: 0,
          stdout: [...unitRecords.keys()]
            .map((u) => `${u} loaded active exited Fixture`)
            .join("\n"),
        };
      if (
        args.includes("stop") &&
        !args.includes("gh-symphony-agent.service")
      ) {
        const unit = args.find((a) => a.endsWith(".service"));
        if (probe !== "cleanup") unitRecords.delete(unit);
        return { exitCode: 0, stdout: "" };
      }
      if (args.includes("show-environment"))
        return {
          exitCode: 0,
          stdout: args.includes("--output=json")
            ? "{}"
            : `GH_SYMPHONY_AGENT_CREDENTIAL=${identity.credential}\nMANAGER_ONLY=${identity.credential}\n`,
        };
      if (command.executable === "/usr/bin/systemd-run") {
        assert.ok(
          args.includes("--service-type=oneshot") &&
            args.includes("--remain-after-exit") &&
            !args.includes("--scope")
        );
        const separator = args.indexOf("--");
        assert.equal(args[separator + 1], process.execPath);
        const unit = args.find((a) => a.startsWith("--unit=")).slice(7);
        const inherited = {
          GH_SYMPHONY_AGENT_CREDENTIAL: identity.credential,
          MANAGER_ONLY: identity.credential,
        };
        for (const name of args
          .filter((a) => a.startsWith("--setenv="))
          .map((a) => a.slice(9)))
          inherited[name] = command.environment[name];
        for (const name of (
          args
            .find((a) => a.startsWith("--property=UnsetEnvironment="))
            ?.slice(28) ?? ""
        ).split(" "))
          delete inherited[name];
        const result = await execute(
          args[separator + 1],
          args.slice(separator + 2),
          inherited
        );
        unitRecords.set(unit, {
          ActiveState: result.exitCode === 0 ? "active" : "failed",
          SubState: "exited",
          ControlGroup: `/fixture/${unit}`,
          ExecMainCode: "1",
          ExecMainStatus: String(result.exitCode),
        });
        return { exitCode: result.exitCode, stdout: "" };
      }
      if (args.includes("show")) {
        const name = args.find((a) => a.endsWith(".service"));
        if (!name) return { exitCode: 0, stdout: "254\n" };
        const record =
          name === "gh-symphony-agent.service"
            ? {
                ActiveState:
                  serviceChild?.exitCode === null ? "active" : "inactive",
                ControlGroup: agentGroup,
                LoadState: await access(unitPath).then(
                  () => "loaded",
                  () => "not-found"
                ),
                FragmentPath: await access(unitPath).then(
                  () => unitPath,
                  () => ""
                ),
                DropInPaths: "",
                Transient: "no",
              }
            : unitRecords.get(name);
        return {
          exitCode: record ? 0 : 1,
          stdout: record
            ? Object.entries(record)
                .map(([k, v]) => `${k}=${v}`)
                .join("\n")
            : "",
        };
      }
      if (args.includes("stop")) await stopChild();
      if (args.includes("restart")) await stopChild();
      if (args.includes("start") || args.includes("restart")) {
        if (
          !serviceChild ||
          serviceChild.exitCode !== null ||
          serviceChild.signalCode !== null
        ) {
          serviceChild = spawn(
            process.execPath,
            [
              unitConfig.entryPath,
              "--config",
              unitConfig.configPath,
              "--data-dir",
              dataDirectory,
              "--native-service=linux",
            ],
            { detached: true, stdio: ["ignore", "pipe", "pipe"] }
          );
          serviceChild.stdout.on("data", (b) => {
            diagnostics += b;
          });
          serviceChild.stderr.on("data", (b) => {
            diagnostics += b;
          });
        }
      }
      return { exitCode: 0, stdout: "" };
    };
    server = createServer(
      { key: await readFile(join(root, "key")), cert: ca },
      async (req, res) => {
        res.setHeader("content-type", "application/json");
        try {
          let text = "";
          for await (const b of req) text += b;
          const input = text
            ? JSON.parse(text)
            : Object.fromEntries(
                new URL(req.url, "https://localhost").searchParams
              );
          if (!text) input.protocolVersion = Number(input.protocolVersion);
          assert.equal(
            req.headers.authorization,
            `Bearer ${identity.credential}`
          );
          if (req.url.startsWith("/fixture/systemd")) {
            res.end(JSON.stringify(await fixtureRunner(input)));
            return;
          }
          if (req.url.startsWith("/api/v1/agents/sessions")) {
            sessionRequestSchema.parse(input);
            sessionId = randomUUID();
            observed = false;
            res.end(
              JSON.stringify({
                protocolVersion: 1,
                environmentId: input.environmentId,
                requestId: input.requestId,
                sessionId,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              })
            );
          } else if (req.url.startsWith("/api/v1/agents/observations")) {
            observationRequestSchema.parse(input);
            observed = true;
            res.end(
              JSON.stringify({
                ...input,
                inventory: undefined,
                sequence: undefined,
                observedAt: undefined,
                receivedAt: new Date().toISOString(),
              })
            );
          } else if (req.url.startsWith("/api/v1/agents/poll")) {
            const delivered = commands
              .splice(0)
              .map((c) => ({ ...c, sessionId }));
            res.end(
              JSON.stringify(
                pollResponseSchema.parse({
                  ...input,
                  commands: delivered,
                  reads: [],
                })
              )
            );
          } else {
            res.writeHead(404);
            res.end("{}");
          }
        } catch {
          res.writeHead(400);
          res.end("{}");
        }
      }
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `https://localhost:${server.address().port}`;
    registry = await management.AgentRegistry.open(dataDirectory);
    await registry.saveIdentity(origin, {
      protocolVersion: 1,
      requestId: randomUUID(),
      environmentId: randomUUID(),
      agentId: randomUUID(),
      credential: `c11-private-${randomUUID()}`,
    });
    identity = registry.identity;
    const project = await registry.add(projectFolder);
    localId = project.localProjectId;
    const invalidFolder = join(root, "invalid");
    await mkdir(invalidFolder);
    const invalid = await registry.add(invalidFolder);
    await registry.close();
    registry = undefined;
    const registryPath = join(dataDirectory, "registry.json");
    const savedRegistry = await readFile(registryPath, "utf8");
    const boundary = join(root, "cli-boundary.mjs");
    await writeFile(
      boundary,
      `import {writeFileSync} from "node:fs"; import {spawnSync} from "node:child_process";
writeFileSync(${JSON.stringify(join(root, "project-environment.json"))},JSON.stringify(process.env),{mode:0o600});
const child=spawnSync(process.execPath,[${JSON.stringify(cli)},...process.argv.slice(2)],{stdio:"inherit",env:process.env});process.exit(child.status??1);
`
    );
    await writeFile(
      unitConfig.configPath,
      JSON.stringify({
        simulation: !native,
        cgroupRoot,
        origin,
        certPath: join(root, "cert"),
        cliConfig,
        issuesPath,
        cliBoundary: boundary,
        projectIds: {
          [localId]: randomUUID(),
          [invalid.localProjectId]: randomUUID(),
        },
      }),
      { mode: 0o600 }
    );
    service = new management.LinuxAgentService(
      unitConfig,
      native
        ? {}
        : {
            runner: fixtureRunner,
            platform: "linux",
            readSelfCgroup: async () => "0::/fixture/agent\n",
          }
    );
    const diagnosis = await service.diagnose();
    if (!diagnosis.supported) {
      console.error(
        `C11 native prerequisite unavailable: ${diagnosis.limitations.join(" ")}`
      );
      process.exitCode = 69;
      return;
    }
    if (probe === "linger") {
      diagnosis.linger = "disabled";
      diagnosis.limitations = [];
    }
    check(
      diagnosis.linger === "enabled" ||
        diagnosis.limitations.some((s) => s.includes("loginctl enable-linger")),
      "CP-23 linger limits explicit"
    );
    await assert.rejects(service.install()); // entry module absent after saved enrollment
    if (probe === "identity")
      await writeFile(registryPath, "forbidden-replacement", { mode: 0o600 });
    check(
      (await readFile(registryPath, "utf8")) === savedRegistry,
      "CP-22 failed install preserves identity"
    );
    await writeFile(
      unitConfig.entryPath,
      `import {agentEntrypoint} from ${JSON.stringify(pathToFileURL(self).href)}; await agentEntrypoint();`
    );
    if (native) {
      const parserPath = join(root, "gh-symphony-agent.service");
      let definition = management.renderLinuxAgentUnit(unitConfig);
      if (probe === "parser")
        definition = definition.replace(
          "WorkingDirectory=/",
          'WorkingDirectory="/"'
        );
      await writeFile(parserPath, definition, { mode: 0o600 });
      const parsed = await execute("/usr/bin/systemd-analyze", [
        "--user",
        "verify",
        parserPath,
      ]);
      check(
        parsed.exitCode === 0,
        "C11 native systemd parser accepts definition"
      );
    }
    await service.install();
    installed = true;
    await until(() => observed, "service first observation");
    savedUnit = await readFile(unitPath, "utf8");
    if (probe === "credential")
      await writeFile(unitPath, savedUnit + identity.credential, {
        mode: 0o600,
      });
    check(
      !(await readFile(unitPath, "utf8")).includes(identity.credential),
      "CP-22 unit excludes credentials"
    );
    await service.install();
    if (probe === "repeat")
      await writeFile(unitPath, savedUnit + "# changed configuration\n", {
        mode: 0o600,
      });
    check(
      (await readFile(unitPath, "utf8")) === savedUnit,
      "CP-22 same install resumes without reenrollment"
    );
    if (probe === "lock") await rm(join(dataDirectory, "agent.lock"));
    let rejected = false;
    try {
      const second = await management.AgentRegistry.open(dataDirectory);
      await second.close();
    } catch {
      rejected = true;
    }
    check(rejected, "CP-23 foreground owner conflict rejected");
    const submit = (localProjectId) => {
      const command = {
        commandId: randomUUID(),
        projectId: randomUUID(),
        environmentId: identity.environmentId,
        localProjectId,
        operation: "start",
        actor: "local-owner",
        idempotencyKey: randomUUID(),
        submittedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      commands.push(command);
      return join(dataDirectory, `fixture-journal-${command.commandId}.json`);
    };
    const result = async (path) =>
      JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
    const invalidJournal = submit(invalid.localProjectId);
    await until(
      async () => (await result(invalidJournal)).state === "failed",
      "invalid project result"
    );
    if (probe === "invalid") {
      const wrong = await result(invalidJournal);
      wrong.diagnostic.code = "forbidden-success";
      await writeFile(invalidJournal, JSON.stringify(wrong));
    }
    check(
      (await result(invalidJournal)).diagnostic.code === "project_invalid",
      "CP-22 invalid prepared workflow rejected"
    );
    const journal = submit(localId);
    await until(
      async () => (await result(journal)).state === "succeeded",
      "remote start result",
      25_000
    );
    const registration = {
      localProjectId: localId,
      canonicalPath: projectFolder,
      registeredPath: projectFolder,
    };
    const stopProject = () =>
      execute(process.execPath, [
        cli,
        "--config",
        cliConfig,
        "--json",
        "project",
        "stop",
        "--project-dir",
        projectFolder,
      ]);
    if (probe === "started") await stopProject();
    const original = await inspectLocalProject(cliConfig, registration);
    check(
      original.process.state === "running",
      "CP-23 remote start uses actual orchestrator"
    );
    if (!native) {
      if (probe === "cleanup-live") unitRecords.delete(liveUnit);
      check(!unitRecords.has(emptyUnit), "C11 empty retained-unit reclamation");
      check(
        unitRecords.has(liveUnit),
        "C11 populated retained-unit preservation"
      );
    }
    const projectEnvironment = JSON.parse(
      await readFile(join(root, "project-environment.json"), "utf8")
    );
    if (probe === "environment")
      projectEnvironment.FORBIDDEN = identity.credential;
    check(
      !JSON.stringify(projectEnvironment).includes(identity.credential) &&
        (native || !projectEnvironment.MANAGER_ONLY),
      "CP-23 project strips inherited credentials"
    );
    const actualGroup = async (pid) =>
      (await readFile(`/proc/${pid}/cgroup`, "utf8"))
        .split("\n")
        .find((s) => s.startsWith("0::"))
        ?.slice(3);
    const groups = native
      ? {
          agent: (
            await execute("/usr/bin/systemctl", [
              "--user",
              "show",
              "gh-symphony-agent.service",
              "--property=ControlGroup",
              "--value",
            ])
          ).stdout.trim(),
          project: await actualGroup(original.process.pid),
        }
      : {
          agent: agentGroup,
          project: [...unitRecords.entries()].find(
            ([unit]) => unit !== emptyUnit && unit !== liveUnit
          )?.[1].ControlGroup,
        };
    if (native)
      fixtureProjectUnit = groups.project
        ?.split("/")
        .find((p) => /^gh-symphony-project-[a-f0-9-]+\.service$/.test(p));
    if (probe === "cgroup") groups.project = groups.agent; // corrupt observed OS evidence
    check(
      groups.project &&
        groups.project !== groups.agent &&
        !groups.project.startsWith(groups.agent + "/"),
      "CP-23 disjoint control group readback"
    );
    const preservedJournal = await readFile(journal, "utf8");
    const continuity = async (label) => {
      const current = await inspectLocalProject(cliConfig, registration);
      check(
        current.process.state === "running" &&
          current.process.pid === original.process.pid &&
          current.process.identity === original.process.identity,
        label
      );
      check(
        (await readFile(registryPath, "utf8")) === savedRegistry &&
          (await readFile(journal, "utf8")) === preservedJournal,
        label + " preserves registry and journal"
      );
    };
    await service.stop();
    if (probe === "stop") await stopProject();
    if (probe === "stop-data")
      await writeFile(journal, "forbidden-journal-change");
    await continuity("CP-23 stop preserves orchestrator");
    observed = false;
    await service.start();
    await until(() => observed, "start reconnect");
    observed = false;
    await service.restart();
    await until(() => observed, "restart reconnect");
    if (probe === "restart") await stopProject();
    if (probe === "restart-data")
      await writeFile(journal, "forbidden-journal-change");
    await continuity("CP-23 restart preserves orchestrator");
    await service.uninstall();
    installed = false;
    if (probe === "uninstall") await stopProject();
    if (probe === "uninstall-data")
      await writeFile(journal, "forbidden-journal-change");
    if (probe === "definition") {
      await writeFile(unitPath, "forbidden-retained-definition", {
        mode: 0o600,
      });
      forbiddenDefinitionCreated = true;
    }
    await continuity("CP-23 uninstall preserves orchestrator");
    check(
      !(await access(unitPath).then(
        () => true,
        () => false
      )),
      "CP-23 uninstall removes definition"
    );
    // Native journal capture is not supplied by the simulated child diagnostics.
    if (!native) {
      if (probe === "diagnostics") diagnostics += identity.credential;
      check(
        !diagnostics.includes(identity.credential),
        "CP-23 simulated diagnostics exclude credentials"
      );
    }
    console.log(
      JSON.stringify({
        result: "pass",
        os: process.platform,
        mode: native ? "native-systemd" : "OS-manager-simulation",
        scope: native
          ? "real user service, C03 CLI daemon, TLS C05 loop and cgroup v2"
          : "real processes/TLS; virtual OS manager/cgroups; no native systemd acceptance",
      })
    );
  } finally {
    await registry?.close();
    if (forbiddenDefinitionCreated) await rm(unitPath, { force: true });
    if (service) {
      if (installed && savedUnit)
        await writeFile(unitPath, savedUnit, { mode: 0o600 });
      await service.uninstall().catch(() => {});
    }
    await stopChild().catch(() => {});
    if (localId)
      await execute(process.execPath, [
        cli,
        "--config",
        cliConfig,
        "--json",
        "project",
        "stop",
        "--project-dir",
        projectFolder,
      ]).catch(() => {});
    if (native && fixtureProjectUnit) {
      // Only this fixture's known unit is touched, and only after explicit project stop.
      const group = (
        await execute("/usr/bin/systemctl", [
          "--user",
          "show",
          fixtureProjectUnit,
          "--property=ControlGroup",
          "--value",
        ])
      ).stdout.trim();
      if (
        group &&
        (
          await readFile(
            join("/sys/fs/cgroup", group, "cgroup.events"),
            "utf8"
          ).catch(() => "")
        ).includes("populated 0")
      )
        await execute("/usr/bin/systemctl", [
          "--user",
          "stop",
          fixtureProjectUnit,
        ]);
    }
    server?.closeAllConnections();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
if (fileURLToPath(import.meta.url) === process.argv[1]) await main();
