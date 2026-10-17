import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

describe("Claude Docker runner failure evidence", () => {
  it("permits workflow hooks on the Codex workspace tmpfs", () => {
    const compose = readFileSync(join(root, "docker-compose.e2e.yml"), "utf8");
    const mount = compose
      .split("\n")
      .find((line) => line.trim().startsWith("- /e2e/work:"));
    const options = mount?.split(":")[1].split(",");
    expect(options).toContain("exec");
    expect(options).not.toContain("noexec");
  });
  it.each(["health", "refresh", "state", "success", "diagnostics-down"])(
    "retains evidence and cleans up for %s",
    (mode) => {
      const dir = mkdtempSync(join(tmpdir(), "symphony-runner-"));
      try {
        for (const folder of [
          "test/e2e/claude",
          "e2e/lib",
          "e2e/fixtures",
          "bin",
        ]) {
          mkdirSync(join(dir, folder), { recursive: true });
        }
        for (const file of [
          "test/e2e/claude/run-docker-e2e.sh",
          "e2e/lib/compose-project.sh",
        ]) {
          copyFileSync(join(root, file), join(dir, file));
        }
        writeFileSync(join(dir, "e2e/fixtures/happy-path.json"), "[]");
        writeFileSync(
          join(dir, "bin/docker"),
          `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RUNNER_CALLS"
if [ "$1" = info ] || [ "$2" = version ]; then exit 0; fi
if [ "$1" = inspect ]; then
  echo '{"OOMKilled":true,"ExitCode":137,"Error":"resource failure"}'
  exit 0
fi
if [ "$1" = stats ]; then echo 'memory snapshot'; exit 0; fi
if [ "$1" = events ]; then echo 'oom event'; exit 0; fi
if [ "$1" = image ]; then exit 0; fi
shift 5
case "$1" in
  ps)
    if [ "\${2:-}" = --all ]; then echo container-id; fi
    ;;
  logs)
    echo 'container log'
    [ "$RUNNER_MODE" != diagnostics-down ] || exit 1
    ;;
  exec)
    phase=state
    case "\${!#}" in
      */healthz) phase=health ;;
      */refresh) phase=refresh ;;
    esac
    if [ "$RUNNER_MODE" = "$phase" ] || { [ "$RUNNER_MODE" = diagnostics-down ] && [ "$phase" = health ]; }; then
      echo "injected $phase exec failure" >&2
      if [ "$phase" = refresh ]; then exit 128; else exit 137; fi
    fi
    echo '{"summary":{"activeRuns":1},"activeRuns":[{}]}'
    ;;
esac
`,
          { mode: 0o755 }
        );
        const result = spawnSync(
          "bash",
          [join(dir, "test/e2e/claude/run-docker-e2e.sh")],
          {
            cwd: root,
            env: {
              ...process.env,
              PATH: `${dir}/bin:${process.env.PATH}`,
              RUNNER_CALLS: join(dir, "calls"),
              RUNNER_MODE: mode,
              GH_SYMPHONY_HTTP_TOKEN: "secret-canary",
            },
            encoding: "utf8",
            timeout: 10_000,
          }
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(mode === "success" ? 0 : 1);
        const calls = readFileSync(join(dir, "calls"), "utf8");
        const lines = calls.trim().split("\n");
        const builds = lines
          .map((line, index) => (line.endsWith(" build") ? index : -1))
          .filter((index) => index >= 0);
        expect(builds).toHaveLength(2);
        expect(builds[1]).toBeLessThan(
          lines.findIndex((line) => line.includes(" up "))
        );
        expect(lines.filter((line) => line.includes(" down "))).toHaveLength(2);
        expect(
          readFileSync(join(dir, "e2e/fixtures/issues.json"), "utf8").trim()
        ).toBe("[]");
        const evidence = join(
          dir,
          "evidence",
          readdirSync(join(dir, "evidence"))[0]
        );
        const operations = readFileSync(
          join(evidence, "codex-operations.log"),
          "utf8"
        );
        if (mode === "success") {
          expect(operations).toContain("state=0");
          expect(calls).not.toContain("inspect");
        } else {
          const phase = mode === "diagnostics-down" ? "health" : mode;
          expect(operations).toContain(
            `${phase}=${phase === "refresh" ? 128 : 137}`
          );
          expect(
            readFileSync(join(evidence, `${phase}-error.log`), "utf8")
          ).toContain(`injected ${phase} exec failure`);
          expect(result.stderr).toContain("Docker E2E diagnostics:");
          expect(
            readFileSync(join(evidence, `codex-${phase}-state.json`), "utf8")
          ).toContain('"OOMKilled":true');
          for (const label of ["codex", "claude"]) {
            expect(
              readFileSync(join(evidence, `${label}-state.json`), "utf8")
            ).toContain('"OOMKilled":true');
            expect(
              readFileSync(join(evidence, `${label}-container.log`), "utf8")
            ).toContain("container log");
            expect(
              readFileSync(join(evidence, `${label}-stats.log`), "utf8")
            ).toContain("memory snapshot");
          }
          expect(
            readFileSync(join(evidence, "codex-events.log"), "utf8")
          ).toContain("oom event");
          expect(
            lines.findIndex((line) => line.startsWith("inspect"))
          ).toBeLessThan(lines.findIndex((line) => line.includes(" down ")));
        }
        for (const file of readdirSync(evidence)) {
          expect(readFileSync(join(evidence, file), "utf8")).not.toContain(
            "secret-canary"
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
