import {
  realpath,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRegistry } from "@gh-symphony/management-agent";
import { runCli } from "../index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-cli-")));
  roots.push(root);
  const directory = join(root, "agent");
  await mkdir(directory, { mode: 0o700 });
  const config = join(directory, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      dataDirectory: directory,
      projectConfigDir: join(root, "projects"),
      nodePath: process.execPath,
      cliPath: join(root, "cli.js"),
    }),
    { mode: 0o600 }
  );
  return { root, directory, config };
}
it("routes agent project registration without changing existing project commands", async () => {
  const { root, directory, config } = await fixture();
  const folder = join(root, "prepared");
  await mkdir(folder);
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  await runCli([
    "agent",
    "project",
    "add",
    folder,
    "--agent-config",
    config,
    "--json",
  ]);
  expect(process.exitCode).toBeUndefined();
  const added = JSON.parse(output);
  expect(added.canonicalPath).toBe(folder);
  output = "";
  await runCli([
    "agent",
    "project",
    "list",
    "--agent-config",
    config,
    "--json",
  ]);
  expect(JSON.parse(output)).toEqual([added]);
  await runCli([
    "agent",
    "project",
    "remove",
    added.localProjectId,
    "--agent-config",
    config,
  ]);
  const registry = await AgentRegistry.open(directory);
  expect(registry.list()).toEqual([]);
  await registry.close();
  output = "";
  await runCli(["project", "--help"]);
  expect(output).toContain("start");
  expect(output).toContain("stop");
});
it("provides shared agent help and refuses command-line tokens", async () => {
  let output = "";
  let errors = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors += String(chunk);
    return true;
  });
  await runCli(["agent", "setup", "--help"]);
  expect(output).toContain("--token-stdin");
  expect(output).toContain("--server");
  output = "";
  await runCli(["agent", "service", "--help"]);
  for (const verb of [
    "install",
    "start",
    "stop",
    "restart",
    "status",
    "uninstall",
  ])
    expect(output).toContain(verb);
  for (const tokenArguments of [
    ["--token", "fixture-secret"],
    ["--token=fixture-secret"],
  ]) {
    errors = "";
    await runCli([
      "agent",
      "enroll",
      "--server",
      "https://fixture.lan",
      ...tokenArguments,
    ]);
    expect(process.exitCode).toBe(1);
    expect(errors).toContain("Token arguments");
    expect(errors).not.toContain("fixture-secret");
  }
});
it("reports the shared foreground owner conflict without changing identity", async () => {
  const { directory, config } = await fixture();
  const registry = await AgentRegistry.open(directory);
  try {
    const before = await readFile(config, "utf8");
    await expect(
      runCli(["agent", "run", "--agent-config", config])
    ).rejects.toThrow(/already|lock|owner/i);
    expect(await readFile(config, "utf8")).toBe(before);
  } finally {
    await registry.close();
  }
});

it("rejects unknown removal without revoking a registered folder", async () => {
  const { root, directory, config } = await fixture();
  const folder = join(root, "prepared");
  await mkdir(folder);
  const registry = await AgentRegistry.open(directory);
  const added = await registry.add(folder);
  await registry.close();
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await expect(
    runCli(["agent", "project", "remove", "typo", "--agent-config", config])
  ).rejects.toThrow("project_unmanaged");
  expect(output).not.toHaveBeenCalled();
  const reopened = await AgentRegistry.open(directory);
  expect(reopened.list()).toEqual([added]);
  await reopened.close();
});
