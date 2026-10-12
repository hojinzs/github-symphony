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
  ];
  for (const [module, old, replacement, label, inject] of cases) {
    const path = join(dir, "packages/fleet-control-plane/dist", `${module}.js`);
    const original = readFileSync(path, "utf8");
    assert.ok(original.includes(old), `mutation anchor ${label}`);
    let mutated = original.replace(old, replacement);
    if (inject) {
      const anchor =
        "                entry.retainUntil = now().getTime() + LIMITS.completedReadRetentionMs;";
      assert.ok(mutated.includes(anchor));
      const planted =
        inject === "reset"
          ? 'if (entry.result.state === "completed" && entry.result.payload.kind === "log-chunk") entry.result.payload.reset = false;'
          : 'if (entry.result.state === "unavailable" && entry.request.selection.kind === "log-chunk") entry.result = {readId: entry.request.readId, state:"completed", completedAt:receivedAt, payload:{kind:"log-chunk",runId:entry.request.selection.runId,stream:entry.request.selection.stream,text:"",cursor:"forbidden",reset:false,eof:true}};';
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
