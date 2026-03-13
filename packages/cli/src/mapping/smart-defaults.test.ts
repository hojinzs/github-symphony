import { describe, it, expect } from "vitest";
import {
  inferStateRole,
  inferAllStateRoles,
  toWorkflowLifecycleConfig,
  validateStateMapping,
} from "./smart-defaults.js";
import type { StateMapping } from "../config.js";

// ── 3.5: Smart defaults unit tests ──────────────────────────────────────────

describe("inferStateRole", () => {
  it("maps standard column names with high confidence", () => {
    expect(inferStateRole("Todo")).toEqual({
      columnName: "Todo",
      role: "active",
      confidence: "high",
    });
    expect(inferStateRole("In Progress")).toEqual({
      columnName: "In Progress",
      role: "active",
      confidence: "high",
    });
    expect(inferStateRole("In Review")).toEqual({
      columnName: "In Review",
      role: "wait",
      confidence: "high",
    });
    expect(inferStateRole("Done")).toEqual({
      columnName: "Done",
      role: "terminal",
      confidence: "high",
    });
    expect(inferStateRole("Backlog")).toEqual({
      columnName: "Backlog",
      role: "wait",
      confidence: "high",
    });
  });

  it("is case-insensitive", () => {
    expect(inferStateRole("TODO")).toMatchObject({ role: "active" });
    expect(inferStateRole("in progress")).toMatchObject({ role: "active" });
    expect(inferStateRole("DONE")).toMatchObject({ role: "terminal" });
  });

  it("returns null role for unknown column names", () => {
    expect(inferStateRole("Custom Stage")).toEqual({
      columnName: "Custom Stage",
      role: null,
      confidence: "low",
    });
    expect(inferStateRole("Stakeholder Sign-off")).toMatchObject({
      role: null,
      confidence: "low",
    });
  });

  it("handles variant spellings", () => {
    expect(inferStateRole("To Do")).toMatchObject({ role: "active" });
    expect(inferStateRole("To-Do")).toMatchObject({ role: "active" });
    expect(inferStateRole("Ready")).toMatchObject({ role: "active" });
    expect(inferStateRole("Queued")).toMatchObject({ role: "active" });
    expect(inferStateRole("Active")).toMatchObject({ role: "active" });
    expect(inferStateRole("WIP")).toMatchObject({ role: "active" });
    expect(inferStateRole("Needs Review")).toMatchObject({
      role: "wait",
    });
    expect(inferStateRole("PR Review")).toMatchObject({
      role: "wait",
    });
    expect(inferStateRole("Completed")).toMatchObject({ role: "terminal" });
    expect(inferStateRole("Merged")).toMatchObject({ role: "terminal" });
    expect(inferStateRole("Shipped")).toMatchObject({ role: "terminal" });
    expect(inferStateRole("Icebox")).toMatchObject({ role: "wait" });
    expect(inferStateRole("On Hold")).toMatchObject({ role: "wait" });
    expect(inferStateRole("Won't Do")).toMatchObject({ role: "terminal" });
  });
});

describe("inferAllStateRoles", () => {
  it("maps a minimal 3-column board", () => {
    const result = inferAllStateRoles(["Todo", "In Progress", "Done"]);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ role: "active" });
    expect(result[1]).toMatchObject({ role: "active" });
    expect(result[2]).toMatchObject({ role: "terminal" });
  });

  it("maps a detailed 7-column board", () => {
    const columns = [
      "Backlog",
      "Todo",
      "In Progress",
      "Plan Review",
      "In Review",
      "Done",
      "Icebox",
    ];
    const result = inferAllStateRoles(columns);
    expect(result).toEqual([
      { columnName: "Backlog", role: "wait", confidence: "high" },
      { columnName: "Todo", role: "active", confidence: "high" },
      { columnName: "In Progress", role: "active", confidence: "high" },
      { columnName: "Plan Review", role: "wait", confidence: "high" },
      { columnName: "In Review", role: "wait", confidence: "high" },
      { columnName: "Done", role: "terminal", confidence: "high" },
      { columnName: "Icebox", role: "wait", confidence: "high" },
    ]);
  });

  it("handles boards with custom/unknown names", () => {
    const columns = ["Requested", "Building", "QA", "Released"];
    const result = inferAllStateRoles(columns);
    // None of these are standard names, so all should be low confidence
    expect(result[0]).toMatchObject({ role: null, confidence: "low" });
    expect(result[1]).toMatchObject({ role: null, confidence: "low" });
    expect(result[2]).toMatchObject({ role: null, confidence: "low" });
    expect(result[3]).toMatchObject({ role: null, confidence: "low" });
  });
});

describe("toWorkflowLifecycleConfig", () => {
  it("produces a valid WorkflowLifecycleConfig from state mappings", () => {
    const mappings: Record<string, StateMapping> = {
      Todo: { role: "active" },
      "In Progress": { role: "active" },
      "Plan Review": { role: "wait" },
      Done: { role: "terminal" },
    };

    const config = toWorkflowLifecycleConfig("Status", mappings);
    expect(config.stateFieldName).toBe("Status");
    expect(config.activeStates).toEqual(["Todo", "In Progress"]);
    expect(config.terminalStates).toEqual(["Done"]);
    expect(config.blockerCheckStates).toEqual(["Todo"]);
  });

  it("produces correct config with only active and terminal states", () => {
    const mappings: Record<string, StateMapping> = {
      Todo: { role: "active" },
      "In Progress": { role: "active" },
      Done: { role: "terminal" },
    };

    const config = toWorkflowLifecycleConfig("Status", mappings);
    expect(config.activeStates).toEqual(["Todo", "In Progress"]);
    expect(config.terminalStates).toEqual(["Done"]);
    expect(config.blockerCheckStates).toEqual(["Todo"]);
  });
});

describe("validateStateMapping", () => {
  it("passes for a valid minimal mapping", () => {
    const mappings: Record<string, StateMapping> = {
      Todo: { role: "active" },
      "In Progress": { role: "active" },
      Done: { role: "terminal" },
    };
    const result = validateStateMapping(mappings);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails when active is missing", () => {
    const mappings: Record<string, StateMapping> = {
      Done: { role: "terminal" },
    };
    const result = validateStateMapping(mappings);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("active");
  });

  it("fails when terminal is missing", () => {
    const mappings: Record<string, StateMapping> = {
      Todo: { role: "active" },
      "In Progress": { role: "active" },
    };
    const result = validateStateMapping(mappings);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("terminal");
  });

  it("warns for multiple terminal states", () => {
    const mappings: Record<string, StateMapping> = {
      Todo: { role: "active" },
      "In Progress": { role: "active" },
      Done: { role: "terminal" },
      Cancelled: { role: "terminal" },
    };
    const result = validateStateMapping(mappings);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Multiple terminal");
  });

  it("passes for a full board with all roles", () => {
    const mappings: Record<string, StateMapping> = {
      Backlog: { role: "wait" },
      Todo: { role: "active" },
      "In Progress": { role: "active" },
      "Plan Review": { role: "wait" },
      "In Review": { role: "wait" },
      Done: { role: "terminal" },
      Icebox: { role: "wait" },
    };
    const result = validateStateMapping(mappings);
    expect(result.valid).toBe(true);
  });
});
