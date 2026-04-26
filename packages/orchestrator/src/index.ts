import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  createStore,
  OrchestratorService,
  type OrchestratorLogLevel,
} from "./service.js";
import {
  acquireProjectLock,
  assertValidProjectId,
  releaseProjectLock,
  type ProjectLockHandle,
} from "./lock.js";

export { OrchestratorService, createStore };
export type { OrchestratorLogLevel };
export * from "./runtime-factory.js";
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
  throw new Error(
    `Unsupported log level: ${value}. Supported values: normal, verbose.`
  );
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
        eventsDir?: string;
        stderr: Pick<NodeJS.WriteStream, "write">;
      }
    ) => Promise<OrchestratorService> | OrchestratorService;
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
  const eventsDir = resolveOptionalPath(
    parsed.eventsDir ?? process.env.SYMPHONY_EVENTS_DIR
  );
  const logLevel = resolveOrchestratorLogLevel(
    parsed.logLevel ?? process.env.SYMPHONY_LOG_LEVEL
  );
  const service =
    (await dependencies.createService?.(runtimeRoot, parsed.projectId, {
      eventsDir,
      logLevel,
      stderr,
    })) ??
    (await createServiceForRuntime(runtimeRoot, parsed.projectId, {
      eventsDir,
      logLevel,
      stderr,
    }));
  const stdout = dependencies.stdout ?? process.stdout;
  const exitProcess = dependencies.exitProcess ?? process.exit;
  const signalTarget = dependencies.signalTarget ?? process;

  switch (command) {
    case "run": {
      let lock: ProjectLockHandle | null = null;
      let cleanupPromise: Promise<void> | null = null;
      let shuttingDownForSignal = false;
      const cleanup = async () => {
        if (cleanupPromise) {
          return cleanupPromise;
        }

        cleanupPromise = (async () => {
          let cleanupError: unknown;
          const shutdownPromise = service.shutdown();

          try {
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
    eventsDir?: string;
    logLevel: OrchestratorLogLevel;
    stderr: Pick<NodeJS.WriteStream, "write">;
  }
): Promise<OrchestratorService> {
  if (!projectId) {
    throw new Error("Orchestrator CLI requires --project-id.");
  }

  const store = createStore(runtimeRoot, {
    eventsMirrorRoot: options?.eventsDir,
  });
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
  eventsDir?: string;
  logLevel?: string;
} {
  const parsed: {
    runtimeRoot?: string;
    projectId?: string;
    issueIdentifier?: string;
    eventsDir?: string;
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
      case "--events-dir":
        if (!value || value.startsWith("-")) {
          throw new Error(`Option '${argument}' argument missing`);
        }
        parsed.eventsDir = value;
        index += 1;
        break;
      case "--log-level":
        if (!value || value.startsWith("-")) {
          throw new Error(`Option '${argument}' argument missing`);
        }
        parsed.logLevel = value;
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  return parsed;
}

function resolveOptionalPath(value: string | undefined): string | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  return resolve(value.trim());
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
