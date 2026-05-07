import {
  isStateActive,
  isStateTerminal,
  matchesWorkflowState,
  type IssueOrchestrationRecord,
  type OrchestratorRunRecord,
  type RepositoryRef,
  type TrackedIssue,
  type WorkflowLifecycleConfig,
} from "@gh-symphony/core";

export type DispatchExplainSeverity = "pass" | "warn" | "block";

export type DispatchExplainCheck = {
  id:
    | "repository_linked"
    | "project_item_present"
    | "workflow_state"
    | "blockers"
    | "runtime_ownership"
    | "dispatch_limits";
  status: DispatchExplainSeverity;
  message: string;
  details?: Record<string, unknown>;
  hint?: string;
};

export type DispatchExplainReport = {
  issue: {
    identifier: string;
    id: string | null;
    state: string | null;
    repository: string;
    title: string | null;
    url: string | null;
  };
  dispatchable: boolean;
  summary: string;
  checks: DispatchExplainCheck[];
};

export type ParsedIssueIdentifier = {
  owner: string;
  name: string;
  number: number;
};

export type ExplainDispatchInput = {
  identifier: string;
  issue: TrackedIssue | null;
  projectRepository: RepositoryRef | null;
  allIssues: readonly TrackedIssue[];
  lifecycle: WorkflowLifecycleConfig;
  issueRecords: readonly IssueOrchestrationRecord[];
  runs: readonly OrchestratorRunRecord[];
  activeRunCount: number;
  maxConcurrentAgents: number;
  maxConcurrentAgentsByState: Readonly<Record<string, number>>;
};

const MAX_FAILURE_RETRIES_EXCEEDED_REASON = "max_failure_retries_exceeded";

export function explainIssueDispatch(
  input: ExplainDispatchInput
): DispatchExplainReport {
  const parsed = parseIssueIdentifier(input.identifier);
  const repository = parsed
    ? `${parsed.owner}/${parsed.name}`
    : input.issue
      ? `${input.issue.repository.owner}/${input.issue.repository.name}`
      : "unknown";
  const issue = input.issue;
  const checks: DispatchExplainCheck[] = [];

  checks.push(explainRepositoryLinked(input.projectRepository, repository));
  checks.push(explainProjectItemPresent(input.identifier, issue));

  if (!issue) {
    const dispatchable = false;
    const blocking = checks.filter((check) => check.status === "block");
    const summary =
      blocking.length > 0
        ? `Not dispatchable: ${blocking[0]!.message}`
        : "Not dispatchable: the issue is not present in the managed GitHub Project item set.";
    return {
      issue: {
        identifier: input.identifier,
        id: null,
        state: null,
        repository,
        title: null,
        url: null,
      },
      dispatchable,
      summary,
      checks,
    };
  }

  checks.push(explainWorkflowState(issue, input.lifecycle));
  checks.push(explainBlockers(issue, input.lifecycle, input.allIssues));
  checks.push(explainRuntimeOwnership(issue, input.issueRecords, input.runs));
  checks.push(
    explainDispatchLimits(
      issue,
      input.runs,
      input.activeRunCount,
      input.maxConcurrentAgents,
      input.maxConcurrentAgentsByState
    )
  );

  const blocking = checks.filter((check) => check.status === "block");
  const dispatchable = blocking.length === 0;
  const summary = dispatchable
    ? "Dispatchable: no blocking project, workflow, runtime, or budget condition was found."
    : `Not dispatchable: ${blocking[0]!.message}`;

  return {
    issue: {
      identifier: issue.identifier,
      id: issue.id,
      state: issue.state,
      repository: `${issue.repository.owner}/${issue.repository.name}`,
      title: issue.title,
      url: issue.url,
    },
    dispatchable,
    summary,
    checks,
  };
}

export function isIssueCandidateEligibleWithReason(
  issue: TrackedIssue,
  lifecycle: WorkflowLifecycleConfig,
  issues: readonly TrackedIssue[]
): { eligible: boolean; reason: "inactive_state" | "blocked" | null } {
  if (!isStateActive(issue.state, lifecycle)) {
    return { eligible: false, reason: "inactive_state" };
  }

  if (!issueHasBlockingDependency(issue, lifecycle, issues)) {
    return { eligible: true, reason: null };
  }

  return { eligible: false, reason: "blocked" };
}

export function hasConvergenceLockedRunForIssue(
  runs: readonly OrchestratorRunRecord[],
  issueId: string,
  issueState: string,
  issueUpdatedAt: string | null | undefined
): OrchestratorRunRecord | null {
  const latestRun = latestRunForIssue(runs, issueId);

  if (
    latestRun?.runtimeSession?.exitClassification !== "convergence-detected" ||
    latestRun.issueState !== issueState
  ) {
    return null;
  }

  const convergedAtMs = parseTimestampMs(
    latestRun.completedAt ?? latestRun.updatedAt
  );
  const issueUpdatedAtMs = parseTimestampMs(issueUpdatedAt);
  if (convergedAtMs === null || issueUpdatedAtMs === null) {
    return latestRun;
  }

  return issueUpdatedAtMs <= convergedAtMs ? latestRun : null;
}

export function isIssueOrchestrationClaimedState(
  state: IssueOrchestrationRecord["state"]
): boolean {
  return state === "claimed" || state === "running" || state === "retry_queued";
}

export function isActiveRunRecordStatus(
  status: OrchestratorRunRecord["status"]
): boolean {
  return (
    status === "pending" ||
    status === "starting" ||
    status === "running" ||
    status === "retrying"
  );
}

function explainRepositoryLinked(
  projectRepository: RepositoryRef | null,
  repository: string
): DispatchExplainCheck {
  if (!projectRepository) {
    return {
      id: "repository_linked",
      status: "warn",
      message: "No repository is configured for the active managed project.",
      hint: "Run 'gh-symphony repo add <owner/name>' or re-run 'gh-symphony project add'.",
    };
  }

  const configured = `${projectRepository.owner}/${projectRepository.name}`;
  const linked =
    normalizeIdentifier(configured) === normalizeIdentifier(repository);
  return {
    id: "repository_linked",
    status: linked ? "pass" : "block",
    message: linked
      ? `Repository ${repository} is linked to the active managed project.`
      : `Repository ${repository} is not the active managed project repository (${configured}).`,
    details: { configuredRepository: configured, issueRepository: repository },
    hint: linked
      ? undefined
      : "Run 'gh-symphony repo add <owner/name>' or select the correct project with 'gh-symphony project switch'.",
  };
}

function explainProjectItemPresent(
  identifier: string,
  issue: TrackedIssue | null
): DispatchExplainCheck {
  return {
    id: "project_item_present",
    status: issue ? "pass" : "block",
    message: issue
      ? "Issue is present in the bound GitHub Project item set."
      : `Issue ${identifier} was not returned by the bound GitHub Project item set.`,
    details: issue ? { itemId: issue.tracker.itemId } : undefined,
    hint: issue
      ? undefined
      : "Add the issue to the GitHub Project or run 'gh-symphony project status' to confirm the active project.",
  };
}

function explainWorkflowState(
  issue: TrackedIssue,
  lifecycle: WorkflowLifecycleConfig
): DispatchExplainCheck {
  if (isStateActive(issue.state, lifecycle)) {
    return {
      id: "workflow_state",
      status: "pass",
      message: `Project state "${issue.state}" maps to an active state in WORKFLOW.md.`,
      details: { activeStates: lifecycle.activeStates },
    };
  }

  const role = isStateTerminal(issue.state, lifecycle) ? "terminal" : "wait";
  return {
    id: "workflow_state",
    status: "block",
    message: `Project state "${issue.state}" maps to ${role}, not active, in WORKFLOW.md.`,
    details: {
      activeStates: lifecycle.activeStates,
      terminalStates: lifecycle.terminalStates,
      blockerCheckStates: lifecycle.blockerCheckStates,
    },
    hint: "Move the GitHub Project item to an active state or run 'gh-symphony workflow preview' to inspect WORKFLOW.md state mappings.",
  };
}

function explainBlockers(
  issue: TrackedIssue,
  lifecycle: WorkflowLifecycleConfig,
  issues: readonly TrackedIssue[]
): DispatchExplainCheck {
  if (!matchesWorkflowState(issue.state, lifecycle.blockerCheckStates)) {
    return {
      id: "blockers",
      status: "pass",
      message: `Blocker checks do not apply to state "${issue.state}".`,
      details: { blockerCheckStates: lifecycle.blockerCheckStates },
    };
  }

  const blockers = unresolvedBlockers(issue, lifecycle, issues);
  if (blockers.length === 0) {
    return {
      id: "blockers",
      status: "pass",
      message: "No unresolved blockers prevent dispatch.",
      details: { blockedBy: issue.blockedBy },
    };
  }

  return {
    id: "blockers",
    status: "block",
    message: `Issue has ${blockers.length} unresolved blocker${blockers.length === 1 ? "" : "s"}.`,
    details: { blockers },
    hint: "Move blocker issues to a terminal state or update the blocker relationship in GitHub.",
  };
}

function explainRuntimeOwnership(
  issue: TrackedIssue,
  issueRecords: readonly IssueOrchestrationRecord[],
  runs: readonly OrchestratorRunRecord[]
): DispatchExplainCheck {
  const record = issueRecords.find(
    (candidate) =>
      candidate.issueId === issue.id ||
      candidate.identifier === issue.identifier
  );
  const latestRun = latestRunForIssue(runs, issue.id);
  const activeRun = runs.find(
    (run) => run.issueId === issue.id && isActiveRunRecordStatus(run.status)
  );

  if (activeRun) {
    return {
      id: "runtime_ownership",
      status: "block",
      message: `Existing ${activeRun.status} run ${activeRun.runId} already owns the issue.`,
      details: {
        runId: activeRun.runId,
        status: activeRun.status,
        retryKind: activeRun.retryKind,
        nextRetryAt: activeRun.nextRetryAt,
      },
      hint: "Run 'gh-symphony status' or 'gh-symphony logs --issue <owner/repo#number>' to inspect the current owner.",
    };
  }

  if (record && isIssueOrchestrationClaimedState(record.state)) {
    return {
      id: "runtime_ownership",
      status: "block",
      message: `Issue is already claimed by orchestration state "${record.state}".`,
      details: {
        state: record.state,
        currentRunId: record.currentRunId,
        retryEntry: record.retryEntry,
      },
      hint: "Run 'gh-symphony status' to inspect active and retrying work.",
    };
  }

  const convergenceRun = hasConvergenceLockedRunForIssue(
    runs,
    issue.id,
    issue.state,
    issue.updatedAt
  );
  if (convergenceRun) {
    return {
      id: "runtime_ownership",
      status: "block",
      message: `Latest run ${convergenceRun.runId} is convergence-locked for state "${issue.state}".`,
      details: {
        runId: convergenceRun.runId,
        completedAt: convergenceRun.completedAt,
        lastError: convergenceRun.lastError,
      },
      hint: "Update the GitHub Project item or issue activity to trigger a newer tracker timestamp after resolving the unchanged workspace diff.",
    };
  }

  if (
    record &&
    record.failureRetryCount > 0 &&
    latestRun?.status === "suppressed" &&
    latestRun.issueState === issue.state &&
    latestRun.lastError?.includes(MAX_FAILURE_RETRIES_EXCEEDED_REASON)
  ) {
    const issueUpdatedAtMs = parseTimestampMs(issue.updatedAt);
    const suppressedAtMs = parseTimestampMs(
      latestRun.completedAt ?? latestRun.updatedAt
    );
    if (
      issueUpdatedAtMs === null ||
      suppressedAtMs === null ||
      issueUpdatedAtMs <= suppressedAtMs
    ) {
      return {
        id: "runtime_ownership",
        status: "block",
        message:
          "Failure retry limit has suppressed redispatch for the current tracker state.",
        details: {
          failureRetryCount: record.failureRetryCount,
          runId: latestRun.runId,
          lastError: latestRun.lastError,
        },
        hint: "Fix the underlying failure and update the GitHub Project item or issue to create a newer tracker timestamp.",
      };
    }
  }

  return {
    id: "runtime_ownership",
    status: "pass",
    message:
      "No active run, retry, convergence lock, or suppression owns the issue.",
    details: record
      ? {
          orchestrationState: record.state,
          currentRunId: record.currentRunId,
          latestRunId: latestRun?.runId ?? null,
        }
      : undefined,
  };
}

function explainDispatchLimits(
  issue: TrackedIssue,
  runs: readonly OrchestratorRunRecord[],
  activeRunCount: number,
  maxConcurrentAgents: number,
  maxConcurrentAgentsByState: Readonly<Record<string, number>>
): DispatchExplainCheck {
  if (activeRunCount >= maxConcurrentAgents) {
    return {
      id: "dispatch_limits",
      status: "block",
      message: `Project concurrency is full (${activeRunCount}/${maxConcurrentAgents}).`,
      details: { activeRunCount, maxConcurrentAgents },
      hint: "Wait for an active run to finish or adjust agent.max_concurrent_agents in WORKFLOW.md.",
    };
  }

  const stateLimit = maxConcurrentAgentsByState[issue.state];
  if (stateLimit !== undefined) {
    const activeInState = runs.filter(
      (run) =>
        run.issueState === issue.state && isActiveRunRecordStatus(run.status)
    ).length;
    if (activeInState >= stateLimit) {
      return {
        id: "dispatch_limits",
        status: "block",
        message: `State concurrency is full for "${issue.state}" (${activeInState}/${stateLimit}).`,
        details: { activeInState, stateLimit, state: issue.state },
        hint: "Wait for a same-state run to finish or adjust agent.max_concurrent_agents_by_state in WORKFLOW.md.",
      };
    }
  }

  return {
    id: "dispatch_limits",
    status: "pass",
    message:
      "Project and per-state concurrency limits have available capacity.",
    details: {
      activeRunCount,
      maxConcurrentAgents,
      stateLimit: stateLimit ?? null,
    },
  };
}

function issueHasBlockingDependency(
  issue: TrackedIssue,
  lifecycle: WorkflowLifecycleConfig,
  issues: readonly TrackedIssue[]
): boolean {
  if (
    !matchesWorkflowState(issue.state, lifecycle.blockerCheckStates) ||
    issue.blockedBy.length === 0
  ) {
    return false;
  }

  return unresolvedBlockers(issue, lifecycle, issues).length > 0;
}

function unresolvedBlockers(
  issue: TrackedIssue,
  lifecycle: WorkflowLifecycleConfig,
  issues: readonly TrackedIssue[]
): Array<{
  id: string | null;
  identifier: string | null;
  state: string | null;
}> {
  return issue.blockedBy.filter((blockerRef) => {
    if (blockerRef.state && isStateTerminal(blockerRef.state, lifecycle)) {
      return false;
    }

    if (blockerRef.identifier) {
      const blockerIssue = issues.find(
        (candidate) => candidate.identifier === blockerRef.identifier
      );
      if (blockerIssue?.state) {
        return !isStateTerminal(blockerIssue.state, lifecycle);
      }
    }

    return true;
  });
}

function latestRunForIssue(
  runs: readonly OrchestratorRunRecord[],
  issueId: string
): OrchestratorRunRecord | null {
  return (
    runs
      .filter((run) => run.issueId === issueId)
      .sort(
        (left, right) =>
          (parseTimestampMs(right.updatedAt) ?? -Infinity) -
          (parseTimestampMs(left.updatedAt) ?? -Infinity)
      )[0] ?? null
  );
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseIssueIdentifier(
  identifier: string
): ParsedIssueIdentifier | null {
  const match = identifier.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/);
  if (!match) {
    return null;
  }
  return {
    owner: match[1]!,
    name: match[2]!,
    number: Number.parseInt(match[3]!, 10),
  };
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}
