import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CliProcess } from "./cli-process.js";
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cli-process-contract-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it("uses argument arrays without shell interpretation and strips management credentials", async () => {
  const path = join(root, "peer.mjs");
  await writeFile(
    path,
    'import {writeFileSync} from "node:fs"; writeFileSync("received.json", JSON.stringify({args:process.argv.slice(2),env:process.env})); console.log(JSON.stringify({outcome:"already_stopped"}));'
  );
  const peer = new CliProcess({
    executable: process.execPath,
    argumentPrefix: [path],
    environment: {
      ...process.env,
      GH_SYMPHONY_MANAGEMENT_TOKEN: "management",
      GH_SYMPHONY_AGENT_CREDENTIAL: "agent",
      SYMPHONY_ORCHESTRATOR_TOKEN: "broker",
      ALIAS: "prefix-secret-credential-suffix",
      PROJECT_TOKEN: "project-only-token",
    },
    managementCredentials: ["secret-credential"],
  });
  const result = await peer.run(
    ["project", "stop", "--project-dir", "literal $(touch forbidden) ; space"],
    root
  );
  expect(result).toEqual({ exitCode: 0, outcome: "already_stopped" });
  const received = JSON.parse(
    await readFile(join(root, "received.json"), "utf8")
  );
  expect(received.args).toEqual([
    "project",
    "stop",
    "--project-dir",
    "literal $(touch forbidden) ; space",
  ]);
  expect(received.env.PROJECT_TOKEN).toBe("project-only-token");
  expect(received.env.GH_SYMPHONY_MANAGEMENT_TOKEN).toBeUndefined();
  expect(received.env.GH_SYMPHONY_AGENT_CREDENTIAL).toBeUndefined();
  expect(received.env.SYMPHONY_ORCHESTRATOR_TOKEN).toBeUndefined();
  expect(received.env.ALIAS).toBeUndefined();
});
it("bounds unresolved child calls and rejects relative executable configuration", async () => {
  const path = join(root, "stall.mjs");
  await writeFile(path, "setInterval(() => {}, 1000);");
  const peer = new CliProcess({
    executable: process.execPath,
    argumentPrefix: [path],
    timeoutMs: 30,
  });
  expect((await peer.run([], root)).exitCode).toBeNull();
  expect(() => new CliProcess({ executable: "node" })).toThrow("absolute");
});
