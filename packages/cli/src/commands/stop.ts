import { readFile, rm } from "node:fs/promises";
import type { GlobalOptions } from "../index.js";
import { daemonPidPath } from "../config.js";

function parseStopArgs(args: string[]): { force: boolean } {
  return { force: args.includes("--force") };
}

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const { force } = parseStopArgs(args);
  const pidPath = daemonPidPath(options.configDir);

  let pidStr: string;
  try {
    pidStr = await readFile(pidPath, "utf8");
  } catch {
    process.stderr.write("No running daemon found (PID file missing).\n");
    process.exitCode = 1;
    return;
  }

  const pid = Number.parseInt(pidStr.trim(), 10);
  if (!Number.isFinite(pid)) {
    process.stderr.write(`Invalid PID in ${pidPath}: ${pidStr}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    // Check if process is running
    process.kill(pid, 0);
  } catch {
    process.stdout.write(
      `Daemon (PID ${pid}) is not running. Cleaning up PID file.\n`
    );
    await rm(pidPath, { force: true });
    return;
  }

  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(pid, signal);
    process.stdout.write(`Sent ${signal} to orchestrator (PID ${pid}).\n`);
  } catch (error) {
    process.stderr.write(
      `Failed to stop process ${pid}: ${error instanceof Error ? error.message : "Unknown error"}\n`
    );
    process.exitCode = 1;
    return;
  }

  await rm(pidPath, { force: true });
  process.stdout.write("Daemon stopped.\n");
};

export default handler;
