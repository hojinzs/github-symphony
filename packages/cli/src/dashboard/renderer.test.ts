import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDashboard } from "./renderer.js";
import { stripAnsi } from "../ansi.js";
import type { ProjectStatusSnapshot } from "@gh-symphony/core";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "__tests__/fixtures"
);

function loadFixture(name: string): ProjectStatusSnapshot {
  const raw = readFileSync(join(fixturesDir, `${name}.snapshot.json`), "utf8");
  return JSON.parse(raw) as ProjectStatusSnapshot;
}

function loadMultiProjectFixture(): ProjectStatusSnapshot[] {
  const raw = readFileSync(
    join(fixturesDir, "multi-project.snapshot.json"),
    "utf8"
  );
  return JSON.parse(raw) as ProjectStatusSnapshot[];
}

const NOW = new Date("2026-03-13T05:00:00Z").getTime();

describe("renderDashboard", () => {
  it("renders idle fixture without crashing and shows agent count", () => {
    const snapshot = loadFixture("idle");
    const output = renderDashboard([snapshot], {
      terminalWidth: 115,
      noColor: true,
      now: NOW,
    });
    expect(output).toContain("gh-symphony");
    expect(output).toContain("Agents");
  });

  it("renders busy fixture with column headers", () => {
    const snapshot = loadFixture("busy");
    const output = renderDashboard([snapshot], {
      terminalWidth: 115,
      noColor: true,
      now: NOW,
    });
    expect(output).toContain("ID");
    expect(output).toContain("STAGE");
    expect(output).toContain("PID");
    expect(output).toContain("AGE/TURN");
    expect(output).toContain("TOKENS");
    expect(output).toContain("SESSION");
    expect(output).toContain("EVENT");
  });

  it("noColor=true produces no ANSI escape sequences", () => {
    const snapshot = loadFixture("busy");
    const output = renderDashboard([snapshot], {
      terminalWidth: 115,
      noColor: true,
      now: NOW,
    });
    expect(output).not.toContain("\x1b[");
  });

  it("renders within terminal width when terminalWidth=80", () => {
    const snapshot = loadFixture("busy");
    const output = renderDashboard([snapshot], {
      terminalWidth: 80,
      noColor: true,
      now: NOW,
    });
    const lines = output.split("\n");
    for (const line of lines) {
      const visible = stripAnsi(line);
      expect(visible.length).toBeLessThanOrEqual(80);
    }
  });

  it("renders backoff queue with retry symbol", () => {
    const snapshot = loadFixture("backoff");
    const output = renderDashboard([snapshot], {
      terminalWidth: 115,
      noColor: true,
      now: NOW,
    });
    expect(output).toContain("Backoff Queue");
    expect(output).toContain("\u21BB");
  });

  it("renders multi-project fixture with multiple sections", () => {
    const snapshots = loadMultiProjectFixture();
    const output = renderDashboard(snapshots, {
      terminalWidth: 115,
      noColor: true,
      now: NOW,
    });
    expect(output).toContain("gh-symphony");
    const lines = output.split("\n");
    const sectionLines = lines.filter(
      (l) => l.includes("\u2500\u2500") && !l.includes("Backoff")
    );
    expect(sectionLines.length).toBeGreaterThanOrEqual(2);
  });
});
