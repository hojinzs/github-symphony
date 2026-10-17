// Mutate isolated compiled production artifacts; require the named assertion to fail.
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
const root = mkdtempSync(join(tmpdir(), "c15-mutations-"));
const browserMode = process.argv.includes("--browser");
const cases = browserMode
  ? [
      [
        "create initial focus",
        [
          [
            "environment-browser",
            'content.querySelector("input")?.focus();',
            'content.querySelector("button")?.focus();',
          ],
        ],
      ],
      [
        "invalid name recovery",
        [
          [
            "environment-browser",
            'name.setAttribute("aria-invalid","true");',
            'name.setAttribute("aria-invalid","false");',
          ],
        ],
      ],
      [
        "browser token separation",
        [["environment-pages", "Copy token", "Copy credential"]],
      ],
      [
        "clipboard success",
        [
          [
            "environment-browser",
            "Setup command copied. Paste into the host terminal.",
            "Copy complete",
          ],
        ],
      ],
      [
        "clipboard failure manual fallback",
        [
          [
            "environment-browser",
            "source.select();",
            "source.setSelectionRange(0,0);",
          ],
        ],
      ],
      [
        "modal focus containment",
        [["environment-browser", 'if(event.key!=="Tab")return;', "return;"]],
      ],
      [
        "close clears secret and restores focus",
        [
          [
            "environment-browser",
            'content.replaceChildren();feedback.textContent="";',
            'feedback.textContent="";',
          ],
        ],
      ],
      [
        "browser reopen secret absent",
        [
          [
            "environment-pages",
            "The environment is saved.",
            "The environment is saved.",
          ],
        ],
      ],
      [
        "expired secret removed",
        [["environment-browser", "Date.parse(expiry)>Date.now()", "true"]],
      ],
      [
        "automatic enrollment transition",
        [
          [
            "environment-browser",
            "data.stage!==current",
            'data.stage!=="awaiting-signal"&&data.stage!==current',
          ],
        ],
      ],
      [
        "automatic zero project success",
        [["environment-pages", " · No projects yet", " · Projects pending"]],
      ],
      [
        "browser error preserves environment",
        [
          [
            "environment-browser",
            "Unable to check connection. Try again; saved environment is preserved.",
            "Connection status unknown",
          ],
        ],
      ],
      [
        "browser revocation",
        [
          [
            "environment-presentation",
            "Local execution continues.",
            "Execution status unavailable.",
          ],
        ],
      ],
      [
        "responsive scenes 390",
        [
          [
            "environment-styles",
            "width:calc(100% - 32px)",
            "width:900px;min-width:900px",
          ],
        ],
      ],
      [
        "browser regenerate fences token",
        [
          [
            "enrollment",
            "DO UPDATE SET verifier = excluded.verifier, expires_at = excluded.expires_at",
            "DO NOTHING",
          ],
        ],
      ],
      [
        "keyboard revoke confirmation",
        [
          [
            "environment-browser",
            "input,select,summary,textarea,[tabindex]",
            "input,select,textarea,[tabindex]",
          ],
        ],
      ],
      ...[1440, 1024].map((width) => [
        "responsive scenes " + width,
        [
          [
            "environment-styles",
            "max-width:720px",
            "max-width:1900px;min-width:1800px",
          ],
        ],
      ]),
      ...[1440, 1024, 390].map((width) => [
        "local asset geometry " + width,
        [["environment-routes", '"image/svg+xml"', '"text/plain"']],
      ]),
      [
        "create errors have no inert retry",
        [["environment-browser", "!error||(dialog.open&&!active)", "!error"]],
      ],
      [
        "accessible row labels",
        [
          [
            "environment-styles",
            "display:block;position:absolute;width:1px;height:1px",
            "display:none;position:absolute;width:1px;height:1px",
          ],
        ],
      ],
      [
        "token field tab order",
        [
          [
            "environment-browser",
            "summary,textarea,[tabindex]",
            "summary,[tabindex]",
          ],
        ],
      ],
      [
        "row opener focus restored",
        [
          [
            "environment-browser",
            'document.getElementById(opener?.id)||document.getElementById("add-environment")',
            'document.getElementById("add-environment")',
          ],
        ],
      ],
    ]
  : [
      [
        "empty list",
        [["environment-pages", "No environments yet", "Environment directory"]],
      ],
      [
        "CSRF blocks creation",
        [
          [
            "environment-routes",
            "browser.resolveActor(request);",
            "void request;",
          ],
        ],
      ],
      [
        "escaped persisted record",
        [
          [
            "project-pages",
            "return String(value).replace(",
            "return String(value); void String(value).replace(",
          ],
        ],
      ],
      [
        "separate command and token",
        [["environment-pages", "Copy token", "Copy credential"]],
      ],
      [
        "CP20 restart reopen secret absent",
        [["environment-pages", "Generate new token", "Continue setup"]],
      ],
      [
        "old token fenced",
        [
          [
            "enrollment",
            "DO UPDATE SET verifier = excluded.verifier, expires_at = excluded.expires_at",
            "DO NOTHING",
          ],
        ],
      ],
      [
        "exchange awaits first signal",
        [
          [
            "environment-presentation",
            'const waiting = environment.connection === "awaiting-signal";',
            "const waiting = false;",
          ],
        ],
      ],
      [
        "enrolled cannot regenerate",
        [
          [
            "environment-routes",
            'record && record.enrollment !== "pending"',
            "false",
          ],
          ["enrollment", 'record.enrollment === "enrolled"', "false"],
        ],
      ],
      [
        "CP21 zero project success",
        [["environment-presentation", 'stage: "online"', 'stage: "offline"']],
      ],
      [
        "revoked access semantics",
        [
          [
            "environment-presentation",
            "Local execution continues.",
            "Execution status unavailable.",
          ],
        ],
      ],
      [
        "read error recovery",
        [
          [
            "environment-routes",
            "ERROR_HTTP_STATUS[error.code] : 500",
            "ERROR_HTTP_STATUS[error.code] : 200",
          ],
        ],
      ],
      [
        "read recovery succeeds",
        [
          [
            "environment-routes",
            "return json(200, { rows });",
            "return json(500, { rows });",
          ],
        ],
      ],
    ];
// The reopen probe must plant an actual previously issued secret in the read response.
if (browserMode) {
  const probe = cases.find(
    (item) => item[0] === "browser reopen secret absent"
  );
  probe[1] = [
    [
      "environment-browser",
      'content.replaceChildren();feedback.textContent="";',
      'window.forbiddenSecret=document.getElementById("enrollment-token")?.textContent;content.replaceChildren();feedback.textContent="";',
    ],
    [
      "environment-browser",
      "content.innerHTML=data.connection;",
      'content.innerHTML=data.connection+(window.forbiddenSecret||"");',
    ],
  ];
}
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
      join(repository, `e2e/fleet-environments-${name}.mjs`),
      join(root, `e2e/fleet-environments-${name}.mjs`)
    );
  for (const [label, changes] of cases) {
    const originals = new Map();
    try {
      for (const [name, from, to] of changes) {
        const path = join(
          root,
          "packages/fleet-control-plane/dist",
          name + ".js"
        );
        const source = readFileSync(path, "utf8");
        if (!originals.has(path)) originals.set(path, source);
        assert.ok(
          source.includes(from),
          label + ": mutation target exists: " + from
        );
        writeFileSync(path, source.replaceAll(from, to));
      }
      const result = spawnSync(
        process.execPath,
        [
          join(
            root,
            `e2e/fleet-environments-${browserMode ? "browser" : "e2e"}.mjs`
          ),
        ],
        {
          encoding: "utf8",
          timeout: 60000,
          cwd: repository,
          env: { ...process.env, C15_ASSERTION: label, C15_EVIDENCE: "" },
        }
      );
      assert.ok(
        result.signal === null &&
          result.status !== 0 &&
          result.stdout.includes("reached: " + label) &&
          result.stderr.includes("AssertionError"),
        label + ": must reach and fail\n" + result.stdout + result.stderr
      );
      console.log("probe passed: " + label);
    } finally {
      for (const [path, source] of originals) writeFileSync(path, source);
    }
  }
  console.log(
    `C15 ${browserMode ? "browser" : "HTTPS"} artifact mutations passed (${cases.length})`
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
