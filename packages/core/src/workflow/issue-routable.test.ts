import { describe, expect, it } from "vitest";
import type { TrackedIssue } from "../contracts/tracker-adapter.js";
import { issueRoutable } from "./issue-routable.js";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "./lifecycle.js";

function issue(input: Partial<TrackedIssue>): TrackedIssue {
  return {
    id: "1",
    identifier: "acme/repo#1",
    title: "Test issue",
    description: null,
    priority: null,
    state: "Ready",
    branchName: null,
    url: null,
    labels: [],
    dispatchable: true,
    assigneeId: null,
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    repository: { owner: "acme", name: "repo", cloneUrl: "" },
    tracker: { adapter: "file", bindingId: "test" },
    metadata: {},
    ...input,
  };
}

describe("issueRoutable", () => {
  it("matches required labels case-insensitively after trimming", () => {
    expect(
      issueRoutable(issue({ labels: [" Ready ", "AGENT"] }), {
        ...DEFAULT_WORKFLOW_LIFECYCLE,
        requiredLabels: ["ready", " agent "],
      })
    ).toEqual({ routable: true });
  });

  it("preserves empty required labels as unsatisfied", () => {
    expect(
      issueRoutable(issue({ labels: ["ready", "  "] }), {
        ...DEFAULT_WORKFLOW_LIFECYCLE,
        requiredLabels: ["ready", ""],
      })
    ).toEqual({
      routable: false,
      reason: 'Issue is missing required labels ("").',
    });
  });

  it("prioritizes a non-dispatchable issue over required-label checks", () => {
    expect(
      issueRoutable(
        issue({ dispatchable: false, dispatchReason: "Archived issue." }),
        { ...DEFAULT_WORKFLOW_LIFECYCLE, requiredLabels: ["ready"] }
      )
    ).toEqual({ routable: false, reason: "Archived issue." });
  });
});
