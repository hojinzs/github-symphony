import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import {
  getProcessCwd,
  getProcessIdentity,
  isProcessRunning,
} from "@gh-symphony/orchestrator";
import { daemonPidPath } from "./config.js";

export type ExpectedStopTarget = {
  pid: number;
  processIdentity: string;
};

export type ExpectedStopContext = {
  configDir: string;
  projectId: string;
  projectDir: string;
};

export type ExpectedStopResult =
  | "signal_sent"
  | "already_stopped"
  | "superseded_target"
  | "process_unverified";

// Keep below macOS's Unix socket path limit, even for deeply nested projects.
export function expectedStopSocketPath(context: ExpectedStopContext): string {
  const key = createHash("sha256")
    .update(realpathSync(context.configDir))
    .update("\0")
    .update(context.projectId)
    .digest("hex")
    .slice(0, 32);
  return `/tmp/gh-symphony-stop-${process.getuid?.() ?? "user"}/${key}.sock`;
}

// Strict checks deliberately do not reuse legacy daemon recovery heuristics.
// Reads and the final server-side check are synchronous; no records are removed.
export function inspectExpectedStopTarget(
  context: ExpectedStopContext,
  target: ExpectedStopTarget
): "verified" | Exclude<ExpectedStopResult, "signal_sent"> {
  try {
    const canonicalDir = realpathSync(context.projectDir);
    const paths = [
      daemonPidPath(context.configDir, context.projectId),
      join(context.configDir, "projects", context.projectId, ".lock"),
      join(canonicalDir, ".gh-symphony-start.lock"),
    ];
    let locks = 0;
    for (const [index, path] of paths.entries()) {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return "process_unverified";
      }
      const record = JSON.parse(raw) as {
        pid?: unknown;
        processIdentity?: unknown;
        cwd?: unknown;
      };
      if (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0) {
        return "process_unverified";
      }
      if (record.pid !== target.pid) return "superseded_target";
      if (
        typeof record.processIdentity !== "string" ||
        !record.processIdentity
      ) {
        return "process_unverified";
      }
      if (record.processIdentity !== target.processIdentity) {
        return "superseded_target";
      }
      if (
        typeof record.cwd !== "string" ||
        realpathSync(record.cwd) !== canonicalDir
      ) {
        return "process_unverified";
      }
      if (index > 0) locks += 1;
    }
    const identity = getProcessIdentity(target.pid);
    if (identity && identity !== target.processIdentity) {
      return "superseded_target";
    }
    if (!identity) {
      return !isProcessRunning(target.pid) && locks === 0
        ? "already_stopped"
        : "process_unverified";
    }
    const cwd = getProcessCwd(target.pid);
    if (!cwd || realpathSync(cwd) !== canonicalDir || locks !== 2) {
      return "process_unverified";
    }
    return "verified";
  } catch {
    return "process_unverified";
  }
}

/** Connection-bound shutdown: only the process serving this socket signals
 * itself. PID reuse after the caller's checks cannot redirect a signal to B. */
export async function startExpectedStopServer(
  context: ExpectedStopContext
): Promise<Server> {
  const path = expectedStopSocketPath(context);
  const directory = join(path, "..");
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) {
    throw new Error("Untrusted expected-stop socket directory");
  }
  chmodSync(directory, 0o700);
  // Called only while holding both project start locks, before readiness.
  await rm(path, { force: true });
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    let input = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input) > 16_384) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      handled = true;
      let result: ExpectedStopResult = "process_unverified";
      try {
        const target = JSON.parse(input.trim()) as ExpectedStopTarget;
        if (
          target.pid !== process.pid ||
          target.processIdentity !== getProcessIdentity(process.pid)
        ) {
          result = "superseded_target";
        } else {
          const observation = inspectExpectedStopTarget(context, target);
          if (observation === "verified") {
            // Self-signaling is fenced by the live socket-owning process,
            // rather than a caller's inherently racy kill(arbitraryPid).
            process.kill(process.pid, "SIGTERM");
            result = "signal_sent";
          } else {
            result = observation;
          }
        }
      } catch {
        // Invalid request or missing evidence never triggers shutdown.
      }
      socket.end(`${result}\n`);
    });
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolveListen();
      });
    });
    chmodSync(path, 0o600);
    return server;
  } catch (error) {
    server.close();
    throw error;
  }
}

export async function stopExpectedTarget(
  context: ExpectedStopContext,
  target: ExpectedStopTarget
): Promise<ExpectedStopResult> {
  const observation = inspectExpectedStopTarget(context, target);
  if (observation !== "verified") return observation;
  return new Promise((resolveResult) => {
    const socket = createConnection(expectedStopSocketPath(context));
    const finish = (result: ExpectedStopResult) => {
      socket.destroy();
      resolveResult(result);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => finish("process_unverified"));
    socket.on("error", () => finish("process_unverified"));
    socket.on("connect", () => socket.write(`${JSON.stringify(target)}\n`));
    let response = "";
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > 64) finish("process_unverified");
    });
    socket.on("end", () => {
      const result = response.trim();
      finish(
        result === "signal_sent" ||
          result === "already_stopped" ||
          result === "superseded_target"
          ? result
          : "process_unverified"
      );
    });
  });
}
