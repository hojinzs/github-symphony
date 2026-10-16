// Plant forbidden outcomes in isolated compiled artifacts, never the checkout.
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
const repository = fileURLToPath(new URL("../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "c16-mutations-"));
try {
  for (const name of ["fleet-control-plane", "management-protocol"]) {
    cpSync(
      join(repository, "packages", name, "dist"),
      join(root, "packages", name, "dist"),
      { recursive: true }
    );
    writeFileSync(
      join(root, "packages", name, "package.json"),
      JSON.stringify({ type: "module", exports: "./dist/index.js" })
    );
  }
  cpSync(
    join(repository, "packages/fleet-control-plane/assets"),
    join(root, "packages/fleet-control-plane/assets"),
    { recursive: true }
  );
  mkdirSync(join(root, "node_modules/@gh-symphony"), { recursive: true });
  symlinkSync(
    join(root, "packages/management-protocol"),
    join(root, "node_modules/@gh-symphony/management-protocol"),
    "dir"
  );
  mkdirSync(join(root, "e2e"));
  cpSync(
    join(repository, "e2e/fleet-projects-e2e.mjs"),
    join(root, "e2e/fleet-projects-e2e.mjs")
  );
  const cases = [
    ["project-pages", [["${first}–", "0–"]], "paging"],
    [
      "project-presentation",
      [
        [
          "sum + (project.activeWork ?? 0)",
          "sum + 1 + (project.activeWork ?? 0)",
        ],
      ],
      "fresh totals",
    ],
    [
      "project-pages",
      [
        [
          "return String(value).replace",
          "return String(value);\n void String(value).replace",
        ],
      ],
      "escaped inventory",
    ],
    [
      "project-presentation",
      [["Tracker scope overlap is unverified", "Scope is safe"]],
      "scope advisory",
    ],
    [
      "project-routes",
      [["                all,", "                all: items,"]],
      "filtered summary scope",
    ],
    [
      "project-pages",
      [
        [
          "const destination = localLink(links[kind]?.(p.projectId));",
          "const destination = undefined;",
        ],
      ],
      "verified Stop",
    ],
    [
      "project-pages",
      [['p.historical ? "Last known " : ""', 'false ? "Last known " : ""']],
      "historical process",
    ],
    [
      "project-pages",
      [
        [
          'const reason = kind === "start" ? p.startReason : p.stopReason;',
          "const reason = undefined;",
        ],
      ],
      "offline actions",
    ],
    [
      "project-presentation",
      [
        ['project.fresh && project.connection === "online"', "true"],
        ["!project.snapshotHistorical", "true"],
      ],
      "offline totals",
    ],
    [
      "project-routes",
      [
        [
          'readFileSync(new URL("../assets/" + asset[1] + ".svg", import.meta.url), "utf8")',
          '""',
        ],
      ],
      "local design asset",
    ],
    [
      "project-routes",
      [["!/^[1-9]\\d*$/.test(pageText)", "false"]],
      "invalid query",
    ],
  ];
  for (const [name, replacements, label] of cases) {
    const path = join(root, "packages/fleet-control-plane/dist", name + ".js");
    const original = readFileSync(path, "utf8");
    let mutated = original;
    for (const [from, to] of replacements) {
      assert.ok(mutated.includes(from), name + ": mutation target exists");
      mutated = mutated.replaceAll(from, to);
    }
    writeFileSync(path, mutated);
    try {
      const result = spawnSync(
        process.execPath,
        [join(root, "e2e/fleet-projects-e2e.mjs")],
        { encoding: "utf8", timeout: 30000, cwd: repository }
      );
      assert.equal(result.signal, null, label + ": no crash/timeout");
      assert.notEqual(
        result.status,
        0,
        label + ": rejects forbidden condition"
      );
      assert.ok(
        result.stdout.includes("reached: " + label),
        label + ": assertion reached\n" + result.stdout + result.stderr
      );
      assert.ok(
        result.stderr.includes("AssertionError"),
        label + ": assertion failure, not startup error"
      );
      console.log("probe passed: " + label);
    } finally {
      writeFileSync(path, original);
    }
  }
  console.log("C16 project artifact mutations passed (11 reached assertions)");
} finally {
  rmSync(root, { recursive: true, force: true });
}
