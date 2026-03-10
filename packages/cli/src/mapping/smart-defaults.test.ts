import { describe, it, expect } from "vitest";
import {
  inferColumnRole,
  inferAllColumnRoles,
  buildPhaseMapping,
  toWorkflowLifecycleConfig,
  validateMapping,
} from "./smart-defaults.js";
import type { ColumnRole } from "../config.js";

// ── 3.5: Smart defaults unit tests ──────────────────────────────────────────

describe("inferColumnRole", () => {
  it("maps standard column names with high confidence", () => {
    expect(inferColumnRole("Todo")).toEqual({
      columnName: "Todo",
      role: "trigger",
      confidence: "high",
    });
    expect(inferColumnRole("In Progress")).toEqual({
      columnName: "In Progress",
      role: "working",
      confidence: "high",
    });
    expect(inferColumnRole("In Review")).toEqual({
      columnName: "In Review",
      role: "human-review",
      confidence: "high",
    });
    expect(inferColumnRole("Done")).toEqual({
      columnName: "Done",
      role: "done",
      confidence: "high",
    });
    expect(inferColumnRole("Backlog")).toEqual({
      columnName: "Backlog",
      role: "ignored",
      confidence: "high",
    });
  });

  it("is case-insensitive", () => {
    expect(inferColumnRole("TODO")).toMatchObject({ role: "trigger" });
    expect(inferColumnRole("in progress")).toMatchObject({ role: "working" });
    expect(inferColumnRole("DONE")).toMatchObject({ role: "done" });
  });

  it("returns null role for unknown column names", () => {
    expect(inferColumnRole("Custom Stage")).toEqual({
      columnName: "Custom Stage",
      role: null,
      confidence: "low",
    });
    expect(inferColumnRole("Stakeholder Sign-off")).toMatchObject({
      role: null,
      confidence: "low",
    });
  });

  it("handles variant spellings", () => {
    expect(inferColumnRole("To Do")).toMatchObject({ role: "trigger" });
    expect(inferColumnRole("To-Do")).toMatchObject({ role: "trigger" });
    expect(inferColumnRole("Ready")).toMatchObject({ role: "trigger" });
    expect(inferColumnRole("Queued")).toMatchObject({ role: "trigger" });
    expect(inferColumnRole("Active")).toMatchObject({ role: "working" });
    expect(inferColumnRole("WIP")).toMatchObject({ role: "working" });
    expect(inferColumnRole("Needs Review")).toMatchObject({
      role: "human-review",
    });
    expect(inferColumnRole("PR Review")).toMatchObject({
      role: "human-review",
    });
    expect(inferColumnRole("Completed")).toMatchObject({ role: "done" });
    expect(inferColumnRole("Merged")).toMatchObject({ role: "done" });
    expect(inferColumnRole("Shipped")).toMatchObject({ role: "done" });
    expect(inferColumnRole("Icebox")).toMatchObject({ role: "ignored" });
    expect(inferColumnRole("On Hold")).toMatchObject({ role: "ignored" });
    expect(inferColumnRole("Won't Do")).toMatchObject({ role: "ignored" });
  });
});

describe("inferAllColumnRoles", () => {
  it("maps a minimal 3-column board", () => {
    const result = inferAllColumnRoles(["Todo", "In Progress", "Done"]);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ role: "trigger" });
    expect(result[1]).toMatchObject({ role: "working" });
    expect(result[2]).toMatchObject({ role: "done" });
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
    const result = inferAllColumnRoles(columns);
    expect(result).toEqual([
      { columnName: "Backlog", role: "ignored", confidence: "high" },
      { columnName: "Todo", role: "trigger", confidence: "high" },
      { columnName: "In Progress", role: "working", confidence: "high" },
      { columnName: "Plan Review", role: "human-review", confidence: "high" },
      { columnName: "In Review", role: "human-review", confidence: "high" },
      { columnName: "Done", role: "done", confidence: "high" },
      { columnName: "Icebox", role: "ignored", confidence: "high" },
    ]);
  });

  it("handles boards with custom/unknown names", () => {
    const columns = ["Requested", "Building", "QA", "Released"];
    const result = inferAllColumnRoles(columns);
    // None of these are standard names, so all should be low confidence
    expect(result[0]).toMatchObject({ role: null, confidence: "low" });
    expect(result[1]).toMatchObject({ role: null, confidence: "low" });
    expect(result[2]).toMatchObject({ role: null, confidence: "low" });
    expect(result[3]).toMatchObject({ role: null, confidence: "low" });
  });
});

describe("buildPhaseMapping", () => {
  const roles: Record<string, ColumnRole> = {
    Todo: "trigger",
    "In Progress": "working",
    "Plan Review": "human-review",
    "In Review": "human-review",
    Done: "done",
    Backlog: "ignored",
  };

  it("maps plan-and-pr mode correctly", () => {
    const result = buildPhaseMapping(roles, "plan-and-pr");
    expect(result.planningStates).toEqual(["Todo"]);
    expect(result.humanReviewStates).toEqual(["Plan Review", "In Review"]);
    expect(result.implementationStates).toEqual(["In Progress"]);
    expect(result.completedStates).toEqual(["Done"]);
  });

  it("maps plan-only mode: review columns to humanReview", () => {
    const result = buildPhaseMapping(roles, "plan-only");
    expect(result.humanReviewStates).toEqual(["Plan Review", "In Review"]);
    expect(result.awaitingMergeStates).toEqual([]);
  });

  it("maps pr-only mode: review columns to awaitingMerge", () => {
    const result = buildPhaseMapping(roles, "pr-only");
    expect(result.humanReviewStates).toEqual([]);
    expect(result.awaitingMergeStates).toEqual(["Plan Review", "In Review"]);
  });

  it("maps none mode: review columns to implementation", () => {
    const result = buildPhaseMapping(roles, "none");
    expect(result.humanReviewStates).toEqual([]);
    expect(result.awaitingMergeStates).toEqual([]);
    expect(result.implementationStates).toContain("Plan Review");
    expect(result.implementationStates).toContain("In Review");
  });

  it("excludes ignored columns from all phases", () => {
    const result = buildPhaseMapping(roles, "plan-and-pr");
    const allStates = [
      ...result.planningStates,
      ...result.humanReviewStates,
      ...result.implementationStates,
      ...result.awaitingMergeStates,
      ...result.completedStates,
    ];
    expect(allStates).not.toContain("Backlog");
  });
});

describe("toWorkflowLifecycleConfig", () => {
  it("produces a valid WorkflowLifecycleConfig for plan-and-pr", () => {
    const roles: Record<string, ColumnRole> = {
      Todo: "trigger",
      "In Progress": "working",
      "Plan Review": "human-review",
      Done: "done",
    };

    const config = toWorkflowLifecycleConfig("Status", roles, "plan-and-pr");
    expect(config.stateFieldName).toBe("Status");
    expect(config.planningStates).toEqual(["Todo"]);
    expect(config.humanReviewStates).toEqual(["Plan Review"]);
    expect(config.implementationStates).toEqual(["In Progress"]);
    expect(config.completedStates).toEqual(["Done"]);
    expect(config.planningCompleteState).toBe("Plan Review");
    expect(config.implementationCompleteState).toBe("Done");
    expect(config.mergeCompleteState).toBe("Done");
  });

  it("produces correct transitions for none mode", () => {
    const roles: Record<string, ColumnRole> = {
      Todo: "trigger",
      "In Progress": "working",
      Done: "done",
    };

    const config = toWorkflowLifecycleConfig("Status", roles, "none");
    expect(config.humanReviewStates).toEqual([]);
    expect(config.awaitingMergeStates).toEqual([]);
    expect(config.planningCompleteState).toBe("In Progress");
    expect(config.implementationCompleteState).toBe("Done");
  });
});

describe("validateMapping", () => {
  it("passes for a valid minimal mapping", () => {
    const roles: Record<string, ColumnRole> = {
      Todo: "trigger",
      "In Progress": "working",
      Done: "done",
    };
    const result = validateMapping(roles);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails when trigger is missing", () => {
    const roles: Record<string, ColumnRole> = {
      "In Progress": "working",
      Done: "done",
    };
    const result = validateMapping(roles);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("trigger");
  });

  it("fails when working is missing", () => {
    const roles: Record<string, ColumnRole> = {
      Todo: "trigger",
      Done: "done",
    };
    const result = validateMapping(roles);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("working");
  });

  it("fails when done is missing", () => {
    const roles: Record<string, ColumnRole> = {
      Todo: "trigger",
      "In Progress": "working",
    };
    const result = validateMapping(roles);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("done");
  });

  it("warns for multiple trigger columns", () => {
    const roles: Record<string, ColumnRole> = {
      Todo: "trigger",
      Ready: "trigger",
      "In Progress": "working",
      Done: "done",
    };
    const result = validateMapping(roles);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Multiple trigger");
  });

  it("passes for a full board with all roles", () => {
    const roles: Record<string, ColumnRole> = {
      Backlog: "ignored",
      Todo: "trigger",
      "In Progress": "working",
      "Plan Review": "human-review",
      "In Review": "human-review",
      Done: "done",
      Icebox: "ignored",
    };
    const result = validateMapping(roles);
    expect(result.valid).toBe(true);
  });
});
