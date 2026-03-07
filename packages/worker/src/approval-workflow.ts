import {
  isWorkflowPhaseActionable,
  matchesWorkflowState,
  resolveWorkflowExecutionPhase,
  type WorkflowExecutionPhase,
  type WorkflowLifecycleConfig
} from "./workflow-lifecycle.js";

export type ApprovalWorkflowIssue = {
  id: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  projectId: string;
  projectItemId: string;
  repository: {
    owner: string;
    name: string;
    defaultBranch?: string | null;
  };
};

export type PlanningPhaseReport = {
  summary: string;
  steps: string[];
  risks?: string[];
  assumptions?: string[];
};

export type ImplementationPhaseReport = {
  summary: string;
  branchName?: string;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  validation?: string[];
  followUps?: string[];
};

export type ApprovalWorkflowComment = {
  id: string;
  body: string;
  url?: string | null;
};

export type ApprovalWorkflowPullRequest = {
  id: string;
  number: number;
  url: string;
  headBranch: string;
  title: string;
  body: string;
};

export type ApprovalWorkflowClient = {
  findIssueCommentByMarker(
    issueId: string,
    marker: string
  ): Promise<ApprovalWorkflowComment | null>;
  createIssueComment(issueId: string, body: string): Promise<ApprovalWorkflowComment>;
  updateIssueComment(commentId: string, body: string): Promise<ApprovalWorkflowComment>;
  updateProjectItemState(input: {
    projectId: string;
    projectItemId: string;
    fieldName: string;
    state: string;
  }): Promise<void>;
  findPullRequestByBranch(input: {
    owner: string;
    repository: string;
    branchName: string;
  }): Promise<ApprovalWorkflowPullRequest | null>;
  createPullRequest(input: {
    owner: string;
    repository: string;
    title: string;
    body: string;
    headBranch: string;
    baseBranch: string;
  }): Promise<ApprovalWorkflowPullRequest>;
  updatePullRequest(input: {
    pullRequestId: string;
    title: string;
    body: string;
  }): Promise<ApprovalWorkflowPullRequest>;
};

export type ApprovalWorkflowResult = {
  nextState: string;
  operations: string[];
  comment: ApprovalWorkflowComment;
  pullRequest?: ApprovalWorkflowPullRequest;
};

export function executePhaseGuard(
  state: string,
  phase: "planning" | "implementation",
  lifecycle: WorkflowLifecycleConfig
): void {
  const resolvedPhase = resolveWorkflowExecutionPhase(state, lifecycle);

  if (resolvedPhase !== phase || !isWorkflowPhaseActionable(resolvedPhase)) {
    throw new Error(
      `Issue is no longer actionable for ${phase}; current tracker phase is ${resolvedPhase}.`
    );
  }
}

export async function executePlanningPhase(
  input: {
    issue: ApprovalWorkflowIssue;
    lifecycle: WorkflowLifecycleConfig;
    report: PlanningPhaseReport;
  },
  client: ApprovalWorkflowClient
): Promise<ApprovalWorkflowResult> {
  executePhaseGuard(input.issue.state, "planning", input.lifecycle);

  const marker = buildPhaseMarker("planning", input.issue.id);
  const body = buildPlanningCommentBody(input.issue, input.report);
  const existingComment = await client.findIssueCommentByMarker(input.issue.id, marker);
  const comment = existingComment
    ? await client.updateIssueComment(existingComment.id, body)
    : await client.createIssueComment(input.issue.id, body);
  const operations = existingComment
    ? ["updated planning comment"]
    : ["posted planning comment"];

  if (!matchesWorkflowState(input.issue.state, input.lifecycle.humanReviewStates)) {
    await client.updateProjectItemState({
      projectId: input.issue.projectId,
      projectItemId: input.issue.projectItemId,
      fieldName: input.lifecycle.stateFieldName,
      state: input.lifecycle.planningCompleteState
    });
    operations.push(`transitioned item to ${input.lifecycle.planningCompleteState}`);
  }

  return {
    nextState: input.lifecycle.planningCompleteState,
    operations,
    comment
  };
}

export async function executeImplementationPhase(
  input: {
    issue: ApprovalWorkflowIssue;
    lifecycle: WorkflowLifecycleConfig;
    report: ImplementationPhaseReport;
  },
  client: ApprovalWorkflowClient
): Promise<ApprovalWorkflowResult> {
  executePhaseGuard(input.issue.state, "implementation", input.lifecycle);

  const branchName = input.report.branchName ?? buildImplementationBranchName(input.issue);
  const pullRequestTitle = input.report.pullRequestTitle ?? input.issue.title;
  const pullRequestBody = buildPullRequestBody(
    input.issue.number,
    input.report.summary,
    input.report.pullRequestBody
  );
  const existingPullRequest = await client.findPullRequestByBranch({
    owner: input.issue.repository.owner,
    repository: input.issue.repository.name,
    branchName
  });
  const pullRequest = existingPullRequest
    ? await client.updatePullRequest({
        pullRequestId: existingPullRequest.id,
        title: pullRequestTitle,
        body: pullRequestBody
      })
    : await client.createPullRequest({
        owner: input.issue.repository.owner,
        repository: input.issue.repository.name,
        title: pullRequestTitle,
        body: pullRequestBody,
        headBranch: branchName,
        baseBranch: input.issue.repository.defaultBranch ?? "main"
      });
  const operations = existingPullRequest
    ? ["updated pull request"]
    : ["created pull request"];
  const marker = buildPhaseMarker("implementation", input.issue.id);
  const commentBody = buildImplementationCommentBody(input.issue, input.report, pullRequest.url);
  const existingComment = await client.findIssueCommentByMarker(input.issue.id, marker);
  const comment = existingComment
    ? await client.updateIssueComment(existingComment.id, commentBody)
    : await client.createIssueComment(input.issue.id, commentBody);

  operations.push(existingComment ? "updated completion comment" : "posted completion comment");

  if (!matchesWorkflowState(input.issue.state, input.lifecycle.awaitingMergeStates)) {
    await client.updateProjectItemState({
      projectId: input.issue.projectId,
      projectItemId: input.issue.projectItemId,
      fieldName: input.lifecycle.stateFieldName,
      state: input.lifecycle.implementationCompleteState
    });
    operations.push(`transitioned item to ${input.lifecycle.implementationCompleteState}`);
  }

  return {
    nextState: input.lifecycle.implementationCompleteState,
    operations,
    comment,
    pullRequest
  };
}

export function buildPlanningCommentBody(
  issue: Pick<ApprovalWorkflowIssue, "id" | "title">,
  report: PlanningPhaseReport
): string {
  return [
    buildPhaseMarker("planning", issue.id),
    "## Plan Summary",
    "",
    report.summary,
    "",
    "## Proposed Steps",
    ...report.steps.map((step) => `- ${step}`),
    "",
    "## Risks",
    ...renderList(report.risks, "None noted."),
    "",
    "## Assumptions",
    ...renderList(report.assumptions, "None noted."),
    "",
    "Human approval is required before implementation starts."
  ].join("\n");
}

export function buildImplementationCommentBody(
  issue: Pick<ApprovalWorkflowIssue, "id">,
  report: ImplementationPhaseReport,
  pullRequestUrl: string
): string {
  return [
    buildPhaseMarker("implementation", issue.id),
    "## Delivery Summary",
    "",
    report.summary,
    "",
    `Pull request: ${pullRequestUrl}`,
    "",
    "## Validation",
    ...renderList(report.validation, "Validation not reported."),
    "",
    "## Follow-up",
    ...renderList(report.followUps, "No follow-up items.")
  ].join("\n");
}

export function buildPullRequestBody(
  issueNumber: number,
  summary: string,
  extraBody?: string
): string {
  return [`Fixes #${issueNumber}`, "", summary, ...(extraBody ? ["", extraBody] : [])].join("\n");
}

export function buildImplementationBranchName(
  issue: Pick<ApprovalWorkflowIssue, "number" | "title">
): string {
  const slug = issue.title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return `symphony/issue-${issue.number}-${slug || "change"}`;
}

export function buildPhaseMarker(
  phase: "planning" | "implementation",
  issueId: string
): string {
  return `<!-- github-symphony:${phase} issue=${issueId} -->`;
}

export function isIssueStillActionableForPhase(
  state: string,
  phase: "planning" | "implementation",
  lifecycle: WorkflowLifecycleConfig
): boolean {
  return resolveWorkflowExecutionPhase(state, lifecycle) === phase;
}

export function hasMergedCompletionSignal(
  state: string,
  lifecycle: WorkflowLifecycleConfig
): boolean {
  const phase = resolveWorkflowExecutionPhase(state, lifecycle);
  return phase === "completed" || matchesWorkflowState(state, [lifecycle.mergeCompleteState]);
}

function renderList(values: string[] | undefined, fallback: string): string[] {
  if (!values?.length) {
    return [`- ${fallback}`];
  }

  return values.map((value) => `- ${value}`);
}
