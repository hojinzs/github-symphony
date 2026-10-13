import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  MacOSAgentService,
  type LaunchctlRunner,
  type MacOSServiceConfig,
} from "./macos-service.js";

let root: string;
let config: MacOSServiceConfig;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "macos-service-"));
  config = {
    home: root,
    uid: process.getuid!(),
    nodePath: process.execPath,
    entrypoint: join(root, "agent & peer.mjs"),
    configPath: join(root, "config.json"),
    dataDirectory: join(root, "data"),
    label: "com.github-symphony.fixture",
  };
  await writeFile(config.entrypoint, "setInterval(() => {}, 1000);");
  await writeFile(config.configPath, "{}");
  await mkdir(config.dataDirectory, { mode: 0o700 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// Independent OS boundary: models launchctl's externally observable domain/job state.
function peer() {
  let loaded = false;
  let fail = false;
  const calls: string[][] = [];
  const runner: LaunchctlRunner = async (args) => {
    calls.push(args);
    if (args[0] === "print" && args[1] === `gui/${config.uid}`)
      return { code: 0, stdout: "gui domain", stderr: "" };
    if (args[0] === "print")
      return loaded
        ? {
            code: 0,
            stdout: `path = ${join(root, "Library/LaunchAgents", config.label + ".plist")}\nstate = running\npid = 123`,
            stderr: "",
          }
        : { code: 113, stdout: "", stderr: "Could not find service" };
    if (args[0] === "bootstrap") {
      if (fail) return { code: 5, stdout: "", stderr: "denied" };
      loaded = true;
    } else if (args[0] === "bootout") loaded = false;
    else throw new Error("Unexpected command");
    return { code: 0, stdout: "", stderr: "" };
  };
  return {
    runner,
    calls,
    fail(value: boolean) {
      fail = value;
    },
  };
}
it("writes an escaped private login-only plist with OS process cleanup disabled", async () => {
  const os = peer();
  const service = new MacOSAgentService(config, os.runner);
  await service.install();
  const body = await readFile(service.plistPath, "utf8");
  expect(body).toContain("agent &amp; peer.mjs");
  expect(body).toContain("<key>AbandonProcessGroup</key><true/>");
  expect(body).toContain("<key>ThrottleInterval</key><integer>10</integer>");
  expect(body).toContain("<key>SuccessfulExit</key><false/>");
  expect(body).toContain("<key>RunAtLoad</key><true/>");
  expect(body).not.toContain("EnvironmentVariables");
  expect((await stat(service.plistPath)).mode & 0o777).toBe(0o600);
  expect(service.autoStart).toEqual({
    login: false,
    beforeLogin: false,
    afterLogout: false,
  });
});
it("resumes failed bootstrap without rewriting enrollment or duplicating the definition", async () => {
  const os = peer();
  const service = new MacOSAgentService(config, os.runner);
  const identity = join(config.dataDirectory, "registry.json");
  await writeFile(identity, "saved-identity-and-allowlist");
  await service.install();
  const inode = (await stat(service.plistPath)).ino;
  os.fail(true);
  await expect(service.start()).rejects.toThrow("bootstrap");
  os.fail(false);
  await service.install();
  await service.start();
  expect((await service.status()).pid).toBe(123);
  expect((await stat(service.plistPath)).ino).toBe(inode);
  expect(await readFile(identity, "utf8")).toBe("saved-identity-and-allowlist");
});
it("queries actual job state and unloads before restart or uninstall while preserving data", async () => {
  const os = peer();
  const service = new MacOSAgentService(config, os.runner);
  await writeFile(join(config.dataDirectory, "journal"), "retained");
  await service.install();
  expect(await service.status()).toEqual({ installed: true, loaded: false });
  await service.start();
  await service.start();
  await service.restart();
  expect(os.calls.filter((c) => c[0] === "bootstrap")).toHaveLength(2);
  expect(os.calls.filter((c) => c[0] === "bootout")).toHaveLength(1);
  await service.stop();
  await service.stop();
  await service.start();
  await service.uninstall();
  await service.uninstall();
  expect(await service.status()).toEqual({ installed: false, loaded: false });
  expect(await readFile(join(config.dataDirectory, "journal"), "utf8")).toBe(
    "retained"
  );
});
it("rejects changed configuration and refuses to remove an unowned definition", async () => {
  const service = new MacOSAgentService(config, peer().runner);
  await service.install();
  const conflicting = new MacOSAgentService(
    { ...config, configPath: config.entrypoint },
    peer().runner
  );
  await expect(conflicting.install()).rejects.toThrow("conflict");
  await writeFile(service.plistPath, "foreign job");
  await expect(service.uninstall()).rejects.toThrow("conflict");
  expect(await readFile(service.plistPath, "utf8")).toBe("foreign job");
});
it("rejects relative paths, malformed labels and foreign user domains", () => {
  expect(
    () => new MacOSAgentService({ ...config, nodePath: "node" }, peer().runner)
  ).toThrow("absolute");
  expect(
    () =>
      new MacOSAgentService({ ...config, label: "../foreign" }, peer().runner)
  ).toThrow("label");
  expect(
    () =>
      new MacOSAgentService({ ...config, uid: config.uid + 1 }, peer().runner)
  ).toThrow("current user");
});
it("rejects symlink service directories and definitions", async () => {
  await mkdir(join(root, "elsewhere"));
  await symlink(join(root, "elsewhere"), join(root, "Library"));
  const service = new MacOSAgentService(config, peer().runner);
  await expect(service.install()).rejects.toThrow("directory");
  await rm(join(root, "Library"));
  await mkdir(join(root, "Library/LaunchAgents"), { recursive: true });
  await symlink(config.configPath, service.plistPath);
  await expect(service.install()).rejects.toThrow("definition");
});
it("preserves the definition when unload fails and never treats absent GUI support as stopped", async () => {
  const os = peer();
  const service = new MacOSAgentService(config, async (args) =>
    args[0] === "bootout"
      ? { code: 5, stdout: "", stderr: "failure" }
      : os.runner(args)
  );
  await service.install();
  await service.start();
  await expect(service.uninstall()).rejects.toThrow("bootout");
  expect(await readFile(service.plistPath, "utf8")).toContain(config.label);
  const unavailable = new MacOSAgentService(config, async () => ({
    code: 125,
    stdout: "",
    stderr: "no domain",
  }));
  await expect(unavailable.status()).rejects.toThrow("login session");
});
it("waits for asynchronous launchd removal after successful bootout", async () => {
  const os = peer();
  let removing = false;
  let pending = 0;
  const service = new MacOSAgentService(config, async (args) => {
    if (args[0] === "bootout") {
      removing = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (removing && args[0] === "print" && args[1].includes(config.label!)) {
      pending++;
      if (pending > 2) await os.runner(["bootout", args[1]]);
    }
    return os.runner(args);
  });
  await service.install();
  await service.start();
  await service.stop();
  expect(pending).toBeGreaterThan(2);
  expect((await service.status()).loaded).toBe(false);
});
it("rejects a loaded job from a different definition even when local installation matches", async () => {
  const service = new MacOSAgentService(config, async (args) =>
    args[1] === `gui/${config.uid}`
      ? { code: 0, stdout: "domain", stderr: "" }
      : { code: 0, stdout: "path = /foreign/job.plist\npid = 456", stderr: "" }
  );
  await service.install();
  await expect(service.stop()).rejects.toThrow(
    "Loaded service configuration conflict"
  );
});

it("rejects a non-executable Node file before creating a service definition", async () => {
  const nodePath = join(root, "non-executable-node");
  await writeFile(nodePath, "not executable");
  await chmod(nodePath, 0o600);
  const os = peer();
  const service = new MacOSAgentService({ ...config, nodePath }, os.runner);
  await expect(service.install()).rejects.toMatchObject({ code: "EACCES" });
  await expect(stat(service.plistPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(os.calls).toHaveLength(0);
});
