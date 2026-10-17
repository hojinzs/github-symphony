import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { access } from "node:fs/promises";
import {
  LinuxAgentService,
  MacOSAgentService,
  type SetupService,
  type LinuxServiceOptions,
  type LaunchctlRunner,
} from "@gh-symphony/management-agent";
import type { AgentHostConfig } from "./agent-config.js";

export interface NativeAgentService extends SetupService {
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<unknown>;
  uninstall(): Promise<void>;
}
/** Local composition seam for independent OS peers; remote messages cannot select these values. */
export interface NativeServiceHost {
  platform?: string;
  home?: string;
  linux?: LinuxServiceOptions;
  launchctl?: LaunchctlRunner;
}
export function createNativeAgentService(
  config: AgentHostConfig,
  configPath: string,
  host: NativeServiceHost = {}
): NativeAgentService {
  const platform = host.platform ?? process.platform;
  const entrypoint = join(dirname(config.cliPath), "agent-entry.js");
  const paths = async () => {
    for (const path of [
      config.nodePath,
      config.cliPath,
      entrypoint,
      configPath,
    ])
      await access(path);
  };
  if (platform === "linux") {
    const service = new LinuxAgentService(
      {
        homeDirectory: host.home ?? homedir(),
        nodePath: config.nodePath,
        entryPath: entrypoint,
        configPath,
        dataDirectory: config.dataDirectory,
      },
      host.linux
    );
    return {
      async check() {
        await paths();
        const diagnosis = await service.diagnose();
        if (!diagnosis.supported)
          throw new Error(
            diagnosis.limitations.join(" ") +
              " Use gh-symphony agent enroll, then agent run."
          );
        return diagnosis.limitations;
      },
      async install() {
        await service.install({ start: false });
      },
      start: () => service.start(),
      stop: () => service.stop(),
      restart: () => service.restart(),
      status: async () => ({
        ...(await service.status()),
        ...(await service.diagnose()),
      }),
      uninstall: () => service.uninstall(),
    };
  }
  if (platform === "darwin") {
    const service = new MacOSAgentService(
      {
        home: host.home ?? homedir(),
        uid: process.getuid!(),
        nodePath: config.nodePath,
        entrypoint,
        configPath,
        dataDirectory: config.dataDirectory,
      },
      host.launchctl
    );
    return {
      async check() {
        await paths();
        await service.status();
        return [
          "LaunchAgent starts at user login, not before login; logout stops the agent. Managed processes are not promised to survive session teardown.",
        ];
      },
      install: () => service.install(),
      start: () => service.start(),
      stop: () => service.stop(),
      restart: () => service.restart(),
      status: async () => ({
        ...(await service.status()),
        autoStart: service.autoStart,
      }),
      uninstall: () => service.uninstall(),
    };
  }
  throw new Error(
    "Native agent services require Linux systemd 254+ or macOS; use agent enroll and agent run on a supported host"
  );
}
