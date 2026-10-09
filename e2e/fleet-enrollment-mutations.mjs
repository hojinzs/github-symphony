// Plant forbidden conditions in isolated copies of actual compiled C04 artifacts.
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
const dir = mkdtempSync(join(tmpdir(), "fleet-blackbox-mutations-"));
const fleet = join(dir, "packages/fleet-control-plane");
try {
  for (const name of ["fleet-control-plane", "management-protocol"]) {
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
  mkdirSync(join(dir, "e2e"));
  for (const name of [
    "fleet-enrollment-server.mjs",
    "fleet-enrollment-e2e.mjs",
  ])
    cpSync(join(root, "e2e", name), join(dir, "e2e", name));
  const cases = [
    [
      "browser-security",
      "request.origin !== publicOrigin",
      "false",
      "CP16 foreign origin rejected",
    ],
    [
      "browser-security",
      "!timingSafeEqual(session.csrf, digest(request.csrfToken))",
      "false",
      "CP16 cross-session CSRF rejected",
    ],
    [
      "browser-security",
      "; Secure; HttpOnly;",
      "; HttpOnly;",
      "secure cookie attributes",
    ],
    [
      "enrollment",
      "expiresAt <= now().getTime()",
      "expiresAt < now().getTime()",
      "CP20 exact token expiry",
    ],
    [
      "enrollment",
      "UPDATE environments SET enrollment = 'enrolled', connection = 'awaiting-signal', last_contact_at = NULL WHERE id = ?",
      "UPDATE environments SET enrollment = 'enrolled', connection = 'online', last_contact_at = NULL WHERE id = ?",
      "CP20 exchange alone awaits signal",
    ],
    [
      "enrollment",
      "function authenticate(identity) {",
      "function authenticate(identity) { return;",
      "browser actor cannot authorize agent session",
    ],
    [
      "enrollment",
      "options.invalidateManagementAccess(database, id)",
      "undefined",
      "revocation invokes peer command expiry",
    ],
    [
      "enrollment",
      '"environment.create"',
      '"environment.unlogged"',
      "CP16 valid local-owner operation audited",
    ],
  ];
  for (const [file, before, after, assertion] of cases) {
    const path = join(fleet, "dist", file + ".js");
    const source = readFileSync(path, "utf8");
    assert.ok(source.includes(before), `Mutation target absent: ${file}`);
    try {
      writeFileSync(path, source.replace(before, after));
      const result = spawnSync(
        process.execPath,
        [join(dir, "e2e/fleet-enrollment-e2e.mjs")],
        { encoding: "utf8", timeout: 30_000 }
      );
      assert.ok(
        result.status !== 0 && result.status !== null,
        `Forbidden condition did not fail: ${assertion}`
      );
      assert.ok(
        result.stdout.includes(`reached: ${assertion}`),
        `Assertion not reached: ${assertion}`
      );
      assert.ok(
        result.stderr.includes("AssertionError"),
        `Failure was not an assertion: ${assertion}`
      );
      console.log(`proved red: ${assertion}`);
    } finally {
      writeFileSync(path, source);
    }
  }
  console.log(
    `fleet HTTPS forbidden-condition probes passed (8 assertions; ${process.platform})`
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
