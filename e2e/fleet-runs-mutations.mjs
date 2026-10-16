// Each probe mutates copied production output and must reach its named assertion.
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "c18-mutations-"));
const browser = process.argv.includes("--browser");
const p = (name) => "packages/fleet-control-plane/dist/" + name + ".js";
const bundle = "packages/fleet-control-plane/dist/browser/run-log-client.js";
const css = (rule) => [
  "run-pages",
  [["export const runStyles = `", "export const runStyles = `" + rule]],
];
const cases = browser
  ? [
      [
        bundle,
        [
          [
            "output.textContent = model.text;",
            'output.textContent = model.text; root2.querySelector("#history-observed").setAttribute("datetime", lastObservedAt);',
          ],
        ],
        "summary timestamp stays with snapshot",
      ],
      [
        bundle,
        [
          [
            "output.textContent = model.text;",
            "output.innerHTML = model.text;",
          ],
        ],
        "log text is inert",
      ],
      [
        bundle,
        [
          [
            "output.textContent = model.text;",
            'output.textContent = model.text; if(model.phase === "ready") select.value=JSON.stringify([model.identity.runId,"events"]);',
          ],
        ],
        "known initial selection",
      ],
      [
        bundle,
        [
          [
            "output.textContent = model.text;",
            'output.textContent = (model.identity.stream === "events" ? "session started" : "") + model.text;',
          ],
        ],
        "stream change clears prior content",
      ],
      [
        bundle,
        [
          [
            "pause() {\n      this.following = false;",
            "pause() {\n      this.following = true;",
          ],
        ],
        "keyboard follow and pause",
      ],
      [
        bundle,
        [
          [
            "if (event.persisted) void checkConnection();",
            "if (false) void checkConnection();",
          ],
        ],
        "cached page reconnects paused",
      ],
      [
        bundle,
        [["if (payload.reset) {", 'if (payload.reset) { this.text = "";']],
        "rotation preserves text until reset",
      ],
      [bundle, [["read.focus();", "output.focus();"]], "reset returns focus"],
      [
        bundle,
        [
          [
            'model.online ? "Recorded summaries" : "Historical summaries"',
            'model.online ? "Recorded summaries" : "Recorded summaries"',
          ],
        ],
        "offline history label",
      ],
      [
        bundle,
        [
          [
            "disconnect() {\n      this.online = false;",
            "disconnect() {\n      this.fetchedAt = void 0; this.online = false;",
          ],
        ],
        "offline retains timestamp and text",
      ],
      ...[1440, 1024, 390].flatMap((width) => {
        const media =
          width === 1440
            ? "(min-width:1200px)"
            : width === 1024
              ? "(min-width:651px) and (max-width:1199px)"
              : "(max-width:650px)";
        const [file, overflow] = css(
          "@media " + media + "{.run-page{width:2000px}}"
        );
        const [, geometry] = css(
          "@media " + media + "{.shell img{transform:scale(2)}}"
        );
        return [
          [p(file), overflow, "layout no overflow " + width],
          [p(file), geometry, "local asset geometry " + width],
        ];
      }),
      [
        bundle,
        [
          [
            "reconnect() {\n      this.online = true;",
            'reconnect() {\n      if(this.phase === "offline") this.following = true; this.online = true;',
          ],
        ],
        "reconnect does not follow",
      ],
      [
        bundle,
        [
          [
            "this.phase = result.state;",
            'this.phase = result.state; if(result.state === "unavailable") this.text = "forbidden";',
          ],
        ],
        "missing file fresh read recovery",
      ],
      [
        bundle,
        [
          [
            'state: expired ? "expired" : "unavailable",',
            'state: (expired ? (this.model.text = "", "expired") : "unavailable"),',
          ],
        ],
        "expired read retains content",
      ],
      [
        bundle,
        [
          [
            "(() => {",
            '(() => { setTimeout(() => { throw new Error("forbidden browser error"); },0);',
          ],
        ],
        "no browser runtime errors",
      ],
      [
        p("run-pages"),
        [
          [
            'id="log-selection" ${selected ? "" : "disabled"}',
            'id="log-selection"',
          ],
        ],
        "empty history disables reads",
      ],
    ]
  : [
      [
        p("run-pages"),
        [
          [
            "environmentId: project.environmentId,",
            'environmentId: "foreign",',
          ],
        ],
        "project-scoped history",
      ],
      [
        p("run-pages"),
        [[".slice((page - 1) * 25, page * 25)", ".slice(0, 1)"]],
        "bounded history paging",
      ],
      [
        p("run-routes"),
        [["(runId !== undefined &&", "(false &&"]],
        "invalid selection ?run=foreign",
      ],
      [
        p("run-routes"),
        [["!LOG_STREAMS.includes(stream)", "false"]],
        "invalid selection ?stream=../../secret",
      ],
      [
        p("run-routes"),
        [['!["run", "stream", "page"].includes(key)', "false"]],
        "invalid selection ?path=/etc/passwd",
      ],
      [
        p("read-routes"),
        [["browser.resolveActor(request);", "void request;"]],
        "CSRF required",
      ],
      [
        p("run-log-model"),
        [['this.text = points.slice(start).join("");', 'this.text = "";']],
        "actual filesystem log",
      ],
      [
        p("run-log-model"),
        [["this.cursor = payload.cursor;", "this.cursor = undefined;"]],
        "bounded continuation",
      ],
      [
        p("run-log-model"),
        [['this.phase = "reset-required";', 'this.phase = "ready";']],
        "explicit rotation reset",
      ],
      [
        p("run-log-model"),
        [
          [
            'this.text = "";\n        this.fetchedAt = undefined;',
            "this.fetchedAt = undefined;",
          ],
        ],
        "fresh generation",
      ],
      [
        p("run-log-model"),
        [
          [
            "if (payload.reset) {",
            'if (payload.reset && payload.text !== "x") {',
          ],
        ],
        "explicit truncation reset",
      ],
      [
        p("run-log-model"),
        [
          [
            'this.text = points.slice(start).join("");',
            'this.text = points.slice(start).join("").slice(0,1024);',
          ],
        ],
        "UTF-8 byte bound",
      ],
      [
        p("run-log-model"),
        [["this.phase = result.state;", 'this.phase = "ready";']],
        "missing file unavailable",
      ],
      [
        p("run-log-model"),
        [
          [
            "disconnect() {\n        this.online = false;",
            'disconnect() {\n        this.text = ""; this.online = false;',
          ],
        ],
        "offline preserves history",
      ],
      [
        p("run-pages"),
        [["online: project.connection", "online: true || project.connection"]],
        "offline connection projection",
      ],
      [
        p("run-log-model"),
        [
          [
            "reconnect() {\n        this.online = true;",
            "reconnect() {\n        this.following = true; this.online = true;",
          ],
        ],
        "reconnect stays paused",
      ],
      [
        p("run-routes"),
        [
          [
            'readFileSync(new URL("./browser/run-log-client.js", import.meta.url), "utf8")',
            '""',
          ],
        ],
        "local browser bundle",
      ],
    ];
try {
  for (const name of [
    "fleet-control-plane",
    "management-protocol",
    "management-agent",
  ]) {
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
  for (const name of readdirSync(join(repository, "packages"))) {
    const copied = [
      "fleet-control-plane",
      "management-protocol",
      "management-agent",
    ].includes(name);
    symlinkSync(
      join(copied ? root : repository, "packages", name),
      join(root, "node_modules/@gh-symphony", name),
      "dir"
    );
  }
  mkdirSync(join(root, "e2e"));
  for (const file of [
    "fleet-runs-fixture.mjs",
    "fleet-runs-e2e.mjs",
    "fleet-runs-browser.mjs",
  ])
    cpSync(join(repository, "e2e", file), join(root, "e2e", file));
  for (const [file, replacements, label] of cases) {
    if (process.env.MUTATION_ONLY && label !== process.env.MUTATION_ONLY)
      continue;
    const path = join(root, file);
    const original = readFileSync(path, "utf8");
    let mutated = original;
    for (const [from, to] of replacements) {
      assert.ok(mutated.includes(from), label + ": mutation target exists");
      mutated = mutated.replace(from, to);
    }
    writeFileSync(path, mutated);
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(
            root,
            "e2e",
            browser ? "fleet-runs-browser.mjs" : "fleet-runs-e2e.mjs"
          ),
        ],
        {
          encoding: "utf8",
          timeout: 45000,
          cwd: repository,
          env: { ...process.env, EVIDENCE_DIR: join(root, "evidence") },
        }
      );
      assert.equal(
        result.signal,
        null,
        label + ": no crash/timeout\n" + result.stdout + result.stderr
      );
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
        label +
          ": assertion failed, not startup\n" +
          result.stdout +
          result.stderr
      );
      console.log("probe passed: " + label);
    } finally {
      writeFileSync(path, original);
    }
  }
  console.log(
    "C18 " +
      (browser ? "browser" : "HTTPS") +
      " copied-artifact mutations passed"
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
