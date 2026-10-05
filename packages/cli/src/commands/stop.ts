import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { getProcessCwd, getProcessIdentity } from "@gh-symphony/orchestrator";
import type { GlobalOptions } from "../index.js";
import {
  handleMissingManagedProjectConfig,
  resolveManagedProjectConfig,
} from "../project-selection.js";
import { rejectRemovedProjectId } from "../removed-project-id.js";
import { resolveDaemonLiveness } from "../daemon-liveness.js";
import {
  stopExpectedTarget,
  type ExpectedStopTarget,
} from "../expected-stop.js";

function parseStopArgs(args: string[]): {
  force: boolean;
  expectedTarget?: ExpectedStopTarget;
  error?: string;
} {
  const parsed: {
    force: boolean;
    expectedTarget?: ExpectedStopTarget;
    error?: string;
  } = {
    force: false,
  };
  let expectedPid: number | undefined;
  let expectedIdentity: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--expected-pid" || arg === "--expected-process-identity") {
      const value = args[++i];
      if (!value || value.startsWith("--")) {
        parsed.error = `Missing value for '${arg}'`;
        return parsed;
      }
      if (arg === "--expected-pid") {
        if (
          expectedPid !== undefined ||
          !/^[1-9]\d*$/.test(value) ||
          !Number.isSafeInteger(Number(value))
        ) {
          parsed.error =
            "--expected-pid must be supplied once with a positive safe integer";
          return parsed;
        }
        expectedPid = Number(value);
      } else {
        if (
          expectedIdentity !== undefined ||
          !value.trim() ||
          Buffer.byteLength(value) > 8_192
        ) {
          parsed.error =
            "--expected-process-identity must be supplied once with a non-empty identity (at most 8192 bytes)";
          return parsed;
        }
        expectedIdentity = value;
      }
      continue;
    }
    if (arg === "--force") {
      parsed.force = true;
      continue;
    }
    if (arg?.startsWith("-")) {
      parsed.error = `Unknown option '${arg}'`;
      return parsed;
    }
  }

  if ((expectedPid === undefined) !== (expectedIdentity === undefined)) {
    parsed.error =
      "--expected-pid and --expected-process-identity must be supplied together";
  } else if (expectedPid !== undefined && expectedIdentity !== undefined) {
    if (parsed.force) {
      parsed.error = "--force cannot be combined with an expected target";
    } else {
      parsed.expectedTarget = {
        pid: expectedPid,
        processIdentity: expectedIdentity,
      };
    }
  }
  return parsed;
}

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  if (rejectRemovedProjectId(args)) {
    return;
  }
  const parsed = parseStopArgs(args);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    process.stderr.write(
      `Usage: gh-symphony ${options.invocation === "project" ? "project" : "repo"} stop [--force]\nExpected-target mode: --expected-pid <pid> --expected-process-identity <identity> (without --force)\n`
    );
    process.exitCode = 2;
    return;
  }
  const resolvedForce = parsed.force;
  const projectConfig = await resolveManagedProjectConfig({
    configDir: options.configDir,
    requestedProjectId: options.projectId,
  });
  if (!projectConfig) {
    handleMissingManagedProjectConfig();
    return;
  }
  const resolvedProjectId = projectConfig.projectId;

  if (parsed.expectedTarget) {
    const result = await stopExpectedTarget(
      {
        configDir: options.configDir,
        projectId: options.projectId ?? resolvedProjectId,
        projectDir:
          options.requestedProjectDir ??
          projectConfig.projectDir ??
          projectConfig.workspaceDir,
      },
      parsed.expectedTarget
    );
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ outcome: result, pid: parsed.expectedTarget.pid })}\n`
      );
    } else {
      process.stdout.write(
        `${result}: expected orchestrator PID ${parsed.expectedTarget.pid}.\n`
      );
    }
    if (result === "superseded_target" || result === "process_unverified")
      process.exitCode = 1;
    return;
  }

  const liveness = await resolveDaemonLiveness({
    configDir: options.configDir,
    projectId: resolvedProjectId,
    workspaceDir: projectConfig.workspaceDir,
  });
  if (!liveness.running && liveness.reason === "missing-pid") {
    process.stderr.write(
      `No running daemon found for project "${resolvedProjectId}" (PID file missing).\n`
    );
    process.exitCode = 1;
    return;
  }
  if (!liveness.running && liveness.reason === "invalid-pid") {
    process.stderr.write(
      `Invalid PID in ${liveness.pidPath}: ${liveness.pidContents ?? ""}\n`
    );
    process.exitCode = 1;
    return;
  }
  if (!liveness.running) {
    process.stderr.write(
      `Stale daemon PID ${liveness.recordedPid} for project "${resolvedProjectId}"; no live orchestrator with repository CWD "${liveness.expectedCwd}" was found in the project lock. Cleaning up stale PID file.\n`
    );
    await rm(liveness.pidPath, { force: true });
    process.exitCode = 1;
    return;
  }
  if (liveness.source === "project-lock") {
    process.stdout.write(
      `Recovered orchestrator PID ${liveness.target.pid} from the project lock for repository CWD "${liveness.expectedCwd}".\n`
    );
  }

  const { pid, identity: checkedIdentity } = liveness.target;

  if (!liveness.target.verified) {
    process.stderr.write(
      `Refusing to signal PID ${pid}: process identity could not be verified.\n`
    );
    process.exitCode = 1;
    return;
  }

  const signal = resolvedForce ? "SIGKILL" : "SIGTERM";
  try {
    const signalCwd = getProcessCwd(pid);
    if (
      getProcessIdentity(pid) !== checkedIdentity ||
      !signalCwd ||
      resolve(signalCwd) !== liveness.expectedCwd
    ) {
      throw new Error("process identity changed before signal delivery");
    }
    process.kill(pid, signal);
    process.stdout.write(`Sent ${signal} to orchestrator (PID ${pid}).\n`);
  } catch (error) {
    process.stderr.write(
      `Failed to stop process ${pid}: ${error instanceof Error ? error.message : "Unknown error"}\n`
    );
    process.exitCode = 1;
    return;
  }

  await rm(liveness.pidPath, { force: true });
  process.stdout.write("Daemon stopped.\n");
};

export default handler;
