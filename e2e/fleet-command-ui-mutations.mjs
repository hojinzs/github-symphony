// Forbidden outcomes in copied production artifacts; checkout is never mutated.
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
const root = mkdtempSync(join(tmpdir(), "c17-probes-"));
const browser = process.argv.includes("--browser");
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
  for (const name of ["harness", "e2e", "browser"])
    cpSync(
      join(repository, `e2e/fleet-command-ui-${name}.mjs`),
      join(root, `e2e/fleet-command-ui-${name}.mjs`)
    );
  const cases = browser
    ? [
        [
          "command-browser",
          "cancel?.focus();",
          "dialog.querySelector('button')?.focus();",
          "modal initial focus",
        ],
        [
          "command-browser",
          "dialog.showModal();",
          "dialog.setAttribute('open','');",
          "modal focus containment",
        ],
        [
          "command-browser",
          "if(cancel)location.assign(cancel.href);",
          "/* no cancel navigation */",
          "escape restores action focus",
        ],
        [
          "command-browser",
          "!reason.value.trim()",
          "false",
          "inline reason validation",
        ],
        [
          "command-browser",
          "if(status)status.textContent=",
          "if(false)status.textContent=",
          "submission announcement",
        ],
        [
          "command-routes",
          '"Referrer-Policy": "same-origin"',
          '"Referrer-Policy": "no-referrer"',
          "native form CSRF",
        ],
        [
          "project-styles",
          ":root{",
          ":root{min-width:2000px;",
          "responsive layouts",
        ],
        [
          "project-pages",
          "/fleet-assets/imgOhMySymphonyMark.svg",
          "/fleet-assets/missing.svg",
          "local asset geometry",
        ],
        [
          "project-styles",
          ".command-dialog:not([open])",
          ".command-dialog[aria-labelledby=closure-title]{max-width:none;min-width:2000px}.command-dialog:not([open])",
          "closure responsive layout",
        ],
        [
          "command-pages",
          "#closure-reason",
          "#missing-reason",
          "closure focus return",
        ],
        [
          "command-pages",
          `reason ? ' disabled aria-describedby="eligibility-reason"' : ""`,
          `false ? ' disabled aria-describedby="eligibility-reason"' : ""`,
          "browser stale disabled",
        ],
        [
          "command-routes",
          "if (reason)",
          "if (false && reason)",
          "backend rejection",
        ],
        [
          "command-routes",
          'role="alert"',
          'role="status"',
          "browser failure alert",
        ],
      ]
    : [
        [
          "command-pages",
          "Stopping interrupts active runs",
          "No interruption",
          "stop impact",
        ],
        [
          "command-routes",
          "const session = browser.issueSession();",
          'if(projectMatch) await commands.submitCommand(id,"forbidden-get",{operation:"stop"}); const session = browser.issueSession();',
          "inert GET",
        ],
        [
          "command-routes",
          "browser.resolveActor({ ...request, csrfToken: body.csrf });",
          "/* no auth */",
          "CSRF fence",
        ],
        [
          "command-routes",
          "response(303,",
          "response(200,",
          "accepted redirect",
        ],
        [
          "command-pages",
          "${e(p.process)} · ${e(p.connection)}",
          "stopped · ${e(p.connection)}",
          "independent pending observation",
        ],
        [
          "command-pages",
          `reason ? ' disabled aria-describedby="eligibility-reason"' : ""`,
          `false ? ' disabled aria-describedby="eligibility-reason"' : ""`,
          "stale eligibility",
        ],
        ...[
          "accepted",
          "executing",
          "succeeded",
          "failed",
          "expired",
          "unknown",
        ].map((state) => [
          "command-pages",
          "${e(command.state)}",
          '${e(command.localProjectId === "' +
            state +
            '" ? "wrong" : command.state)}',
          "outcome " + state,
        ]),
        [
          "command-pages",
          "replacement process was not stopped by this command",
          "replacement process was stopped",
          "superseded safety",
        ],
        [
          "command-pages",
          '<h2 id="recovery-title">Outcome unknown</h2>',
          '<h2 id="recovery-title">Outcome unknown</h2><button>Retry</button>',
          "unknown no replay",
        ],
        [
          "command-routes",
          "const review = reviews.get(body.review);",
          "const review = reviews.get(body.review) ?? {commandId:id,reason:closure.reason,csrf:body.csrf,cookie:request.cookie,expires:now()+300000};",
          "second confirmation fence",
        ],
        [
          "command-routes",
          "reason: body.reason,",
          'reason: body.reason.trim() || "forbidden blank",',
          "required reason",
        ],
        [
          "command-routes",
          "const review = randomUUID();",
          "await commands.closeUnresolved(id,closure); const review = randomUUID();",
          "review is inert",
        ],
        [
          "command-routes",
          "await commands.closeUnresolved(id, closure);",
          "/* dropped closure */",
          "durable unknown closure",
        ],
        [
          "command-pages",
          " · closed unresolved",
          " · resolved",
          "retained history",
        ],
        [
          "commands",
          '!target.valid && request.operation === "start"',
          "!target.valid",
          "invalid workflow stop",
        ],
        [
          "command-routes",
          "Inspect command history before submitting any new intent",
          "Retry immediately",
          "ambiguous response guidance",
        ],
      ];
  for (const [name, from, to, label] of cases.filter(
    (c) => !process.env.C17_PROBE || c[3] === process.env.C17_PROBE
  )) {
    const path = join(root, "packages/fleet-control-plane/dist", name + ".js");
    const original = readFileSync(path, "utf8");
    // Asset URL is composed by icon(), so mutate its callsite instead.
    const source =
      name === "project-pages" && label === "local asset geometry"
        ? 'icon("imgOhMySymphonyMark")'
        : from;
    const replacement =
      label === "local asset geometry" ? 'icon("missing")' : to;
    assert.ok(original.includes(source), "mutation target: " + label);
    writeFileSync(path, original.replaceAll(source, replacement));
    try {
      const result = spawnSync(
        process.execPath,
        [join(root, `e2e/fleet-command-ui-${browser ? "browser" : "e2e"}.mjs`)],
        {
          cwd: repository,
          env: { ...process.env, C17_EVIDENCE: "", C17_ASSERTION: label },
          encoding: "utf8",
          timeout: 90000,
        }
      );
      assert.equal(result.signal, null, label + ": no timeout");
      assert.notEqual(
        result.status,
        0,
        label + ": forbidden condition rejected"
      );
      assert.ok(
        result.stdout.includes("reached: " + label),
        label + ": assertion reached\n" + result.stdout + result.stderr
      );
      assert.ok(
        result.stderr.includes("AssertionError"),
        label + ": assertion failure\n" + result.stderr
      );
      console.log("probe passed: " + label);
    } finally {
      writeFileSync(path, original);
    }
  }
  console.log(`C17 ${browser ? "browser" : "HTTPS"} artifact probes passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
