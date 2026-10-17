import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  AgentRegistry,
  setupAgent,
  type LaunchctlRunner,
} from "@gh-symphony/management-agent";
import { createNativeAgentService } from "./agent-service.js";
import type { AgentHostConfig } from "./agent-config.js";

it.each(["linux", "darwin"])(
  "composes %s setup recovery and service lifecycle through an independent OS peer",
  async (platform) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "agent-service-composition-"))
    );
    const directory = join(root, "agent");
    await mkdir(directory, { mode: 0o700 });
    const configPath = join(directory, "config.json");
    const config: AgentHostConfig = {
      version: 1,
      dataDirectory: directory,
      projectConfigDir: join(root, "projects"),
      nodePath: process.execPath,
      cliPath: join(root, "index.js"),
    };
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await writeFile(config.cliPath, "// independent CLI entry fixture");
    await writeFile(
      join(root, "agent-entry.js"),
      "// independent foreground entry fixture"
    );
    let failed = false;
    let loaded = false;
    let prompts = 0;
    let enrollments = 0;
    let starts = 0;
    const calls: string[] = [];
    const plist = join(
      root,
      "Library/LaunchAgents/com.github-symphony.management-agent.plist"
    );
    const start = async () => {
      const registry = await AgentRegistry.open(directory);
      await registry.close();
      starts++;
    };
    const launchctl: LaunchctlRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "print" && args[1] === `gui/${process.getuid!()}`)
        return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "print")
        return {
          code: loaded ? 0 : 113,
          stdout: loaded ? `path = ${plist}\npid = 1234\n` : "",
          stderr: "",
        };
      if (args[0] === "bootstrap") {
        if (!failed) {
          failed = true;
          return { code: 1, stdout: "", stderr: "fixture failure" };
        }
        await start();
        loaded = true;
      }
      if (args[0] === "bootout") loaded = false;
      return { code: 0, stdout: "", stderr: "" };
    };
    const service = createNativeAgentService(config, configPath, {
      platform,
      home: root,
      launchctl,
      linux: {
        platform: "linux",
        readSelfCgroup: async () => "0::/user.slice/agent.service\n",
        runner: async ({ args }) => {
          calls.push(args.join(" "));
          if (args.includes("--version"))
            return { exitCode: 0, stdout: "systemd 254\n" };
          if (args.includes("show-environment"))
            return { exitCode: 0, stdout: "{}" };
          if (args.includes("show-user"))
            return { exitCode: 0, stdout: "no\n" };
          if (args.includes("show"))
            return {
              exitCode: 0,
              stdout: `LoadState=loaded\nActiveState=active\nFragmentPath=${join(root, ".config/systemd/user/gh-symphony-agent.service")}\nDropInPaths=\nTransient=no\n`,
            };
          if (args.includes("daemon-reload") && !failed) {
            failed = true;
            return { exitCode: 1, stdout: "fixture failure" };
          }
          if (args.includes("start")) await start();
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const options = {
      directory,
      serverOrigin: "https://fixture.lan",
      service,
      client: {
        async enroll(request: { requestId: string }) {
          enrollments++;
          return {
            protocolVersion: 1 as const,
            requestId: request.requestId,
            environmentId: "11111111-1111-4111-8111-111111111111",
            agentId: "22222222-2222-4222-8222-222222222222",
            credential: "fixture-secret",
          };
        },
      },
      async readToken() {
        prompts++;
        return "fixture-token";
      },
      report() {},
    };
    try {
      await expect(setupAgent(options)).rejects.toThrow(/failed/);
      const saved = await readFile(join(directory, "registry.json"), "utf8");
      await setupAgent(options);
      expect(prompts).toBe(1);
      expect(enrollments).toBe(1);
      expect(starts).toBe(1);
      await service.status();
      await service.stop();
      await service.restart();
      await service.uninstall();
      expect(await readFile(join(directory, "registry.json"), "utf8")).toBe(
        saved
      );
      expect(
        calls.some((call) =>
          call.includes(platform === "linux" ? "disable" : "bootout")
        )
      ).toBe(true);
      expect(calls.join("\n")).not.toContain("fixture-secret");
      expect(await readFile(configPath, "utf8")).toBe(JSON.stringify(config));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
