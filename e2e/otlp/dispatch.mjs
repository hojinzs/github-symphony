import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const phase = process.argv[2];
assert.ok(["plain", "authenticated", "restart", "outage"].includes(phase));
const evidence = `/evidence/${phase}`;
const root = "/tmp/otlp-project";
const runtime = "/tmp/otlp-runtime";
await mkdir(evidence, { recursive: true });
await mkdir(`${root}/hooks`, { recursive: true });
await cp("/e2e/seed/hooks/after_create.sh", `${root}/hooks/after_create.sh`);
const issue = JSON.parse(
  await readFile("/e2e/fixtures/happy-path.json", "utf8")
)[0];
issue.id = `otlp-${phase}`;
issue.tracker.itemId = issue.id;
issue.number =
  ["plain", "authenticated", "restart", "outage"].indexOf(phase) + 201;
issue.identifier = `test-owner/test-repo#${issue.number}`;
await writeFile(`${root}/issues.json`, JSON.stringify([issue]));
const endpoint = `http://collector:${phase === "authenticated" ? 4319 : 4318}`;
const auth = `Basic ${Buffer.from("fixture:collector-fixture").toString("base64")}`;
const original = await readFile("/e2e/seed/WORKFLOW.md", "utf8");
await writeFile(
  `${root}/WORKFLOW.md`,
  original.replace(
    "---\n\nYou",
    `observability:\n  otlp:\n    enabled: true\n    endpoint: ${endpoint}\n${phase === "authenticated" ? "    headers:\n      Authorization: $OTLP_FIXTURE_AUTH\n" : ""}---\n\nYou`
  )
);
await writeFile(
  `${root}/.env`,
  "STUB_SCENARIO=api-progress\nSYMPHONY_ALLOW_WORKFLOW_HOOKS=1\n"
);
const child = spawn(
  process.execPath,
  [
    "/app/packages/cli/dist/index.js",
    "--config",
    runtime,
    "project",
    "start",
    "--project-dir",
    root,
  ],
  {
    env: {
      ...process.env,
      HOME: "/tmp/otlp-home",
      GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH: `${root}/issues.json`,
      OTLP_FIXTURE_AUTH: auth,
    },
    stdio: ["ignore", "pipe", "pipe"],
  }
);
let output = "";
child.stdout.on("data", (data) => {
  output += data;
});
child.stderr.on("data", (data) => {
  output += data;
});
const exited = new Promise((resolve) =>
  child.once("exit", (code, signal) => resolve({ code, signal }))
);
async function files(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(join(path, entry.name))
          : [join(path, entry.name)]
      )
    )
  ).flat();
}
let run;
try {
  for (let index = 0; index < 90; index++) {
    for (const path of (await files(runtime)).filter((path) =>
      path.endsWith("/run.json")
    )) {
      const candidate = JSON.parse(await readFile(path, "utf8"));
      if (
        candidate.issueId === issue.id ||
        candidate.issueIdentifier === issue.identifier
      ) {
        if (candidate.status === "succeeded")
          run = { ...candidate, evidenceRunDir: path.slice(0, -9) };
      }
    }
    if (run) break;
    if (child.exitCode !== null) throw new Error(`CLI exited early: ${output}`);
    await delay(1000);
  }
  console.log(`reached: ${phase} dispatch`);
  assert.ok(run, `Dispatch did not succeed: ${output}`);
  // Remove pickup input before final reconciliation and graceful provider flush.
  await writeFile(`${root}/issues.json`, "[]");
  child.kill("SIGTERM");
  const result = await Promise.race([
    exited,
    delay(10000).then(() => {
      throw new Error("shutdown exceeded 10 seconds");
    }),
  ]);
  assert.equal(result.code, 0, JSON.stringify(result));
  await cp(run.evidenceRunDir, `${evidence}/run`, { recursive: true });
  await writeFile(
    `${evidence}/manifest.json`,
    JSON.stringify(
      {
        phase,
        endpoint,
        runId: run.runId,
        projectId: run.projectId,
        completedAt: new Date().toISOString(),
        shutdown: result,
      },
      null,
      2
    )
  );
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await writeFile(`${evidence}/cli.log`, output);
}
console.log(`OT-14 ${phase} dispatch and shutdown passed`);
