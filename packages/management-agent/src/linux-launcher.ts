import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { projectEnvironment } from "./cli-process.js";
import { LINUX_AGENT_UNIT } from "./linux-service.js";
import {
  absolutePath,
  runSystemd,
  type SystemdRunner,
  type SystemdResult,
} from "./linux-systemd.js";

/** Structurally implements the C03 IsolatedProjectLaunch contract without a CLI dependency. */
export interface LinuxProjectLaunchRequest {
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  deadline: number;
}
export interface LinuxProjectLauncherOptions {
  managementCredentials: readonly string[];
  runner?: SystemdRunner;
  systemctlPath?: string;
  systemdRunPath?: string;
  currentControlGroup?: () => Promise<string>;
}
function properties(result: SystemdResult): Map<string, string> {
  if (result.exitCode !== 0) throw new Error("systemd observation unavailable");
  return new Map(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}
function group(value: string | undefined): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value === "/" ||
    Array.from(value).some(
      (c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127
    ) ||
    value.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("Control group identity unavailable");
  return value.replace(/\/$/, "");
}
async function currentGroup(): Promise<string> {
  const lines = (await readFile("/proc/self/cgroup", "utf8")).split("\n");
  // v2 required: a single unified hierarchy supplies unambiguous ownership evidence.
  return group(lines.find((line) => line.startsWith("0::"))?.slice(3));
}
export function createLinuxProjectLaunchContext(
  options: LinuxProjectLauncherOptions
): {
  kind: "native-service";
  launchIsolatedProject: (
    request: LinuxProjectLaunchRequest
  ) => Promise<{ exitCode: number | null }>;
} {
  const runner = options.runner ?? runSystemd;
  const systemctl = absolutePath(options.systemctlPath ?? "/usr/bin/systemctl");
  const systemdRun = absolutePath(
    options.systemdRunPath ?? "/usr/bin/systemd-run"
  );
  const credentials = [...options.managementCredentials];
  return {
    kind: "native-service",
    launchIsolatedProject: async (request) => {
      try {
        absolutePath(request.executable);
        absolutePath(request.cwd);
        if (
          !Number.isFinite(request.deadline) ||
          request.deadline <= Date.now()
        )
          return { exitCode: null };
        const invoke = async (
          executable: string,
          args: string[],
          environment?: NodeJS.ProcessEnv
        ) => {
          const timeoutMs = Math.min(60_000, request.deadline - Date.now());
          if (timeoutMs <= 0) throw new Error("Launch deadline expired");
          return runner({ executable, args, environment, timeoutMs });
        };
        const version = await invoke(systemdRun, ["--version"]);
        if (
          version.exitCode !== 0 ||
          Number(/^systemd (\d+)/.exec(version.stdout)?.[1] ?? 0) < 254
        )
          return { exitCode: null };
        const agent = properties(
          await invoke(systemctl, [
            "--user",
            "show",
            LINUX_AGENT_UNIT,
            "--property=ActiveState",
            "--property=ControlGroup",
          ])
        );
        const agentGroup = group(agent.get("ControlGroup"));
        const ownGroup = group(
          await (options.currentControlGroup ?? currentGroup)()
        );
        if (
          agent.get("ActiveState") !== "active" ||
          (ownGroup !== agentGroup && !ownGroup.startsWith(`${agentGroup}/`))
        )
          return { exitCode: null };
        const environment = projectEnvironment(
          request.environment,
          credentials
        );
        for (const name of [
          "INVOCATION_ID",
          "JOURNAL_STREAM",
          "NOTIFY_SOCKET",
          "SYSTEMD_EXEC_PID",
        ])
          delete environment[name];
        const names = Object.keys(environment).filter(
          (name) =>
            /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
            environment[name] !== undefined
        );
        // User managers inherit their own environment. Remove anything not explicitly
        // supplied by the sanitized local project context, including credential aliases.
        const managerEnvironment = await invoke(systemctl, [
          "--user",
          "show-environment",
        ]);
        if (managerEnvironment.exitCode !== 0) return { exitCode: null };
        const unset = managerEnvironment.stdout
          .split("\n")
          .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1])
          .filter((name): name is string => !!name && !names.includes(name));
        const unit = `gh-symphony-project-${randomUUID()}.service`;
        const submitted = await invoke(
          systemdRun,
          [
            "--user",
            "--quiet",
            `--unit=${unit}`,
            "--service-type=oneshot",
            "--remain-after-exit",
            "--expand-environment=no",
            "--property=KillMode=control-group",
            "--property=StandardInput=null",
            "--property=StandardOutput=journal",
            "--property=StandardError=journal",
            `--property=TimeoutStartSec=${Math.max(1, Math.ceil((request.deadline - Date.now()) / 1000))}s`,
            `--working-directory=${request.cwd}`,
            ...(unset.length
              ? [`--property=UnsetEnvironment=${unset.join(" ")}`]
              : []),
            ...names.map((name) => `--setenv=${name}`),
            "--",
            request.executable,
            ...request.args,
          ],
          environment
        );
        if (submitted.exitCode !== 0) return { exitCode: null };
        const project = properties(
          await invoke(systemctl, [
            "--user",
            "show",
            unit,
            "--property=ActiveState",
            "--property=SubState",
            "--property=ControlGroup",
            "--property=ExecMainCode",
            "--property=ExecMainStatus",
          ])
        );
        const projectGroup = group(project.get("ControlGroup"));
        if (
          projectGroup === agentGroup ||
          projectGroup.startsWith(`${agentGroup}/`) ||
          agentGroup.startsWith(`${projectGroup}/`)
        )
          return { exitCode: null };
        if (
          project.get("ActiveState") !== "active" ||
          project.get("SubState") !== "exited" ||
          project.get("ExecMainCode") !== "1" ||
          project.get("ExecMainStatus") !== "0"
        )
          return { exitCode: null };
        return { exitCode: 0 };
      } catch {
        // OS diagnostics remain local; uncertainty must never authorize automatic replay.
        return { exitCode: null };
      }
    },
  };
}
