import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createStore, OrchestratorService } from "./service.js";
import { startOrchestratorStatusServer } from "./status-server.js";

export { OrchestratorService, createStore };
export { startOrchestratorStatusServer };

export async function runCli(
  argv: string[],
  dependencies: {
    stdout?: Pick<NodeJS.WriteStream, "write">;
    stderr?: Pick<NodeJS.WriteStream, "write">;
    createService?: (
      runtimeRoot: string,
      projectId?: string
    ) => Promise<OrchestratorService> | OrchestratorService;
    startStatusServer?: typeof startOrchestratorStatusServer;
  } = {}
): Promise<void> {
  const [command = "run-once", ...args] = argv;
  const parsed = parseArgs(args);
  const runtimeRoot = resolve(parsed.runtimeRoot ?? ".runtime");
  const service =
    (await dependencies.createService?.(runtimeRoot, parsed.projectId)) ??
    (await createServiceForRuntime(runtimeRoot, parsed.projectId));
  const stdout = dependencies.stdout ?? process.stdout;
  void (dependencies.stderr ?? process.stderr);

  switch (command) {
    case "run": {
      if (!parsed.noStatusApi) {
        const statusHost = parsed.statusHost ?? process.env.ORCHESTRATOR_STATUS_HOST ?? "127.0.0.1";
        const statusPort = parsed.statusPort ?? parseInteger(process.env.ORCHESTRATOR_STATUS_PORT, 0) ?? 0;
        const statusServer = (dependencies.startStatusServer ?? startOrchestratorStatusServer)({
          host: statusHost,
          port: statusPort,
          getProjectStatus: () => service.status(),
          onRefresh: async () => {
            await service.runOnce({
              issueIdentifier: parsed.issueIdentifier,
            });
          },
        });
        statusServer.on("listening", () => {
          const addr = statusServer.address();
          if (addr && typeof addr === "object") {
            const host = addr.address === "::" || addr.address === "0.0.0.0" ? "localhost" : addr.address;
            const urlHost = host !== "localhost" && host.includes(":") ? `[${host}]` : host;
            stdout.write(`Status server listening on http://${urlHost}:${addr.port}\n`);
          }
        });
      }
      await service.run({
        issueIdentifier: parsed.issueIdentifier
      });
      return;
    }
    case "run-once":
    case "dispatch": {
      const result = await service.runOnce({
        issueIdentifier: parsed.issueIdentifier
      });
      stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    case "run-issue": {
      if (!parsed.projectId || !parsed.issueIdentifier) {
        throw new Error("run-issue requires --project-id and --issue.");
      }

      const result = await service.runOnce({
        issueIdentifier: parsed.issueIdentifier
      });
      stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    case "recover": {
      const result = await service.recover();
      stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    case "status": {
      const result = await service.status();
      stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

async function createServiceForRuntime(
  runtimeRoot: string,
  projectId?: string
): Promise<OrchestratorService> {
  if (!projectId) {
    throw new Error("Orchestrator CLI requires --project-id.");
  }

  const store = createStore(runtimeRoot);
  const projectConfig = await store.loadProjectConfig(projectId);
  if (!projectConfig) {
    throw new Error(`Project config not found for "${projectId}".`);
  }

  return new OrchestratorService(store, projectConfig);
}

async function main(): Promise<void> {
  await runCli(process.argv.slice(2));
}

function parseArgs(args: string[]): {
  runtimeRoot?: string;
  projectId?: string;
  issueIdentifier?: string;
  statusHost?: string;
  statusPort?: number;
  noStatusApi?: boolean;
} {
  const parsed: {
    runtimeRoot?: string;
    projectId?: string;
    issueIdentifier?: string;
    statusHost?: string;
    statusPort?: number;
    noStatusApi?: boolean;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];

    if (!argument?.startsWith("--")) {
      continue;
    }

    switch (argument) {
      case "--runtime-root":
        parsed.runtimeRoot = value;
        index += 1;
        break;
      case "--project":
      case "--project-id":
        parsed.projectId = value;
        index += 1;
        break;
      case "--issue":
        parsed.issueIdentifier = value;
        index += 1;
        break;
      case "--status-host":
        parsed.statusHost = value;
        index += 1;
        break;
      case "--status-port":
        parsed.statusPort = parseInteger(value, undefined);
        index += 1;
        break;
      case "--no-status-api":
        parsed.noStatusApi = true;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  return parsed;
}

function parseInteger(value: string | undefined, fallback: number | undefined): number | undefined {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected an integer value but received "${value}".`);
  }

  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Unknown error"}\n`);
    process.exitCode = 1;
  });
}
