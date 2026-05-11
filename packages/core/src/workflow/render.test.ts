import { describe, expect, it } from "vitest";
import {
  buildPromptVariables,
  renderContinuationGuidance,
  renderPrompt,
} from "./render.js";
import type { TrackedIssue } from "../contracts/tracker-adapter.js";

function createTrackedIssue(
  overrides: Partial<TrackedIssue> = {}
): TrackedIssue {
  return {
    id: "issue-1",
    identifier: "acme/platform#42",
    number: 42,
    title: "Fix the bug",
    description: "It crashes on startup",
    priority: null,
    state: "Ready",
    branchName: null,
    url: "https://github.com/acme/platform/issues/42",
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    repository: {
      owner: "acme",
      name: "platform",
      cloneUrl: "https://github.com/acme/platform.git",
      url: "https://github.com/acme/platform",
    },
    tracker: {
      adapter: "github-project",
      bindingId: "project-123",
      itemId: "item-1",
    },
    metadata: {},
    ...overrides,
  };
}

describe("buildPromptVariables", () => {
  it("keeps legacy issue prompts working and defaults content type to Issue", () => {
    const variables = buildPromptVariables(createTrackedIssue(), {
      attempt: null,
    });

    expect(variables.issue.content_type).toBe("Issue");
    expect(variables.issue.linked_pull_requests).toEqual([]);
    expect(variables.issue.primary_pull_request).toBeNull();
    expect(variables.issue.has_linked_pr).toBe(false);
    expect(variables.pull_request_context).toMatchObject({
      subject_type: "Issue",
      linked_pull_requests: [],
      primary_pull_request: null,
      has_linked_pr: false,
      has_primary_pr: false,
      checkout_branch: null,
      review_first: false,
    });
    expect(
      renderPrompt("Fix {{issue.title}} on {{issue.branch_name}}.", variables)
    ).toBe("Fix Fix the bug on .");
  });

  it("exposes linked pull request context to Liquid templates", () => {
    const variables = buildPromptVariables(
      createTrackedIssue({
        metadata: {
          contentType: "Issue",
          linkedPullRequests: [
            {
              id: "pr-1",
              number: 7,
              identifier: "acme/platform#7",
              url: "https://github.com/acme/platform/pull/7",
              state: "OPEN",
              projectState: "In review",
              isDraft: false,
              merged: false,
              headRefName: "fix/issue-42",
              baseRefName: "main",
              repository: {
                owner: "acme",
                name: "platform",
                url: "https://github.com/acme/platform",
                cloneUrl: "https://github.com/acme/platform.git",
              },
            },
          ],
        },
      }),
      { attempt: null }
    );

    const rendered = renderPrompt(
      [
        "type={{ issue.content_type }}",
        "has_pr={{ issue.has_linked_pr }}",
        "review_first={{ pull_request_context.review_first }}",
        "primary={{ issue.primary_pull_request.identifier }}",
        "branch={{ pull_request_context.checkout_branch }}",
        "base={{ pull_request_context.primary_pull_request.baseRefName }}",
        "{% for pr in issue.linked_pull_requests %}[{{ pr.number }}:{{ pr.state }}]{% endfor %}",
      ].join("\n"),
      variables
    );

    expect(rendered).toContain("type=Issue");
    expect(rendered).toContain("has_pr=true");
    expect(rendered).toContain("review_first=true");
    expect(rendered).toContain("primary=acme/platform#7");
    expect(rendered).toContain("branch=fix/issue-42");
    expect(rendered).toContain("base=main");
    expect(rendered).toContain("[7:OPEN]");
  });

  it("represents standalone pull request subjects with a primary pull request", () => {
    const variables = buildPromptVariables(
      createTrackedIssue({
        id: "pr-9",
        identifier: "acme/platform#9",
        number: 9,
        title: "Ship PR metadata",
        state: "Ready",
        branchName: "feature/pr-metadata",
        url: "https://github.com/acme/platform/pull/9",
        metadata: {
          contentType: "PullRequest",
        },
      }),
      { attempt: null }
    );

    expect(variables.issue.content_type).toBe("PullRequest");
    expect(variables.issue.has_linked_pr).toBe(false);
    expect(variables.pull_request_context).toMatchObject({
      subject_type: "PullRequest",
      has_linked_pr: false,
      has_primary_pr: true,
      checkout_branch: "feature/pr-metadata",
      review_first: true,
    });
    expect(variables.issue.primary_pull_request).toMatchObject({
      id: "pr-9",
      number: 9,
      identifier: "acme/platform#9",
      url: "https://github.com/acme/platform/pull/9",
      state: null,
      projectState: "Ready",
      headRefName: "feature/pr-metadata",
      baseRefName: null,
      isDraft: null,
      merged: null,
    });
    expect(
      renderPrompt(
        "draft={{ pull_request_context.primary_pull_request.isDraft }} base={{ pull_request_context.primary_pull_request.baseRefName }}",
        variables
      )
    ).toBe("draft= base=");
    expect(renderPrompt("branch={{ issue.branch_name }}", variables)).toBe(
      "branch=feature/pr-metadata"
    );
  });

  it("prefers the subject pull request over linked pull requests for pull request subjects", () => {
    const variables = buildPromptVariables(
      createTrackedIssue({
        id: "pr-9",
        identifier: "acme/platform#9",
        number: 9,
        title: "Ship PR metadata",
        state: "In review",
        branchName: "feature/pr-metadata",
        url: "https://github.com/acme/platform/pull/9",
        metadata: {
          contentType: "PullRequest",
          pullRequest: {
            id: "pr-9",
            number: 9,
            identifier: "acme/platform#9",
            url: "https://github.com/acme/platform/pull/9",
            state: "OPEN",
            projectState: "In review",
            headRefName: "feature/pr-metadata",
            baseRefName: "main",
          },
          linkedPullRequests: [
            {
              id: "pr-8",
              number: 8,
              identifier: "acme/platform#8",
              url: "https://github.com/acme/platform/pull/8",
              state: "OPEN",
              projectState: "Ready",
            },
          ],
        },
      }),
      { attempt: null }
    );

    expect(variables.issue.has_linked_pr).toBe(true);
    expect(variables.pull_request_context).toMatchObject({
      subject_type: "PullRequest",
      has_linked_pr: true,
      has_primary_pr: true,
      checkout_branch: "feature/pr-metadata",
      review_first: true,
    });
    expect(variables.issue.primary_pull_request).toMatchObject({
      id: "pr-9",
      identifier: "acme/platform#9",
      state: "OPEN",
      projectState: "In review",
    });
  });
});

describe("renderContinuationGuidance", () => {
  it("renders supported continuation variables", () => {
    expect(
      renderContinuationGuidance(
        "Continue after {{ cumulativeTurnCount }} turns. Summary: {{ lastTurnSummary }}",
        {
          cumulativeTurnCount: "3",
          lastTurnSummary: "Validated the workflow prompt.",
        }
      )
    ).toBe("Continue after 3 turns. Summary: Validated the workflow prompt.");
  });

  it("rejects Liquid tags", () => {
    expect(() =>
      renderContinuationGuidance(
        "{% if cumulativeTurnCount %}resume{% endif %}",
        {
          cumulativeTurnCount: "3",
          lastTurnSummary: "Validated the workflow prompt.",
        }
      )
    ).toThrow("continuation guidance does not support Liquid tags");
  });

  it("rejects unsupported variables", () => {
    expect(() =>
      renderContinuationGuidance("Issue {{ issue.title }}", {
        cumulativeTurnCount: "3",
        lastTurnSummary: "Validated the workflow prompt.",
      })
    ).toThrow("unsupported continuation guidance variable 'issue.title'");
  });
});
