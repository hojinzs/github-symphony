import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { CliProcess } from "./cli-process.js";

/** Trusted host configuration. The foreground entrypoint consumes --config <absolute file>. */
export interface MacOSServiceConfig {
  home: string;
  uid: number;
  nodePath: string;
  entrypoint: string;
  configPath: string;
  dataDirectory: string;
  /** Local fixture/embedding override; never supplied by the control plane. */
  label?: string;
}
export interface LaunchctlResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;
export interface MacOSServiceStatus {
  installed: boolean;
  loaded: boolean;
  pid?: number;
}

export const runLaunchctl: LaunchctlRunner = async (args) => {
  if (process.platform !== "darwin")
    throw new Error("LaunchAgent requires macOS");
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/launchctl",
      args,
      { timeout: 10_000, maxBuffer: 262_144, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(new Error("launchctl unavailable or timed out"));
          return;
        }
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      }
    );
  });
};
function xml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Owns only the current user's agent job; never signals or deletes a project. */
export class MacOSAgentService {
  readonly plistPath: string;
  readonly autoStart: {
    login: boolean;
    beforeLogin: false;
    afterLogout: false;
  };
  private readonly label: string;
  private readonly domain: string;
  private readonly target: string;
  private readonly definition: string;
  constructor(
    private readonly config: MacOSServiceConfig,
    private readonly runner: LaunchctlRunner = runLaunchctl
  ) {
    for (const value of [
      config.home,
      config.nodePath,
      config.entrypoint,
      config.configPath,
      config.dataDirectory,
    ]) {
      if (
        !isAbsolute(value) ||
        [...value].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error(
          "Service paths must be absolute and contain no control characters"
        );
    }
    if (!Number.isSafeInteger(config.uid) || config.uid !== process.getuid?.())
      throw new Error("Service must belong to the current user");
    this.autoStart = {
      login: config.home === userInfo().homedir,
      beforeLogin: false,
      afterLogout: false,
    };
    this.label = config.label ?? "com.github-symphony.management-agent";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,127}$/.test(this.label))
      throw new Error("Invalid service label");
    this.domain = `gui/${config.uid}`;
    this.target = `${this.domain}/${this.label}`;
    this.plistPath = join(
      config.home,
      "Library",
      "LaunchAgents",
      `${this.label}.plist`
    );
    const args = [
      config.nodePath,
      config.entrypoint,
      "--config",
      config.configPath,
    ];
    this.definition = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(this.label)}</string>\n<key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>\n<key>WorkingDirectory</key><string>${xml(config.dataDirectory)}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>ExitTimeOut</key><integer>20</integer>\n<key>AbandonProcessGroup</key><true/>\n<key>Umask</key><integer>63</integer>\n<key>StandardOutPath</key><string>${xml(join(config.dataDirectory, "agent.stdout.log"))}</string>\n<key>StandardErrorPath</key><string>${xml(join(config.dataDirectory, "agent.stderr.log"))}</string>\n</dict></plist>\n`;
  }
  private async directories(create: boolean) {
    for (const path of [
      this.config.home,
      join(this.config.home, "Library"),
      join(this.config.home, "Library", "LaunchAgents"),
    ]) {
      if (create)
        await mkdir(path, { mode: 0o700 }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          }
        );
      try {
        const metadata = await lstat(path);
        if (
          !metadata.isDirectory() ||
          metadata.uid !== this.config.uid ||
          metadata.mode & 0o022
        )
          throw new Error("Unsafe service directory");
      } catch (error) {
        if (!create && (error as NodeJS.ErrnoException).code === "ENOENT")
          return false;
        throw error;
      }
    }
    return true;
  }
  private async installed() {
    if (!(await this.directories(false))) return false;
    let file;
    try {
      file = await open(
        this.plistPath,
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error("Unsafe service definition");
    }
    try {
      const metadata = await file.stat();
      if (
        !metadata.isFile() ||
        metadata.uid !== this.config.uid ||
        (metadata.mode & 0o777) !== 0o600 ||
        metadata.size > 65_536
      )
        throw new Error("Unsafe service definition");
      if ((await file.readFile("utf8")) !== this.definition)
        throw new Error(
          "Service configuration conflict; explicit local repair required"
        );
      return true;
    } finally {
      await file.close();
    }
  }
  async install(): Promise<void> {
    await this.directories(true);
    for (const path of [
      this.config.nodePath,
      this.config.entrypoint,
      this.config.configPath,
    ]) {
      if (!(await stat(path)).isFile())
        throw new Error("Service executable/configuration must exist");
    }
    await access(this.config.nodePath, constants.X_OK);
    const data = await lstat(this.config.dataDirectory);
    if (
      !data.isDirectory() ||
      data.uid !== this.config.uid ||
      (data.mode & 0o777) !== 0o700
    )
      throw new Error("Agent data directory must be user-owned and private");
    if (await this.installed()) return;
    let file;
    try {
      file = await open(this.plistPath, "wx", 0o600);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EEXIST" &&
        (await this.installed())
      )
        return;
      throw error;
    }
    try {
      await file.writeFile(this.definition);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async status(): Promise<MacOSServiceStatus> {
    const installed = await this.installed();
    if ((await this.runner(["print", this.domain])).code !== 0)
      throw new Error(
        "macOS GUI login session unavailable; use foreground execution"
      );
    const result = await this.runner(["print", this.target]);
    if (result.code === 113) return { installed, loaded: false };
    if (result.code !== 0) throw new Error("launchctl status failed");
    if (
      !installed ||
      !result.stdout
        .split("\n")
        .some((line) => line.trim() === `path = ${this.plistPath}`)
    )
      throw new Error("Loaded service configuration conflict");
    const pid = /^\s*pid = (\d+)\s*$/m.exec(result.stdout);
    return { installed, loaded: true, ...(pid ? { pid: Number(pid[1]) } : {}) };
  }
  async start(): Promise<void> {
    const state = await this.status();
    if (!state.installed) throw new Error("Service is not installed");
    if (state.loaded) return;
    if (
      (await this.runner(["bootstrap", this.domain, this.plistPath])).code !== 0
    )
      throw new Error(
        "launchctl bootstrap failed; installed identity/configuration retained for retry"
      );
    if (!(await this.status()).loaded)
      throw new Error("launchctl bootstrap was not confirmed");
  }
  async stop(): Promise<void> {
    if (!(await this.status()).loaded) return;
    if ((await this.runner(["bootout", this.target])).code !== 0)
      throw new Error("launchctl bootout failed; definition retained");
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (!(await this.status()).loaded) return;
      await delay(Math.min(250, Math.max(0, deadline - Date.now())));
    }
    throw new Error(
      "launchctl bootout was not confirmed in the removal window"
    );
  }
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
  async uninstall(): Promise<void> {
    await this.stop();
    if (await this.installed()) await unlink(this.plistPath);
  }
}

/** Structural C03 native-service launcher port. Only trusted local arguments enter here. */
export interface MacOSProjectLaunch {
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  deadline: number;
}
export async function launchMacOSProject(
  request: MacOSProjectLaunch
): Promise<{ exitCode: number | null }> {
  if (process.platform !== "darwin")
    throw new Error("macOS project isolation requires macOS");
  return new CliProcess({
    executable: request.executable,
    environment: request.environment,
  }).run(request.args, request.cwd, request.deadline);
}
