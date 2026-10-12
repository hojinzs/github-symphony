import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import {
  absolutePath,
  runSystemd,
  type SystemdRunner,
} from "./linux-systemd.js";

export const LINUX_AGENT_UNIT = "gh-symphony-agent.service";
/** Trusted local composition. entryPath must implement the documented C13 argument contract. */
export interface LinuxServiceConfig {
  homeDirectory: string;
  nodePath: string;
  entryPath: string;
  configPath: string;
  dataDirectory: string;
}
export interface LinuxServiceOptions {
  runner?: SystemdRunner;
  systemctlPath?: string;
  loginctlPath?: string;
  /** OS-command fixture seam; production defaults to the actual host. */
  platform?: string;
  /** OS-file fixture seam; production reads the actual unified hierarchy. */
  readSelfCgroup?: () => Promise<string>;
}
export interface LinuxServiceDiagnosis {
  supported: boolean;
  linger: "enabled" | "disabled" | "unknown";
  limitations: string[];
}
function quoted(value: string): string {
  absolutePath(value);
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}
export function renderLinuxAgentUnit(config: LinuxServiceConfig): string {
  for (const value of [
    config.nodePath,
    config.entryPath,
    config.configPath,
    config.dataDirectory,
  ])
    absolutePath(value);
  const arguments_ = [
    quoted(config.nodePath),
    quoted(config.entryPath),
    '"--config"',
    quoted(config.configPath),
    '"--data-dir"',
    quoted(config.dataDirectory),
    '"--native-service=linux"',
  ];
  // ':' suppresses ExecStart environment substitution; %% preserves literal specifiers.
  return `[Unit]\nDescription=GitHub Symphony management agent\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=exec\nExecStart=:${arguments_.join(" ")}\nWorkingDirectory=/\nRestart=on-failure\nRestartSec=5s\nTimeoutStopSec=15s\nKillMode=control-group\nUMask=0077\nStandardInput=null\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n`;
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function vendorDropIns(value: string | undefined): boolean {
  if (value === undefined) return false;
  // Only OS-vendor type defaults are trusted; user and unit-specific overrides
  // remain configuration conflicts. Reject escaping/ambiguous path encodings.
  return (
    value === "" ||
    value
      .split(" ")
      .every((path) =>
        /^\/(?:usr\/lib|lib)\/systemd\/user\/service\.d\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.conf$/.test(
          path
        )
      )
  );
}
async function safeDirectory(path: string, create = false): Promise<void> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o022) !== 0
  )
    throw new Error(
      "Unsafe service directory: requires a private user-owned directory"
    );
}

export class LinuxAgentService {
  readonly unitPath: string;
  private readonly runner: SystemdRunner;
  private readonly systemctl: string;
  private readonly loginctl: string;
  private readonly os: string;
  private readonly unit: string;
  private readonly readSelfCgroup: () => Promise<string>;
  constructor(
    readonly config: LinuxServiceConfig,
    options: LinuxServiceOptions = {}
  ) {
    this.config = { ...config };
    absolutePath(this.config.homeDirectory);
    this.unit = renderLinuxAgentUnit(this.config);
    this.unitPath = join(
      config.homeDirectory,
      ".config/systemd/user",
      LINUX_AGENT_UNIT
    );
    this.runner = options.runner ?? runSystemd;
    this.systemctl = absolutePath(
      options.systemctlPath ?? "/usr/bin/systemctl"
    );
    this.loginctl = absolutePath(options.loginctlPath ?? "/usr/bin/loginctl");
    this.os = options.platform ?? platform();
    this.readSelfCgroup =
      options.readSelfCgroup ?? (() => readFile("/proc/self/cgroup", "utf8"));
  }
  async diagnose(): Promise<LinuxServiceDiagnosis> {
    const unsupported: LinuxServiceDiagnosis = {
      supported: false,
      linger: "unknown",
      limitations: [
        "Linux systemd user manager unavailable; use the foreground agent entrypoint.",
      ],
    };
    if (this.os !== "linux") return unsupported;
    const version = await this.runner({
      executable: this.systemctl,
      args: ["--version"],
    });
    // The launcher disables command argument expansion through systemd-run 254+.
    if (
      version.exitCode !== 0 ||
      Number(/^systemd (\d+)/.exec(version.stdout)?.[1] ?? 0) < 254
    )
      return {
        ...unsupported,
        limitations: [
          "systemd 254 or newer is required for isolated project launch; use foreground mode.",
        ],
      };
    const manager = await this.runner({
      executable: this.systemctl,
      args: ["--user", "show", "--property=Version", "--value"],
    });
    if (manager.exitCode !== 0) return unsupported;
    const environment = await this.runner({
      executable: this.systemctl,
      args: ["--user", "show-environment", "--output=json"],
    });
    if (environment.exitCode !== 0) return unsupported;
    let xdg: string | undefined;
    try {
      const values: unknown = JSON.parse(environment.stdout);
      if (
        values !== null &&
        (typeof values !== "object" || Array.isArray(values))
      )
        return unsupported;
      const value = (values as Record<string, unknown> | null)?.XDG_CONFIG_HOME;
      if (value !== undefined && typeof value !== "string") return unsupported;
      xdg = value;
    } catch {
      return unsupported;
    }
    if (xdg && xdg !== join(this.config.homeDirectory, ".config"))
      return {
        ...unsupported,
        limitations: [
          "Non-default manager XDG_CONFIG_HOME is unsupported; use foreground mode or configure the manager with the default user configuration directory.",
        ],
      };
    try {
      const lines = (await this.readSelfCgroup()).trim().split("\n");
      if (lines.length !== 1 || !/^0::\//.test(lines[0]!))
        throw new Error("Unified hierarchy unavailable");
    } catch {
      return {
        ...unsupported,
        limitations: [
          "Unified cgroup v2 is required for isolated project launch; use foreground mode.",
        ],
      };
    }
    const result = await this.runner({
      executable: this.loginctl,
      args: [
        "show-user",
        String(process.getuid?.()),
        "--property=Linger",
        "--value",
      ],
    });
    const linger =
      result.exitCode === 0 && result.stdout.trim() === "yes"
        ? "enabled"
        : result.exitCode === 0 && result.stdout.trim() === "no"
          ? "disabled"
          : "unknown";
    return {
      supported: true,
      linger,
      limitations:
        linger === "enabled"
          ? []
          : [
              `${linger === "disabled" ? "Linger is disabled" : "Linger could not be diagnosed"}: boot startup and persistence after logout are not assured. Run loginctl enable-linger for this user if desired; local authorization may be required. No privileges are elevated automatically.`,
            ],
    };
  }
  private async directories(create: boolean): Promise<void> {
    await safeDirectory(this.config.homeDirectory);
    for (const path of [
      join(this.config.homeDirectory, ".config"),
      join(this.config.homeDirectory, ".config/systemd"),
      join(this.config.homeDirectory, ".config/systemd/user"),
    ])
      await safeDirectory(path, create);
  }
  private async ownedUnit(): Promise<boolean> {
    try {
      await this.directories(false);
      const metadata = await lstat(this.unitPath);
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.uid !== process.getuid?.() ||
        (metadata.mode & 0o777) !== 0o600
      )
        throw new Error(
          "Unsafe service definition: requires a user-only regular file"
        );
      if ((await readFile(this.unitPath, "utf8")) !== this.unit)
        throw new Error(
          "Installed service configuration conflicts; repair locally before retrying"
        );
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }
  private async managerUnit(
    allowMissing = false
  ): Promise<Map<string, string>> {
    if (this.os !== "linux")
      throw new Error("Linux systemd user services unavailable");
    const result = await this.runner({
      executable: this.systemctl,
      args: [
        "--user",
        "show",
        LINUX_AGENT_UNIT,
        "--property=LoadState",
        "--property=ActiveState",
        "--property=FragmentPath",
        "--property=DropInPaths",
        "--property=Transient",
      ],
    });
    const properties = new Map(
      result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        })
    );
    if (
      allowMissing &&
      properties.get("LoadState") === "not-found" &&
      !properties.get("FragmentPath") &&
      vendorDropIns(properties.get("DropInPaths")) &&
      properties.get("Transient") === "no"
    )
      return properties;
    if (result.exitCode !== 0)
      throw new Error("Agent service manager identity unavailable");
    if (
      properties.get("LoadState") !== "loaded" ||
      properties.get("FragmentPath") !== this.unitPath ||
      !vendorDropIns(properties.get("DropInPaths")) ||
      properties.get("Transient") !== "no"
    )
      throw new Error(
        "Effective agent service configuration conflicts; inspect loaded fragment and drop-ins before local repair"
      );
    return properties;
  }
  private async command(verb: string, unit = true): Promise<void> {
    if (this.os !== "linux")
      throw new Error("Linux systemd user services unavailable");
    const result = await this.runner({
      executable: this.systemctl,
      args: ["--user", verb, ...(unit ? [LINUX_AGENT_UNIT] : [])],
    });
    if (result.exitCode !== 0)
      throw new Error(
        `Agent service ${verb} failed; inspect the user journal and retry`
      );
  }
  async install(): Promise<LinuxServiceDiagnosis> {
    await this.directories(true);
    const exists = await this.ownedUnit();
    const diagnosis = await this.diagnose();
    if (!diagnosis.supported) throw new Error(diagnosis.limitations.join(" "));
    await access(this.config.nodePath, constants.X_OK);
    for (const file of [this.config.entryPath, this.config.configPath]) {
      if (!(await lstat(file)).isFile())
        throw new Error("Service entry/config must be regular files");
    }
    const data = await lstat(this.config.dataDirectory);
    if (
      !data.isDirectory() ||
      data.uid !== process.getuid?.() ||
      (data.mode & 0o777) !== 0o700
    )
      throw new Error("Agent data directory must be private and user-owned");
    await this.managerUnit(true);
    if (!exists) {
      // Exclusive creation never overwrites a concurrent installer or foreign definition.
      const file = await open(this.unitPath, "wx", 0o600);
      try {
        await file.writeFile(this.unit);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    await this.command("daemon-reload", false);
    await this.requireOwned();
    await this.command("enable");
    await this.start();
    return diagnosis;
  }
  private async requireOwned(): Promise<void> {
    if (!(await this.ownedUnit()))
      throw new Error("Agent service is not installed");
    await this.managerUnit();
  }
  async start(): Promise<void> {
    await this.requireOwned();
    await this.command("start");
  }
  async stop(): Promise<void> {
    await this.requireOwned();
    await this.command("stop");
  }
  async restart(): Promise<void> {
    await this.requireOwned();
    await this.command("restart");
  }
  async uninstall(): Promise<void> {
    if (!(await this.ownedUnit())) return;
    await this.managerUnit();
    await this.command("stop");
    await this.command("disable");
    await this.requireOwned();
    await rm(this.unitPath);
    await this.command("daemon-reload", false);
  }
  async status(): Promise<{ installed: boolean; active: boolean }> {
    if (!(await this.ownedUnit())) return { installed: false, active: false };
    const properties = await this.managerUnit();
    return {
      installed: true,
      active: properties.get("ActiveState") === "active",
    };
  }
}
