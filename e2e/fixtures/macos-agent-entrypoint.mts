/** Independent C05 peer/C06 projection/C08 journal fixture. No public agent CLI is invented. */
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  runForegroundAgent,
  launchMacOSProject,
  type ForegroundOptions,
} from "../../packages/cli/dist/management-agent.js";
import { createLocalManagementAdapter } from "../../packages/cli/dist/management-local.js";
const input: {
  dataDirectory: string;
  configDir: string;
  cli: string;
  issues: string;
  root: string;
  port: number;
} = JSON.parse(await readFile(process.argv[3], "utf8"));
const abort = new AbortController();
process.on("SIGTERM", () => abort.abort());
process.on("SIGINT", () => abort.abort());
let local: ReturnType<typeof createLocalManagementAdapter> | undefined;
let projectId = "";
const aggregateId = randomUUID();
let delivered = false;
const options: ForegroundOptions = {
  onConnection: (state, code) =>
    console.error("Fixture connection", state, code ?? ""),
  directory: input.dataDirectory,
  agentVersion: "1.0.0",
  signal: abort.signal,
  client: (_identity, signal) => ({
    async openSession(request) {
      return {
        protocolVersion: 1,
        environmentId: request.environmentId,
        requestId: request.requestId,
        sessionId: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async observe(request) {
      return {
        protocolVersion: 1,
        environmentId: request.environmentId,
        sessionId: request.sessionId,
        requestId: request.requestId,
        receivedAt: new Date().toISOString(),
      };
    },
    async poll(request) {
      await delay(250, undefined, { signal });
      const commands = delivered
        ? []
        : [
            {
              commandId: randomUUID(),
              projectId: aggregateId,
              environmentId: request.environmentId,
              localProjectId: projectId,
              sessionId: request.sessionId,
              operation: "start" as const,
              actor: "local-owner" as const,
              idempotencyKey: randomUUID(),
              submittedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            },
          ];
      delivered = true;
      return { ...request, commands, reads: [] };
    },
  }),
  async snapshot(registry) {
    local ??= createLocalManagementAdapter(registry, {
      executable: process.execPath,
      argumentPrefix: [input.cli],
      configDir: input.configDir,
      environment: {
        ...process.env,
        GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH: input.issues,
        GH_SYMPHONY_HTTP_TOKEN: "c12-http-fixture",
      },
      launchContext: {
        kind: "native-service",
        launchIsolatedProject: (request) =>
          launchMacOSProject({
            ...request,
            args: [...request.args, "--http", String(input.port)],
          }),
      },
    });
    projectId = registry.list()[0].localProjectId;
    return (await registry.inventory(local.reader, "1.0.0")).map((project) => ({
      ...project,
      projectId: aggregateId,
    }));
  },
  async handlePoll(response) {
    for (const command of response.commands) {
      const result = await local!.adapter.start(command.localProjectId);
      console.error("Fixture lifecycle", result.state, result.diagnostic?.code);
      if (result.state !== "succeeded")
        throw new Error("Fixture project start failed");
      await writeFile(
        join(input.root, "started.json"),
        JSON.stringify({ agentPid: process.pid, process: result.process })
      );
    }
  },
};
await runForegroundAgent(options);
