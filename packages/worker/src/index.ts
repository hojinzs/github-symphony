import {
  launchCodexAppServer,
  prepareCodexRuntimePlan,
} from "@github-symphony/runtime-codex";
import {
  loadLauncherEnvironment,
  resolveLocalRuntimeLaunchConfig,
} from "@github-symphony/runtime-codex";
import {
  buildWorkerRuntimeState,
  startWorkerStateServer,
} from "./state-server.js";

const port = Number(process.env.PORT ?? process.env.SYMPHONY_PORT ?? 4141);
const launcherEnv = loadLauncherEnvironment(process.env);
const runtimeState: {
  status: "idle" | "starting" | "running" | "failed" | "completed";
  run: null | {
    runId: string;
    issueId: string | null;
    issueIdentifier: string | null;
    phase: string | null;
    processId: number | null;
    repository: {
      owner: string | null;
      name: string | null;
      cloneUrl: string | null;
      url: string | null;
    };
    lastError: string | null;
  };
} = {
  status: launcherEnv.SYMPHONY_RUN_ID ? "starting" : "idle",
  run: launcherEnv.SYMPHONY_RUN_ID
    ? {
        runId: launcherEnv.SYMPHONY_RUN_ID,
        issueId: launcherEnv.SYMPHONY_ISSUE_ID ?? null,
        issueIdentifier: launcherEnv.SYMPHONY_ISSUE_IDENTIFIER ?? null,
        phase: launcherEnv.SYMPHONY_RUN_PHASE ?? null,
        processId: null,
        repository: {
          owner: launcherEnv.TARGET_REPOSITORY_OWNER ?? null,
          name: launcherEnv.TARGET_REPOSITORY_NAME ?? null,
          cloneUrl: launcherEnv.TARGET_REPOSITORY_CLONE_URL ?? null,
          url: launcherEnv.TARGET_REPOSITORY_URL ?? null,
        },
        lastError: null,
      }
    : null,
};

const server = startWorkerStateServer({
  port,
  getState: async () =>
    buildWorkerRuntimeState(launcherEnv, undefined, runtimeState),
});

console.log(
  JSON.stringify(
    {
      package: "@github-symphony/worker",
      runtime: "self-hosted-sample",
      port,
    },
    null,
    2
  )
);

let childProcess: ReturnType<typeof launchCodexAppServer> | null = null;

if (launcherEnv.SYMPHONY_RUN_ID && launcherEnv.WORKING_DIRECTORY) {
  void startAssignedRun();
}

function shutdown(signal: NodeJS.Signals) {
  if (childProcess?.pid) {
    try {
      process.kill(childProcess.pid, "SIGTERM");
    } catch {
      // Ignore shutdown races.
    }
  }

  server.close(() => {
    console.log(`Worker state server stopped on ${signal}`);
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function startAssignedRun() {
  try {
    const config = resolveLocalRuntimeLaunchConfig(launcherEnv);
    const plan = await prepareCodexRuntimePlan(config);
    childProcess = launchCodexAppServer(plan);
    runtimeState.status = "running";

    if (runtimeState.run) {
      runtimeState.run.processId = childProcess.pid ?? null;
    }

    childProcess.once("exit", (code, signal) => {
      runtimeState.status = code === 0 && !signal ? "completed" : "failed";

      if (runtimeState.run) {
        runtimeState.run.lastError =
          code === 0 && !signal
            ? null
            : `codex app-server exited with ${signal ?? code ?? "unknown"}`;
      }
    });
    childProcess.once("error", (error) => {
      runtimeState.status = "failed";

      if (runtimeState.run) {
        runtimeState.run.lastError = error.message;
      }
    });
  } catch (error) {
    runtimeState.status = "failed";

    if (runtimeState.run) {
      runtimeState.run.lastError =
        error instanceof Error ? error.message : "Unknown worker startup error";
    }
  }
}
