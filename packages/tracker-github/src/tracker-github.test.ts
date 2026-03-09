import { describe, expect, it } from "vitest";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "@github-symphony/core";
import { resolveTrackerAdapter } from "./orchestrator-adapter.js";
import {
  validateWorkflowFieldMapping,
  detectDuplicatePlacements,
  detectTransferRebindRequired,
} from "./validation.js";

describe("resolveTrackerAdapter", () => {
  it("returns an adapter for github-project", () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
    });

    expect(adapter).toBeDefined();
    expect(adapter.listIssues).toBeTypeOf("function");
    expect(adapter.buildWorkerEnvironment).toBeTypeOf("function");
    expect(adapter.reviveIssue).toBeTypeOf("function");
  });

  it("throws for unsupported tracker adapters", () => {
    expect(() =>
      resolveTrackerAdapter({
        adapter: "jira",
        bindingId: "board-1",
      })
    ).toThrow("Unsupported tracker adapter: jira");
  });
});

describe("validateWorkflowFieldMapping", () => {
  it("returns valid when all lifecycle states are present", () => {
    const result = validateWorkflowFieldMapping({
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
      availableOptions: [
        "Todo",
        "Needs Plan",
        "Human Review",
        "Approved",
        "Ready to Implement",
        "Await Merge",
        "Done",
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("reports missing options", () => {
    const result = validateWorkflowFieldMapping({
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
      availableOptions: ["Todo", "Done"],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.expectedState === "Human Review")).toBe(
      true
    );
  });

  it("matches case-insensitively", () => {
    const result = validateWorkflowFieldMapping({
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
      availableOptions: [
        "todo",
        "needs plan",
        "human review",
        "approved",
        "ready to implement",
        "await merge",
        "done",
      ],
    });

    expect(result.valid).toBe(true);
  });
});

describe("detectDuplicatePlacements", () => {
  const makeIssue = (id: string, identifier: string, itemId: string) => ({
    id,
    identifier,
    number: 1,
    title: "Test",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    repository: {
      owner: "acme",
      name: "platform",
      url: "https://github.com/acme/platform",
      cloneUrl: "https://github.com/acme/platform.git",
    },
    tracker: {
      adapter: "github-project" as const,
      bindingId: "project-123",
      itemId,
    },
    phase: "planning" as const,
    metadata: {},
  });

  it("returns empty when no duplicates exist", () => {
    const result = detectDuplicatePlacements([
      makeIssue("issue-1", "acme/platform#1", "item-1"),
      makeIssue("issue-2", "acme/platform#2", "item-2"),
    ]);

    expect(result).toHaveLength(0);
  });

  it("detects duplicate placements for the same issue", () => {
    const result = detectDuplicatePlacements([
      makeIssue("issue-1", "acme/platform#1", "item-1"),
      makeIssue("issue-1", "acme/platform#1", "item-2"),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.issueId).toBe("issue-1");
    expect(result[0]?.duplicateItemIds).toEqual(["item-1", "item-2"]);
  });
});

describe("detectTransferRebindRequired", () => {
  const makeIssue = (owner: string, name: string) => ({
    id: "issue-1",
    identifier: `${owner}/${name}#1`,
    number: 1,
    title: "Test",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    repository: {
      owner,
      name,
      url: `https://github.com/${owner}/${name}`,
      cloneUrl: `https://github.com/${owner}/${name}.git`,
    },
    tracker: {
      adapter: "github-project" as const,
      bindingId: "project-123",
      itemId: "item-1",
    },
    phase: "planning" as const,
    metadata: {},
  });

  it("returns null when issue matches the known alias", () => {
    const result = detectTransferRebindRequired(makeIssue("acme", "platform"), {
      owner: "acme",
      name: "platform",
    });

    expect(result).toBeNull();
  });

  it("detects a transfer when repository changed", () => {
    const result = detectTransferRebindRequired(makeIssue("acme", "new-repo"), {
      owner: "acme",
      name: "old-repo",
    });

    expect(result).not.toBeNull();
    expect(result?.previousRepository).toEqual({
      owner: "acme",
      name: "old-repo",
    });
    expect(result?.currentRepository).toEqual({
      owner: "acme",
      name: "new-repo",
    });
  });
});
