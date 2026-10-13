// Copy compiled services and plant forbidden outcomes; never mutate the checkout.
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "c10-probes-"));
try {
  for (const name of [
    "fleet-control-plane",
    "management-agent",
    "management-protocol",
  ]) {
    cpSync(
      join(root, "packages", name, "dist"),
      join(dir, "packages", name, "dist"),
      { recursive: true }
    );
    writeFileSync(
      join(dir, "packages", name, "package.json"),
      JSON.stringify({ type: "module", exports: "./dist/index.js" })
    );
  }
  mkdirSync(join(dir, "node_modules/@gh-symphony"), { recursive: true });
  symlinkSync(
    join(dir, "packages/management-protocol"),
    join(dir, "node_modules/@gh-symphony/management-protocol"),
    "dir"
  );
  symlinkSync(
    join(root, "packages/orchestrator"),
    join(dir, "node_modules/@gh-symphony/orchestrator"),
    "dir"
  );
  mkdirSync(join(dir, "e2e"));
  cpSync(
    join(root, "e2e/fleet-reads-e2e.mjs"),
    join(dir, "e2e/fleet-reads-e2e.mjs")
  );
  const cases = [
    [
      "reads",
      "return { readId: request.readId };",
      'return { readId: request.readId, state: "pending" };',
      "submission matches strict protocol",
    ],
    [
      "read-routes",
      "browser.resolveActor(request);",
      "/* forbidden CSRF bypass */",
      "CSRF rejects read admission",
    ],
    [
      "reads",
      "now().getTime() + LIMITS.readLifetimeMs",
      "now().getTime() + LIMITS.readLifetimeMs + 1",
      "exact deadline expiry",
    ],
    [
      "reads",
      "time >= entry.retainUntil",
      "time > entry.retainUntil",
      "completed result retention ends",
    ],
    [
      "read-routes",
      "String(view.historical)",
      '"false"',
      "offline completed content is historical",
    ],
    [
      "reads",
      "if (!target.online)",
      "if (false)",
      "offline admission rejected",
    ],
    [
      "reads",
      'entry.result = readResultSchema.parse(result.state === "completed"',
      'entry.result = readResultSchema.parse(result.state === "completed"',
      "missing log is unavailable",
      "missing",
    ],
    [
      "reads",
      'entry.result = readResultSchema.parse(result.state === "completed"',
      'entry.result = readResultSchema.parse(result.state === "completed"',
      "rotation reset preserved",
      "reset",
    ],
    [
      "read-routes",
      "selection = readSelectionSchema.parse(request.body);",
      'selection = request.body?.stream === "../../secret" ? {kind:"runs",limit:1} : readSelectionSchema.parse(request.body);',
      "arbitrary stream rejected",
    ],
    [
      "reads",
      "options.receiveRunSummaries) {",
      "false) {",
      "projection receives cached summaries",
    ],
    [
      "reads",
      "pending.some((e) => e.request.projectId === projectId)",
      "false",
      "one pending read per project",
    ],
    [
      "reads",
      "!current?.online ||",
      "false ||",
      "offline pending detail is unavailable",
    ],
    [
      "runner",
      'db.prepare("SELECT count(*) AS n FROM fixture_history").get().n === 1',
      '(db.prepare("DELETE FROM fixture_history").run(), db.prepare("SELECT count(*) AS n FROM fixture_history").get().n === 1)',
      "restart preserves summaries without durable raw logs",
    ],
    [
      "reads",
      'historical: true,\n                result: {\n                    readId: id,\n                    state: "unavailable",',
      'historical: true,\n                result: {\n                    readId: id,\n                    state: c10Instances > 1 ? "expired" : "unavailable",',
      "restart makes unknown reads unavailable",
      "restart",
    ],
    [
      "reads",
      'entry.result = readResultSchema.parse(result.state === "completed"',
      'entry.result = readResultSchema.parse(result.state === "completed"',
      "bounded safe run summaries bypass lifecycle slot",
      'if(entry.result.state === "completed" && entry.result.payload.kind === "runs") entry.result.payload.runs = [];',
    ],
    [
      "reads",
      'entry.result = readResultSchema.parse(result.state === "completed"',
      'entry.result = readResultSchema.parse(result.state === "completed"',
      "known run detail",
      'if(entry.result.state === "completed" && entry.result.payload.kind === "run-detail") entry.result.payload.runId = "wrong";',
    ],
    [
      "reads",
      'entry.result = readResultSchema.parse(result.state === "completed"',
      'entry.result = readResultSchema.parse(result.state === "completed"',
      "bounded log chunk",
      'if(entry.result.state === "completed" && entry.result.payload.kind === "log-chunk" && entry.result.payload.text === "abcd") entry.result.payload.text = "bad";',
    ],
    [
      "reads",
      'entry.result = readResultSchema.parse(result.state === "completed"',
      'entry.result = readResultSchema.parse(result.state === "completed"',
      "append follows byte cursor",
      'if(entry.result.state === "completed" && entry.result.payload.kind === "log-chunk" && entry.result.payload.text === "efgh") entry.result.payload.text = "bad";',
    ],
    [
      "reads",
      'entry.result = readResultSchema.parse(result.state === "completed"',
      'entry.result = readResultSchema.parse(result.state === "completed"',
      "truncation reset preserved",
      'if(entry.result.state === "completed" && entry.result.payload.kind === "log-chunk" && entry.result.payload.text === "x") entry.result.payload.reset = false;',
    ],
    [
      "reads",
      'entry.result = readResultSchema.parse(result.state === "completed"',
      'entry.result = readResultSchema.parse(result.state === "completed"',
      "traversal is unavailable",
      'if(entry.result.state === "unavailable" && entry.request.selection.kind === "run-detail" && entry.request.selection.runId === "../secret") entry.result = {readId:entry.request.readId,state:"completed",completedAt:receivedAt,payload:{kind:"run-detail",runId:"../secret",detail:{}}};',
    ],
  ];
  for (const [module, old, replacement, label, inject] of cases) {
    const path =
      module === "runner"
        ? join(dir, "e2e/fleet-reads-e2e.mjs")
        : join(dir, "packages/fleet-control-plane/dist", `${module}.js`);
    const original = readFileSync(path, "utf8");
    assert.ok(original.includes(old), `mutation anchor ${label}`);
    let mutated = original.replace(old, replacement);
    if (inject === "restart") {
      mutated =
        "let c10Instances = 0;\n" +
        mutated.replace(
          "const maximumEntries =",
          "c10Instances++; const maximumEntries ="
        );
    } else if (inject) {
      const anchor =
        "                entry.retainUntil = now().getTime() + LIMITS.completedReadRetentionMs;";
      assert.ok(mutated.includes(anchor));
      const planted =
        inject === "reset"
          ? 'if (entry.result.state === "completed" && entry.result.payload.kind === "log-chunk") entry.result.payload.reset = false;'
          : inject === "missing"
            ? 'if (entry.result.state === "unavailable" && entry.request.selection.kind === "log-chunk") entry.result = {readId: entry.request.readId, state:"completed", completedAt:receivedAt, payload:{kind:"log-chunk",runId:entry.request.selection.runId,stream:entry.request.selection.stream,text:"",cursor:"forbidden",reset:false,eof:true}};'
            : inject;
      mutated = mutated.replace(anchor, planted + "\n" + anchor);
    }
    try {
      writeFileSync(path, mutated);
      const result = spawnSync(
        process.execPath,
        [join(dir, "e2e/fleet-reads-e2e.mjs")],
        { encoding: "utf8", timeout: 30_000 }
      );
      assert.notEqual(
        result.status,
        0,
        `forbidden condition escaped: ${label}`
      );
      assert.ok(
        result.stdout.includes(`reached: ${label}`),
        `assertion not reached: ${label}\n${result.stdout}\n${result.stderr}`
      );
      assert.ok(
        result.stderr.includes(label),
        `unexpected failure: ${label}\n${result.stderr}`
      );
      console.log(`PASS forbidden condition reached and failed: ${label}`);
    } finally {
      writeFileSync(path, original);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
