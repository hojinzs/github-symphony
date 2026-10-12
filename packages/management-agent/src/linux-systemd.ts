import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export interface SystemdResult {
  exitCode: number | null;
  stdout: string;
}
export interface SystemdCommand {
  executable: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
export type SystemdRunner = (command: SystemdCommand) => Promise<SystemdResult>;

/** No shell, no stderr capture, bounded local-only stdout and observation time. */
export const runSystemd: SystemdRunner = async (command) => {
  absolutePath(command.executable);
  const timeoutMs = Math.min(60_000, Math.max(1, command.timeoutMs ?? 10_000));
  return new Promise((resolve) => {
    let stdout = "";
    let finished = false;
    const child = spawn(command.executable, command.args, {
      shell: false,
      env: command.environment ?? process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      resolve({ exitCode, stdout: exitCode === null ? "" : stdout });
    };
    const expire = () => {
      // Only the local systemd client is terminated. The manager owns service processes.
      child.kill("SIGTERM");
      child.unref();
      finish(null);
    };
    const timer = setTimeout(expire, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 65_536)
        expire();
      else stdout += chunk;
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
};

export function absolutePath(path: string): string {
  if (
    !isAbsolute(path) ||
    Array.from(path).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
    )
  )
    throw new Error(
      "Systemd paths must be absolute and contain no control characters"
    );
  return path;
}
