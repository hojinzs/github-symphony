import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AgentRegistry,
  agentServerOrigin,
  createAgentTransport,
  setupAgent,
} from "@gh-symphony/management-agent";
import type { CommandHandler } from "../index.js";
import { defaultAgentConfigPath, loadAgentConfig } from "../agent-config.js";
import { readEnrollmentToken } from "../agent-input.js";
import { createNativeAgentService } from "../agent-service.js";
import { runAgentRuntime } from "../agent-runtime.js";

const handler: CommandHandler = async (args, options) => {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const command = args[0];
  const configPath = resolve(
    value("--agent-config") ?? defaultAgentConfigPath()
  );
  // Validate the server before creating any local configuration or prompting.
  const serverOrigin =
    command === "setup" || command === "enroll"
      ? agentServerOrigin(value("--server") ?? "")
      : undefined;
  const config = await loadAgentConfig(
    configPath,
    serverOrigin
      ? {
          projectConfigDir: options.configDir,
          cliPath: process.argv[1]!,
        }
      : undefined
  );
  const print = (result: unknown) =>
    process.stdout.write(
      JSON.stringify(result, null, options.json ? 2 : undefined) + "\n"
    );
  if (serverOrigin) {
    const ca = config.caFile ? await readFile(config.caFile) : undefined;
    await setupAgent({
      directory: config.dataDirectory,
      serverOrigin,
      client: createAgentTransport({ serverOrigin, identity: () => null, ca }),
      readToken: () => readEnrollmentToken(args.includes("--token-stdin")),
      service:
        command === "setup"
          ? createNativeAgentService(config, configPath)
          : undefined,
      report: (stage, limitations) =>
        print({ stage, ...(limitations ? { limitations } : {}) }),
    });
    print({
      message:
        command === "setup"
          ? "Agent service started; verify first authenticated signal in the Control Plane."
          : "Enrollment saved. Use agent service install/start or agent run.",
    });
    return;
  }
  if (command === "service") {
    const service = createNativeAgentService(config, configPath);
    const verb = args[1];
    if (verb === "install") {
      const registry = await AgentRegistry.open(config.dataDirectory);
      try {
        if (!registry.identity)
          throw new Error("Enroll this agent before service installation");
        print({ limitations: await service.check() });
        await service.install();
      } finally {
        await registry.close();
      }
      print({
        installed: true,
        message: "Service installed. Run agent service start to start it.",
      });
    } else if (verb === "status") print(await service.status());
    else if (
      verb === "start" ||
      verb === "stop" ||
      verb === "restart" ||
      verb === "uninstall"
    ) {
      await service[verb]();
      print({
        service: verb,
        preserved: "identity, project registrations and journal",
      });
    }
    return;
  }
  if (command === "project") {
    const registry = await AgentRegistry.open(config.dataDirectory);
    try {
      if (args[1] === "add") print(await registry.add(args[2]!));
      else if (args[1] === "list") print(registry.list());
      else if (args[1] === "remove") {
        if (
          !registry.list().some((project) => project.localProjectId === args[2])
        )
          throw new Error("project_unmanaged");
        await registry.remove(args[2]!);
        print({ removed: args[2], process: "unaffected" });
      }
    } finally {
      await registry.close();
    }
    return;
  }
  if (command === "run") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      await runAgentRuntime(config, {
        signal: controller.signal,
        report: (state, code) => print({ state, code }),
      });
    } finally {
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
    }
  }
};
export default handler;
