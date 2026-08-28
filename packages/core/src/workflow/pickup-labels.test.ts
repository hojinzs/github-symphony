import { describe, expect, it } from "vitest";
import type {
  OrchestratorProjectConfig,
  TrackedIssue,
} from "@gh-symphony/core";
import {
  filterIssuesByPickupLabels,
  resolvePickupLabelDispatchReason,
} from "./pickup-labels.js";

const project = {
  tracker: {
    adapter: "file" as const,
    bindingId: "test",
    settings: { pickupLabels: { include: ["alpha"], exclude: ["blocked"] } },
  },
} as Pick<OrchestratorProjectConfig, "tracker">;

function issue(labels: string[]): TrackedIssue {
  return {
    id: labels.join("-") || "unlabeled",
    identifier: `acme/repo#${labels.join("-") || "1"}`,
    number: 1,
    title: "Test issue",
    description: null,
    priority: null,
    state: "Ready",
    branchName: null,
    url: null,
    labels,
    dispatchable: true,
    assigneeId: null,
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    repository: { owner: "acme", name: "repo", cloneUrl: "" },
    tracker: { adapter: "file", bindingId: "test", itemId: "test" },
    metadata: {},
  };
}

describe("resolvePickupLabelDispatchReason", () => {
  it("shares exclude-first pickup policy with filtering", () => {
    const included = issue(["alpha"]);
    const excluded = issue(["alpha", "blocked"]);
    const missing = issue([]);

    expect(resolvePickupLabelDispatchReason(included, project)).toBeNull();
    expect(resolvePickupLabelDispatchReason(excluded, project)).toBe(
      'Issue has excluded pickup label "blocked".'
    );
    expect(resolvePickupLabelDispatchReason(missing, project)).toBe(
      "Issue is missing a required pickup label (alpha)."
    );
    expect(
      filterIssuesByPickupLabels([included, excluded, missing], project)
    ).toEqual([included]);
  });

  it("normalizes both configured and tracker labels", () => {
    const mixedCaseProject = {
      tracker: {
        adapter: "file" as const,
        bindingId: "test",
        settings: {
          pickupLabels: {
            include: [" Agent ", "agent", ""],
            exclude: [" BLOCKED "],
          },
        },
      },
    } as Pick<OrchestratorProjectConfig, "tracker">;

    expect(
      resolvePickupLabelDispatchReason(issue(["  AGENT  "]), mixedCaseProject)
    ).toBeNull();
    expect(
      resolvePickupLabelDispatchReason(
        issue(["agent", "blocked"]),
        mixedCaseProject
      )
    ).toBe('Issue has excluded pickup label "BLOCKED".');
  });
});
