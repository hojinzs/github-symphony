import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  LinuxAgentService,
  renderLinuxAgentUnit,
  type LinuxServiceConfig,
} from "./linux-service.js";
import {
  runSystemd,
  type SystemdCommand,
  type SystemdRunner,
} from "./linux-systemd.js";

let root: string;
let config: LinuxServiceConfig;
let calls: SystemdCommand[];
let fail: string;
let linger: string;
let fragmentOverride: string | undefined;
let dropIns: string;
let transient: string;
let managerEnvironment: string;
let cgroup: string;
const peer: SystemdRunner = async (command) => {
  calls.push(command);
  if (command.args.includes(fail))
    return { exitCode: 1, stdout: "private peer diagnostic" };
  if (command.args.includes("--version"))
    return { exitCode: 0, stdout: "systemd 254\n" };
  if (command.args.includes("show-environment"))
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        Object.fromEntries(
          managerEnvironment
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const i = line.indexOf("=");
              return [line.slice(0, i), line.slice(i + 1)];
            })
        )
      ),
    };
  if (command.args.includes("show-user"))
    return { exitCode: 0, stdout: linger };
  if (command.args.includes("show"))
    return {
      exitCode: 0,
      stdout: `LoadState=loaded\nActiveState=active\nFragmentPath=${fragmentOverride ?? join(root, ".config/systemd/user/gh-symphony-agent.service")}\nDropInPaths=${dropIns}\nTransient=${transient}\n`,
    };
  return { exitCode: 0, stdout: "" };
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "linux-service-"));
  config = {
    homeDirectory: root,
    nodePath: process.execPath,
    entryPath: join(root, 'entry % " $HOME.mjs'),
    configPath: join(root, "agent config.json"),
    dataDirectory: join(root, "agent-data"),
  };
  await writeFile(
    config.entryPath,
    "// independently supplied service entrypoint"
  );
  await writeFile(config.configPath, "{}");
  await mkdir(config.dataDirectory, { mode: 0o700 });
  await writeFile(
    join(config.dataDirectory, "registry.json"),
    "saved-identity",
    { mode: 0o600 }
  );
  calls = [];
  fail = "never";
  linger = "yes\n";
  fragmentOverride = undefined;
  dropIns = "";
  transient = "no";
  managerEnvironment = "";
  cgroup = "0::/user.slice/agent.service\n";
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function service() {
  return new LinuxAgentService(config, {
    runner: peer,
    platform: "linux",
    readSelfCgroup: async () => cgroup,
  });
}

it("renders user-only absolute invocation without systemd argument expansion", () => {
  const unit = renderLinuxAgentUnit(config);
  expect(unit).toContain('ExecStart=:"');
  expect(unit).toContain('entry %% \\" $HOME.mjs"');
  expect(unit).toContain('"--data-dir"');
  expect(unit).toContain('"--native-service=linux"');
  expect(unit).toContain("WantedBy=default.target");
  expect(unit).toContain("KillMode=control-group");
  expect(unit).toContain("RestartSec=5s");
  expect(unit).not.toMatch(/PartOf=|BindsTo=|registry.json|saved-identity/);
});
it("rejects relative and control-character service paths", () => {
  for (const key of [
    "nodePath",
    "entryPath",
    "configPath",
    "dataDirectory",
  ] as const) {
    for (const invalid of ["relative", "/bad\nInjected=yes", "/bad\0path"]) {
      expect(() => renderLinuxAgentUnit({ ...config, [key]: invalid })).toThrow(
        /absolute|control/
      );
    }
  }
});
it("diagnoses unavailable managers and explicit linger limits without elevation", async () => {
  linger = "no\n";
  expect(await service().diagnose()).toMatchObject({
    supported: true,
    linger: "disabled",
    limitations: [expect.stringMatching(/loginctl enable-linger/)],
  });
  fail = "show-user";
  expect((await service().diagnose()).linger).toBe("unknown");
  fail = "show";
  expect((await service().diagnose()).supported).toBe(false);
  expect(calls.every((c) => !c.args.includes("enable-linger"))).toBe(true);
  expect(
    (
      await new LinuxAgentService(config, {
        runner: peer,
        platform: "darwin",
      }).diagnose()
    ).supported
  ).toBe(false);
});
it("recovers installation after start failure without rewriting identity", async () => {
  const adapter = service();
  fail = "start";
  await expect(adapter.install()).rejects.toThrow(/start/);
  expect(
    await readFile(join(config.dataDirectory, "registry.json"), "utf8")
  ).toBe("saved-identity");
  const installed = await readFile(adapter.unitPath, "utf8");
  fail = "never";
  expect((await adapter.install()).supported).toBe(true);
  expect(await readFile(adapter.unitPath, "utf8")).toBe(installed);
  expect(await adapter.status()).toEqual({ installed: true, active: true });
});
it("rejects conflicting definitions and unsafe unit paths before effects", async () => {
  const adapter = service();
  await mkdir(join(root, ".config/systemd/user"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(adapter.unitPath, "foreign-unit", { mode: 0o600 });
  await expect(adapter.install()).rejects.toThrow(/conflict/);
  expect(await readFile(adapter.unitPath, "utf8")).toBe("foreign-unit");
  expect(calls.some((c) => c.args.includes("enable"))).toBe(false);
  await rm(adapter.unitPath);
  await symlink(config.configPath, adapter.unitPath);
  await expect(adapter.install()).rejects.toThrow(/regular|unsafe/);
  await rm(adapter.unitPath);
  await chmod(join(root, ".config/systemd/user"), 0o777);
  await expect(adapter.install()).rejects.toThrow(/private|unsafe/);
});
it("targets only the owned agent and preserves all data on uninstall", async () => {
  const adapter = service();
  await adapter.install();
  calls = [];
  await adapter.stop();
  await adapter.restart();
  await adapter.start();
  await adapter.uninstall();
  expect(
    calls
      .filter((c) =>
        c.args.some((a) => ["start", "stop", "restart", "disable"].includes(a))
      )
      .map((c) => c.args)
  ).toEqual([
    ["--user", "stop", "gh-symphony-agent.service"],
    ["--user", "restart", "gh-symphony-agent.service"],
    ["--user", "start", "gh-symphony-agent.service"],
    ["--user", "stop", "gh-symphony-agent.service"],
    ["--user", "disable", "gh-symphony-agent.service"],
  ]);
  expect(
    await readFile(join(config.dataDirectory, "registry.json"), "utf8")
  ).toBe("saved-identity");
  await expect(readFile(adapter.unitPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect((await adapter.status()).installed).toBe(false);
  await adapter.uninstall();
});
it("refuses lifecycle operations on a replaced unit", async () => {
  const adapter = service();
  await adapter.install();
  await writeFile(adapter.unitPath, "replacement", { mode: 0o600 });
  calls = [];
  await expect(adapter.stop()).rejects.toThrow(/conflict/);
  await expect(adapter.uninstall()).rejects.toThrow(/conflict/);
  expect(calls).toEqual([]);
});
it("bounds subprocess output, deadlines and spawn failure without leaking stderr", async () => {
  expect(
    await runSystemd({
      executable: process.execPath,
      args: ["-e", 'console.log("ok");console.error("private")'],
    })
  ).toEqual({ exitCode: 0, stdout: "ok\n" });
  expect(
    (
      await runSystemd({
        executable: process.execPath,
        args: ["-e", 'console.log("x".repeat(70000))'],
      })
    ).exitCode
  ).toBeNull();
  expect(
    (
      await runSystemd({
        executable: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        timeoutMs: 30,
      })
    ).exitCode
  ).toBeNull();
  expect(
    (await runSystemd({ executable: join(root, "missing"), args: [] })).exitCode
  ).toBeNull();
});

it("renders a raw absolute working directory accepted by systemd", () => {
  const unit = renderLinuxAgentUnit(config);
  const cwd = unit
    .split("\n")
    .find((line) => line.startsWith("WorkingDirectory="))!
    .slice("WorkingDirectory=".length);
  // WorkingDirectory's native parser checks the raw rvalue; it does not unquote.
  expect(isAbsolute(cwd)).toBe(true);
  expect(cwd).not.toMatch(/["%]/);
});
it("rejects foreign fragments, transient units and drop-ins before manager lifecycle effects", async () => {
  const adapter = service();
  await adapter.install();
  for (const conflict of ["fragment", "drop-in", "transient"] as const) {
    fragmentOverride =
      conflict === "fragment"
        ? "/run/user/1000/systemd/transient/gh-symphony-agent.service"
        : undefined;
    dropIns =
      conflict === "drop-in"
        ? "/home/operator/.config/systemd/user/gh-symphony-agent.service.d/override.conf"
        : "";
    transient = conflict === "transient" ? "yes" : "no";
    calls = [];
    await expect(adapter.install()).rejects.toThrow(/conflict/);
    await expect(adapter.start()).rejects.toThrow(/conflict/);
    await expect(adapter.stop()).rejects.toThrow(/conflict/);
    await expect(adapter.restart()).rejects.toThrow(/conflict/);
    await expect(adapter.uninstall()).rejects.toThrow(/conflict/);
    await expect(adapter.status()).rejects.toThrow(/conflict/);
    expect(
      calls.some((c) =>
        c.args.some((a) =>
          ["start", "stop", "restart", "enable", "disable"].includes(a)
        )
      )
    ).toBe(false);
  }
});

it("rejects unsupported manager configuration before writing a unit", async () => {
  for (const environment of [
    "XDG_CONFIG_HOME=/custom/config\n",
    "XDG_CONFIG_HOME=relative\n",
  ]) {
    managerEnvironment = environment;
    const adapter = service();
    expect(await adapter.diagnose()).toMatchObject({
      supported: false,
      limitations: [expect.stringMatching(/XDG_CONFIG_HOME/)],
    });
    await expect(adapter.install()).rejects.toThrow(/XDG_CONFIG_HOME/);
    await expect(readFile(adapter.unitPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  for (const environment of [
    "",
    "XDG_CONFIG_HOME=\n",
    `XDG_CONFIG_HOME=${root}/.config\n`,
  ]) {
    managerEnvironment = environment;
    expect((await service().diagnose()).supported).toBe(true);
  }
  fail = "show-environment";
  expect((await service().diagnose()).supported).toBe(false);
});
it("rejects legacy hybrid and unavailable cgroup evidence before installation", async () => {
  for (const evidence of [
    "1:name=systemd:/user.slice\n",
    "0::/user.slice\n1:cpu:/user.slice\n",
    "",
  ]) {
    cgroup = evidence;
    const adapter = service();
    expect(await adapter.diagnose()).toMatchObject({
      supported: false,
      limitations: [expect.stringMatching(/cgroup v2/)],
    });
    await expect(adapter.install()).rejects.toThrow(/cgroup v2/);
    await expect(readFile(adapter.unitPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  const adapter = new LinuxAgentService(config, {
    runner: peer,
    platform: "linux",
    readSelfCgroup: async () => {
      throw new Error("unavailable");
    },
  });
  expect((await adapter.diagnose()).supported).toBe(false);
});
it("accepts vendor type-wide drop-ins but rejects targeted and user overrides", async () => {
  let loaded = false;
  const adapter = new LinuxAgentService(config, {
    platform: "linux",
    readSelfCgroup: async () => cgroup,
    runner: async (command) => {
      if (command.args.includes("daemon-reload")) loaded = true;
      if (
        !loaded &&
        command.args.includes("gh-symphony-agent.service") &&
        command.args.includes("show")
      ) {
        calls.push(command);
        return {
          exitCode: 0,
          stdout: `LoadState=not-found\nFragmentPath=\nDropInPaths=${dropIns}\nTransient=no\n`,
        };
      }
      return peer(command);
    },
  });
  dropIns =
    "/usr/lib/systemd/user/service.d/10-timeout-abort.conf /lib/systemd/user/service.d/20-default.conf";
  await adapter.install();
  expect(await adapter.status()).toEqual({ installed: true, active: true });
  await adapter.stop();
  for (const path of [
    "/usr/lib/systemd/user/gh-symphony-agent.service.d/override.conf",
    "/home/operator/.config/systemd/user/service.d/override.conf",
    "/run/user/1000/systemd/user.control/gh-symphony-agent.service.d/override.conf",
    "/usr/lib/systemd/user/service.d/../gh-symphony-agent.service.d/override.conf",
  ]) {
    dropIns = path;
    calls = [];
    await expect(adapter.stop()).rejects.toThrow(/conflict/);
    expect(calls.some((c) => c.args.includes("stop"))).toBe(false);
  }
  dropIns = "/usr/lib/systemd/user/service.d/10-timeout-abort.conf";
  await adapter.uninstall();
});

it("validates home directory at construction rather than unit rendering", () => {
  const relative = { ...config, homeDirectory: "relative" };
  expect(renderLinuxAgentUnit(relative)).toBe(renderLinuxAgentUnit(config));
  expect(() => new LinuxAgentService(relative)).toThrow(/absolute/);
});

it("reads manager XDG paths as JSON without shell quoting", async () => {
  const unusual = { ...config, homeDirectory: root + " space ' %" };
  for (const [value, supported] of [
    [unusual.homeDirectory + "/.config", true],
    ["/other", false],
  ] as const) {
    const runner: SystemdRunner = async (command) =>
      command.args.includes("show-environment")
        ? { exitCode: 0, stdout: JSON.stringify({ XDG_CONFIG_HOME: value }) }
        : peer(command);
    const adapter = new LinuxAgentService(unusual, {
      runner,
      platform: "linux",
      readSelfCgroup: async () => "0::/user.slice\n",
    });
    expect((await adapter.diagnose()).supported).toBe(supported);
  }
});

it("defers service start until the setup owner releases its registry lock", async () => {
  const adapter = service();
  await adapter.install({ start: false });
  expect(calls.some((call) => call.args.includes("enable"))).toBe(true);
  expect(calls.some((call) => call.args.includes("start"))).toBe(false);
  await adapter.start();
  expect(calls.some((call) => call.args.includes("start"))).toBe(true);
});
