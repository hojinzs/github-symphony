/** C23: reached-assertion probes plus isolated compiled CLI behavior mutations. */
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const scenario = fileURLToPath(
  new URL("./fleet-listener-e2e.mjs", import.meta.url)
);
const cliPackage = join(repository, "packages/cli");
const assertions = [
  "shared CLI help",
  "invalid configuration diagnostics",
  "unsafe storage diagnostics",
  "TLS material diagnostics",
  "foreground readiness",
  "fleet pages",
  "packaged local assets",
  "missing CSRF rejected",
  "cross origin rejected",
  "configured Host required",
  "duplicate body rejected",
  "enrollment body capped",
  "agent protocol JSON semantics",
  "browser actor cannot authenticate agent",
  "persisted browser environment",
  "CLI setup against production listener",
  "CP21 zero project signal",
  "occupied port without fallback",
  "SIGINT drains listener",
  "restart preserves environments",
  "saved agent reconnects after restart",
  "SIGTERM closes storage",
  "trusted HTTPS proxy boundary",
  "diagnostics do not expose secrets",
];
function probe(label, env) {
  const result = spawnSync(process.execPath, [scenario], {
    cwd: repository,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  const output = result.stdout + result.stderr;
  assert.ok(
    result.signal === null &&
      result.status !== 0 &&
      result.stdout.includes(`reached: ${label}`) &&
      result.stderr.includes("AssertionError") &&
      result.stderr.includes(label),
    `${label}: must reach and fail its assertion\n${output}`
  );
}
for (const label of assertions) {
  probe(label, { C23_PLANT: label });
  console.log(`forbidden condition rejected: ${label}`);
}
const root = mkdtempSync(join(tmpdir(), "c23-compiled-probes-"));
try {
  const copy = join(root, "cli");
  for (const path of ["dist", "assets", "package.json"])
    cpSync(join(cliPackage, path), join(copy, path), { recursive: true });
  symlinkSync(
    join(cliPackage, "node_modules"),
    join(copy, "node_modules"),
    "dir"
  );
  const compiled = readdirSync(join(copy, "dist"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(copy, "dist", name));
  const mutations = [
    [
      "enrollment body capped",
      'agent && url.pathname !== "/api/v1/agents/enroll"',
      "agent && true",
    ],
    ["agent protocol JSON semantics", "if (!agent) {", "if (true) {"],
    ["foreground readiness", 'from "node:sqlite"', 'from "sqlite"'],
    [
      "foreground readiness",
      'sendJson(200, { status: "ready" });',
      'sendJson(200, { status: "starting" });',
    ],
    [
      "missing CSRF rejected",
      "const browser = createBrowserSecurity(config);",
      'const browser = createBrowserSecurity(config); browser.resolveActor = () => "local-owner";',
    ],
    [
      "configured Host required",
      "if (req.headers.host !== new URL(config.publicOrigin).host) denied2();",
      "if (false) denied2();",
    ],
    [
      "occupied port without fallback",
      'server.once("error", reject);',
      'server.once("error", () => server.listen(0, config.bindAddress, resolve));',
    ],
    [
      "SIGINT drains listener",
      'process.once("SIGINT", stop);',
      "/* missing SIGINT handler */",
    ],
    [
      "saved agent reconnects after restart",
      "sessions.recoverAfterRestart();",
      "/* missing session recovery */",
    ],
    ["CP21 zero project signal", "count(p.project_id) AS n", "99 AS n"],
  ];
  mutations.push([
    "SIGTERM closes storage",
    "for (const socket of sockets) socket.destroy();",
    "/* stalled TLS socket left open */",
  ]);
  for (const [label, from, to] of mutations) {
    // Select the fleet assembly chunk, avoiding agent/lifecycle chunks sharing
    // generic signal/error handling statements. These are build artifacts only.
    const file = compiled.find((path) => {
      const source = readFileSync(path, "utf8");
      return source.includes("fleet-ready") && source.includes(from);
    });
    assert.ok(file, `compiled fleet mutation target exists: ${from}`);
    const source = readFileSync(file, "utf8");
    try {
      writeFileSync(file, source.replace(from, to));
      probe(label, { C23_CLI: join(copy, "dist/index.js"), C23_PLANT: "" });
      console.log(`compiled behavior rejected: ${label} (${from})`);
    } finally {
      writeFileSync(file, source);
    }
  }
  // Asset absence must be detected from an actual copied production package.
  const asset = join(copy, "assets/imgSymbolLayers.svg");
  const source = readFileSync(asset);
  try {
    writeFileSync(asset, "");
    probe("packaged local assets", {
      C23_CLI: join(copy, "dist/index.js"),
      C23_PLANT: "",
    });
    console.log("compiled behavior rejected: packaged local assets");
  } finally {
    writeFileSync(asset, source);
  }
  console.log(
    `C23 probes passed: ${assertions.length} reached assertions, ${mutations.length + 1} compiled/package behavior mutations`
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
