import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { LIMITS } from "@gh-symphony/management-protocol";

export interface CliInvocation {
  exitCode: number | null;
  outcome?: string;
}
export interface CliProcessOptions {
  executable: string;
  argumentPrefix?: string[];
  environment?: NodeJS.ProcessEnv;
  managementCredentials?: string[];
  timeoutMs?: number;
}
/** Trusted local executable configuration, never fields from a remote command. */
export class CliProcess {
  private readonly environment: NodeJS.ProcessEnv;
  constructor(private options: CliProcessOptions) {
    if (!isAbsolute(options.executable))
      throw new Error("CLI executable must be absolute");
    this.environment = projectEnvironment(
      options.environment ?? process.env,
      options.managementCredentials ?? []
    );
  }
  async run(
    args: string[],
    cwd: string,
    deadline?: number
  ): Promise<CliInvocation> {
    const remaining = Math.min(
      this.options.timeoutMs ?? LIMITS.executionObservationTimeoutMs,
      LIMITS.executionObservationTimeoutMs,
      deadline === undefined ? Infinity : deadline - Date.now()
    );
    if (remaining <= 0) return { exitCode: null };
    return new Promise((resolveResult) => {
      const child = spawn(
        this.options.executable,
        [...(this.options.argumentPrefix ?? []), ...args],
        {
          cwd,
          env: this.environment,
          shell: false,
          stdio: ["ignore", "pipe", "ignore"],
        }
      );
      let output = "";
      let overflow = false;
      let finished = false;
      const finish = (exitCode: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        let outcome: string | undefined;
        try {
          const parsed: unknown = JSON.parse(output);
          if (
            !overflow &&
            parsed &&
            typeof parsed === "object" &&
            "outcome" in parsed &&
            typeof parsed.outcome === "string" &&
            [
              "signal_sent",
              "already_stopped",
              "superseded_target",
              "process_unverified",
            ].includes(parsed.outcome)
          )
            outcome = parsed.outcome;
        } catch {
          /* CLI output is not a process completion proof. */
        }
        resolveResult({ exitCode, ...(outcome ? { outcome } : {}) });
      };
      const timer = setTimeout(() => {
        // Only the CLI invocation receives TERM. Never escalate or signal the
        // orchestrator from this runner; an uncertain effect remains unknown.
        child.kill("SIGTERM");
        child.stdout?.destroy();
        child.unref();
        finish(null);
      }, remaining);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (Buffer.byteLength(output) + Buffer.byteLength(chunk) <= 65_536)
          output += chunk;
        else overflow = true;
      });
      child.on("error", () => finish(null));
      child.on("close", (code) => finish(code));
    });
  }
}

export function projectEnvironment(
  environment: NodeJS.ProcessEnv,
  managementCredentials: readonly string[]
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        !/^(?:GH_SYMPHONY_(?:MANAGEMENT|AGENT|CONTROL_PLANE)_|SYMPHONY_ORCHESTRATOR_)/.test(
          key
        ) &&
        !managementCredentials.some(
          (credential) => credential.length > 0 && value?.includes(credential)
        )
    )
  );
}
