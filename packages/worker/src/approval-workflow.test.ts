import { describe, expect, it } from "vitest";
import {
  buildImplementationBranchName,
  buildPhaseMarker,
  buildPullRequestBody,
  executeStateGuard,
  hasMergedCompletionSignal,
  isIssueStillActionable
} from "./approval-workflow.js";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "./workflow-lifecycle.js";

describe("buildImplementationBranchName", () => {
  it("creates a deterministic branch name for issue re-entry", () => {
    expect(
      buildImplementationBranchName({
        number: 42,
        title: "Ship the approval-gated PR workflow"
      })
    ).toBe("symphony/issue-42-ship-the-approval-gated-pr-workflow");
  });
});

describe("buildPhaseMarker", () => {
  it("uses machine-readable markers for idempotent comments", () => {
    expect(buildPhaseMarker("planning", "issue-1")).toBe(
      "<!-- github-symphony:planning issue=issue-1 -->"
    );
  });
});

describe("buildPullRequestBody", () => {
  it("links the PR merge back to the issue completion path", () => {
    expect(buildPullRequestBody(99, "Implement the worker lifecycle")).toContain("Fixes #99");
  });
});

describe("state safeguards", () => {
  it("stops work if an issue leaves the active state", () => {
    expect(() =>
      executeStateGuard("Plan Review", DEFAULT_WORKFLOW_LIFECYCLE)
    ).toThrow("Issue is no longer actionable");

    expect(
      isIssueStillActionable(
        "In Progress",
        DEFAULT_WORKFLOW_LIFECYCLE
      )
    ).toBe(true);
    expect(
      hasMergedCompletionSignal("Done", DEFAULT_WORKFLOW_LIFECYCLE)
    ).toBe(true);
  });
});
