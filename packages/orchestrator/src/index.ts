import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createStore, OrchestratorService } from "./service.js";
import { startOrchestratorStatusServer } from "./status-server.js";

export async function runCli(
  argv: string[],
  dependencies: {
    stdout?: Pick<NodeJS.WriteStream, "write">;
    stderr?: Pick<NodeJS.WriteStream, "write">;
    createService?: (runtimeRoot: string) => OrchestratorService;
    startStatusServer?: typeof startOrchestratorStatusServer;
  } = {}
): Promise<void> {
  const [command = "run-once", ...args] = argv;
  const parsed = parseArgs(args);
  const runtimeRoot = resolve(parsed.runtimeRoot ?? ".runtime");
  const service =
    dependencies.createService?.(runtimeRoot) ??
    new OrchestratorService(createStore(runtimeRoot));
  const stdout = dependencies.stdout ?? process.stdout;
  void (dependencies.stderr ?? process.stderr);

  switch (command) {
    case "run": {
      const statusHost = parsed.statusHost ?? process.env.ORCHESTRATOR_STATUS_HOST ?? "127.0.0.1";
      const statusPort = parsed.statusPort ?? parseInteger(process.env.ORCHESTRATOR_STATUS_PORT, 4680) ?? 4680;
      (dependencies.startStatusServer ?? startOrchestratorStatusServer)({
        host: statusHost,
        port: statusPort,
        getWorkspaceStatus: {
          all: () => service.status(),
          byWorkspaceId: async (workspaceId) => {
            const [snapshot] = await service.status(workspaceId);
            return snapshot ?? null;
          }
        }
      });
      await service.run({
        workspaceId: parsed.workspaceId,
        issueIdentifier: parsed.issueIdentifier
      });
      return;
    }
    case "run-once":
    case "dispatch": {
      const result = await service.runOnce({
        workspaceId: parsed.workspaceId,
        issueIdentifier: parsed.issueIdentifier
      });
      stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    case "run-issue": {
      if (!parsed.workspaceId || !parsed.issueIdentifier) {
        throw new Error("run-issue requires --workspace-id and --issue.");
      }

      const result = await service.runOnce({
        workspaceId: parsed.workspaceId,
        issueIdentifier: parsed.issueIdentifier
      });
      stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    case "recover": {
      const result = await service.recover(parsed.workspaceId);
      stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    case "status": {
      const result = await service.status(parsed.workspaceId);
      stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

async function main(): Promise<void> {
  await runCli(process.argv.slice(2));
}

function parseArgs(args: string[]): {
  runtimeRoot?: string;
  workspaceId?: string;
  issueIdentifier?: string;
  statusHost?: string;
  statusPort?: number;
} {
  const parsed: {
    runtimeRoot?: string;
    workspaceId?: string;
    issueIdentifier?: string;
    statusHost?: string;
    statusPort?: number;
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
      case "--workspace":
      case "--workspace-id":
        parsed.workspaceId = value;
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
