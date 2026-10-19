/** C23 test-only native OS peer. Never imports or replaces the fleet server. */
import childProcess from "node:child_process";
import os from "node:os";
import fsPromises from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";

const home = process.env.C23_OS_HOME;
if (!home || !home.endsWith("/os-home") || !existsSync(home)) {
  throw new Error("C23 OS peer requires an isolated pre-created os-home");
}
const self = fileURLToPath(import.meta.url);
const unit = join(home, ".config/systemd/user/gh-symphony-agent.service");
const plist = join(
  home,
  "Library/LaunchAgents/com.github-symphony.management-agent.plist"
);
const state = join(home, "started");
if (process.argv[2] === "--os-command") {
  const command = process.argv[3];
  const args = process.argv.slice(4);
  if (command === "systemctl") {
    if (args.includes("--version")) process.stdout.write("systemd 254\n");
    else if (args.includes("show-environment")) process.stdout.write("{}\n");
    else if (args.includes("--property=Version")) process.stdout.write("254\n");
    else if (args.includes("show"))
      process.stdout.write(
        `LoadState=${existsSync(unit) ? "loaded" : "not-found"}\nActiveState=${existsSync(state) ? "active" : "inactive"}\nFragmentPath=${existsSync(unit) ? unit : ""}\nDropInPaths=\nTransient=no\n`
      );
    else if (args.includes("start"))
      writeFileSync(state, "started", { mode: 0o600 });
    else if (!args.some((arg) => ["enable", "daemon-reload"].includes(arg)))
      throw new Error("Unexpected C23 systemctl operation");
  } else if (command === "loginctl" && args.includes("show-user"))
    process.stdout.write("no\n");
  else if (command === "launchctl") {
    if (args[0] === "print" && args[1] === `gui/${process.getuid()}`) {
      /* GUI domain exists. */
    } else if (args[0] === "print") {
      if (!existsSync(state)) process.exitCode = 113;
      else process.stdout.write(`path = ${plist}\n`);
    } else if (args[0] === "bootstrap")
      writeFileSync(state, "started", { mode: 0o600 });
    else throw new Error("Unexpected C23 launchctl operation");
  } else throw new Error("Unexpected native OS command");
} else {
  // Confine generated service definitions without changing the operator's home
  // or service manager. Real native adapter code still renders/checks its files.
  os.homedir = () => resolve(home);
  const readFile = fsPromises.readFile;
  fsPromises.readFile = (path, ...args) =>
    path === "/proc/self/cgroup"
      ? Promise.resolve("0::/c23-os-peer.service\n")
      : readFile(path, ...args);
  const spawn = childProcess.spawn;
  const execFile = childProcess.execFile;
  const peerArgs = (command, args) => {
    const name = basename(String(command));
    if (!["systemctl", "loginctl", "launchctl"].includes(name))
      throw new Error("C23 OS peer refuses an unexpected subprocess");
    return [self, "--os-command", name, ...args];
  };
  childProcess.spawn = (command, args, options) =>
    spawn(process.execPath, peerArgs(command, args), options);
  childProcess.execFile = (command, args, options, callback) =>
    execFile(process.execPath, peerArgs(command, args), options, callback);
  syncBuiltinESMExports();
}
