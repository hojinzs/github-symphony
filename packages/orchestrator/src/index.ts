import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Server } from "node:http";
import {
  createStore,
  OrchestratorService,
  type OrchestratorLogLevel,
} from "./service.js";
import { startOrchestratorStatusServer } from "./status-server.js";
import {
  acquireProjectLock,
  assertValidProjectId,
  releaseProjectLock,
  type ProjectLockHandle,
} from "./lock.js";

export { OrchestratorService, createStore };
export type { OrchestratorLogLevel };
export { startOrchestratorStatusServer };
export {
  acquireProjectLock,
  assertValidProjectId,
  releaseProjectLock,
  type ProjectLockHandle,
};

export function resolveOrchestratorLogLevel(
  value: string | null | undefined
): OrchestratorLogLevel {
  if (!value || value === "normal") {
    return "normal";
  }
  if (value === "verbose") {
    return "verbose";
  }
  throw new Error(`Unsupported log level: ${value}`);
}

export async function runCli(
  argv: string[],
  dependencies: {
    stdout?: Pick<NodeJS.WriteStream, "write">;
    stderr?: Pick<NodeJS.WriteStream, "write">;
    createService?: (
      runtimeRoot: string,
      projectId?: string,
      options?: {
        logLevel: OrchestratorLogLevel;
        stderr: Pick<NodeJS.WriteStream, "write">;
      }
    ) => Promise<OrchestratorService> | OrchestratorService;
    startStatusServer?: typeof startOrchestratorStatusServer;
    acquireLock?: typeof acquireProjectLock;
    releaseLock?: typeof releaseProjectLock;
    exitProcess?: (code: number) => void;
    signalTarget?: Pick<NodeJS.Process, "once" | "off">;
  } = {}
): Promise<void> {
  const [command = "run-once", ...args] = argv;
  const parsed = parseArgs(args);
  if (parsed.projectId) {
    assertValidProjectId(parsed.projectId);
  }
  const runtimeRoot = resolve(parsed.runtimeRoot ?? ".runtime");
  const stderr = dependencies.stderr ?? process.stderr;
  const logLevel = resolveOrchestratorLogLevel(
    parsed.logLevel ?? process.env.SYMPHONY_LOG_LEVEL
  );
  const service =
    (await dependencies.createService?.(runtimeRoot, parsed.projectId, {
      logLevel,
      stderr,
    })) ??
    (await createServiceForRuntime(runtimeRoot, parsed.projectId, {
      logLevel,
      stderr,
    }));
  const stdout = dependencies.stdout ?? process.stdout;
  const exitProcess = dependencies.exitProcess ?? process.exit;
  const signalTarget = dependencies.signalTarget ?? process;

  switch (command) {
    case "run": {
      let lock: ProjectLockHandle | null = null;
      let statusServer: Server | null = null;
      let cleanupPromise: Promise<void> | null = null;
      let shuttingDownForSignal = false;
      const closeStatusServer = async () => {
        if (!statusServer) {
          return;
        }

        const serverToClose = statusServer;
        statusServer = null;
        await new Promise<void>((resolveClose, rejectClose) => {
          serverToClose.close((error) => {
            if (error) {
              rejectClose(error);
              return;
            }
            resolveClose();
          });
        });
      };
      const cleanup = async () => {
        if (cleanupPromise) {
          return cleanupPromise;
        }

        cleanupPromise = (async () => {
          let cleanupError: unknown;
          const shutdownPromise = service.shutdown();

          try {
            await closeStatusServer();
            await shutdownPromise;
          } catch (error) {
            cleanupError = error;
          } finally {
            try {
              await (dependencies.releaseLock ?? releaseProjectLock)(lock);
              lock = null;
            } catch (lockError) {
              cleanupError ??= lockError;
            }
          }

          if (cleanupError) {
            throw cleanupError;
          }
        })();

        return cleanupPromise;
      };
      const handleSignal = (signal: NodeJS.Signals) => {
        shuttingDownForSignal = true;
        let exitCode = 0;
        void cleanup()
          .catch((error) => {
            exitCode = 1;
            stderr.write(
              `Failed to shut down orchestrator after ${signal}: ${error instanceof Error ? error.message : String(error)}\n`
            );
          })
          .finally(() => {
            exitProcess(exitCode);
          });
      };
      const sigintHandler = () => handleSignal("SIGINT");
      const sigtermHandler = () => handleSignal("SIGTERM");
      try {
        if (parsed.projectId) {
          lock = await (dependencies.acquireLock ?? acquireProjectLock)({
            runtimeRoot,
            projectId: parsed.projectId,
          });
        }

        signalTarget.once("SIGINT", sigintHandler);
        signalTarget.once("SIGTERM", sigtermHandler);

        if (!parsed.noStatusApi) {
          const statusHost =
            parsed.statusHost ??
            process.env.ORCHESTRATOR_STATUS_HOST ??
            "127.0.0.1";
          const statusPort =
            parsed.statusPort ??
            parseInteger(process.env.ORCHESTRATOR_STATUS_PORT, 0) ??
            0;
          const server = (
            dependencies.startStatusServer ?? startOrchestratorStatusServer
          )({
            host: statusHost,
            port: statusPort,
            getProjectStatus: () => service.status(),
            getIssueStatus: (issueIdentifier) =>
              service.statusForIssue(issueIdentifier),
            onRefresh: async () => {
              await service.runOnce({
                issueIdentifier: parsed.issueIdentifier,
              });
            },
          });
          statusServer = server;
          server.on("listening", () => {
            const addr = server.address();
            if (addr && typeof addr === "object") {
              const host =
                addr.address === "::" || addr.address === "0.0.0.0"
                  ? "localhost"
                  : addr.address;
              const urlHost =
                host !== "localhost" && host.includes(":") ? `[${host}]` : host;
              stdout.write(
                `Status server listening on http://${urlHost}:${addr.port}\n`
              );
            }
          });
        }
        await service.run({
          issueIdentifier: parsed.issueIdentifier,
        });
        await cleanup();
      } finally {
        signalTarget.off("SIGINT", sigintHandler);
        signalTarget.off("SIGTERM", sigtermHandler);
        if (!shuttingDownForSignal) {
          await cleanup();
        }
      }
      return;
    }
    case "run-once":
    case "dispatch": {
      const result = await service.runOnce({
        issueIdentifier: parsed.issueIdentifier,
      });
      stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    case "run-issue": {
      if (!parsed.projectId || !parsed.issueIdentifier) {
        throw new Error("run-issue requires --project-id and --issue.");
      }

      const result = await service.runOnce({
        issueIdentifier: parsed.issueIdentifier,
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
  projectId?: string,
  options?: {
    logLevel: OrchestratorLogLevel;
    stderr: Pick<NodeJS.WriteStream, "write">;
  }
): Promise<OrchestratorService> {
  if (!projectId) {
    throw new Error("Orchestrator CLI requires --project-id.");
  }

  const store = createStore(runtimeRoot);
  const projectConfig = await store.loadProjectConfig(projectId);
  if (!projectConfig) {
    throw new Error(`Project config not found for "${projectId}".`);
  }

  return new OrchestratorService(store, projectConfig, options);
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
  logLevel?: string;
} {
  const parsed: {
    runtimeRoot?: string;
    projectId?: string;
    issueIdentifier?: string;
    statusHost?: string;
    statusPort?: number;
    noStatusApi?: boolean;
    logLevel?: string;
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
      case "--log-level":
        parsed.logLevel = value;
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  return parsed;
}

function parseInteger(
  value: string | undefined,
  fallback: number | undefined
): number | undefined {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected an integer value but received "${value}".`);
  }

  return parsed;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Unknown error"}\n`
    );
    process.exitCode = 1;
  });
}
