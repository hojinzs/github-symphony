import {
  isStateActive,
  isStateTerminal,
  normalizeWorkflowState,
  issueRoutable,
  deriveLegacyWorkspaceKey,
  FAILURE_RETRY_REARM_HINT,
  isRecoveryWorkspaceActionable,
  isFailureRetrySuppressedForState,
  MAX_FAILURE_RETRIES_EXCEEDED_REASON,
  type IssueWorkspaceRecord,
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
    | "tracker_dispatchability"
    | "workflow_routability"
    | "workflow_state"
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
  lifecycle: WorkflowLifecycleConfig;
  issueRecords: readonly IssueOrchestrationRecord[];
  issueWorkspaces?: readonly IssueWorkspaceRecord[];
  runs: readonly OrchestratorRunRecord[];
  activeRunCount: number;
  maxConcurrentAgents: number;
  maxConcurrentAgentsByState: Readonly<Record<string, number>>;
  convergenceLock?: {
    now?: Date;
    ttlMs?: number;
  };
};

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

  checks.push(explainTrackerDispatchability(issue));
  checks.push(explainWorkflowState(issue, input.lifecycle));
  checks.push(explainWorkflowRoutability(issue, input.lifecycle));
  checks.push(
    explainRuntimeOwnership(
      issue,
      input.issueRecords,
      input.runs,
      input.issueWorkspaces ?? [],
      input.convergenceLock
    )
  );
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
    : blocking[0]!.id === "tracker_dispatchability"
      ? `Not dispatchable: ${issue.dispatchReason?.trim() || "no reason was provided"}`
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
  lifecycle: WorkflowLifecycleConfig
): {
  eligible: boolean;
  reason: "not_dispatchable" | "inactive_state" | "not_routable" | null;
} {
  if (!issue.dispatchable) {
    return { eligible: false, reason: "not_dispatchable" };
  }

  if (!isStateActive(issue.state, lifecycle)) {
    return { eligible: false, reason: "inactive_state" };
  }

  if (!issueRoutable(issue, lifecycle).routable) {
    return { eligible: false, reason: "not_routable" };
  }

  return { eligible: true, reason: null };
}

function explainWorkflowRoutability(
  issue: TrackedIssue,
  lifecycle: WorkflowLifecycleConfig
): DispatchExplainCheck {
  if (!issue.dispatchable) {
    return {
      id: "workflow_routability",
      status: "pass",
      message: "Workflow routability is superseded by tracker dispatchability.",
    };
  }
  const routability = issueRoutable(issue, lifecycle);
  if (routability.routable) {
    return {
      id: "workflow_routability",
      status: "pass",
      message: "Issue satisfies workflow routing requirements.",
    };
  }

  return {
    id: "workflow_routability",
    status: "block",
    message: `not routable: ${routability.reason ?? "no reason was provided"}`,
    details: { reason: routability.reason ?? null },
  };
}

function explainTrackerDispatchability(
  issue: TrackedIssue
): DispatchExplainCheck {
  if (issue.dispatchable) {
    return {
      id: "tracker_dispatchability",
      status: "pass",
      message: "Tracker marks this issue as dispatchable.",
    };
  }

  const reason = issue.dispatchReason?.trim() || "no reason was provided";
  return {
    id: "tracker_dispatchability",
    status: "block",
    message: `not dispatchable: ${reason}`,
    details: { dispatchReason: issue.dispatchReason ?? null },
  };
}

export function hasConvergenceLockedRunForIssue(
  runs: readonly OrchestratorRunRecord[],
  issueId: string,
  issueState: string,
  issueUpdatedAt: string | null | undefined,
  options: {
    now?: Date;
    ttlMs?: number;
  } = {}
): OrchestratorRunRecord | null {
  const status = getConvergenceLockStatus(
    runs,
    issueId,
    issueState,
    issueUpdatedAt,
    options
  );
  return status.expired ? null : status.run;
}

export function getConvergenceLockStatus(
  runs: readonly OrchestratorRunRecord[],
  issueId: string,
  issueState: string,
  issueUpdatedAt: string | null | undefined,
  options: {
    now?: Date;
    ttlMs?: number;
  } = {}
): { run: OrchestratorRunRecord | null; expired: boolean } {
  const latestRun = latestRunForIssue(runs, issueId);

  if (
    latestRun?.runtimeSession?.exitClassification !== "convergence-detected" ||
    latestRun.issueState !== issueState
  ) {
    return { run: null, expired: false };
  }

  const convergedAtMs = parseConvergenceTimestampMs(
    latestRun.completedAt ?? latestRun.updatedAt
  );
  const issueUpdatedAtMs = issueUpdatedAt
    ? parseConvergenceTimestampMs(issueUpdatedAt)
    : null;
  const nowMs = (options.now ?? new Date()).getTime();
  const ttlMs = options.ttlMs ?? DEFAULT_CONVERGENCE_LOCK_TTL_MS;
  if (issueUpdatedAtMs !== null && issueUpdatedAtMs > convergedAtMs) {
    return { run: null, expired: false };
  }
  if (nowMs - convergedAtMs >= ttlMs) {
    return { run: latestRun, expired: true };
  }

  return {
    run: latestRun,
    expired: false,
  };
}

export const DEFAULT_CONVERGENCE_LOCK_TTL_MS = 24 * 60 * 60 * 1000;

export function resolveConvergenceLockTtlMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.SYMPHONY_CONVERGENCE_LOCK_TTL_MS);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CONVERGENCE_LOCK_TTL_MS;
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
      hint: "Run 'gh-symphony repo init' from the target repository.",
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
      : "Run 'gh-symphony repo init' from the repository that owns this issue.",
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
    details: issue ? { itemId: issue.tracker.itemId ?? null } : undefined,
    hint: issue
      ? undefined
      : "Add the issue to the GitHub Project or run 'gh-symphony repo status' to confirm the repository runtime.",
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
  const linkedPullRequest = findActiveLinkedPullRequest(issue, lifecycle);
  if (linkedPullRequest) {
    return {
      id: "workflow_state",
      status: "block",
      message: `Linked PR card ${linkedPullRequest.identifier} is active in project state "${linkedPullRequest.projectState}", but canonical Issue state "${issue.state}" maps to ${role}, not active, in WORKFLOW.md.`,
      details: {
        activeStates: lifecycle.activeStates,
        terminalStates: lifecycle.terminalStates,
        canonicalIssueState: issue.state,
        linkedPullRequestIdentifier: linkedPullRequest.identifier,
        linkedPullRequestProjectState: linkedPullRequest.projectState,
      },
      hint: "Linked PR card status alone does not trigger dispatch. Move the canonical Issue card to an active state to request rework.",
    };
  }

  return {
    id: "workflow_state",
    status: "block",
    message: `Project state "${issue.state}" maps to ${role}, not active, in WORKFLOW.md.`,
    details: {
      activeStates: lifecycle.activeStates,
      terminalStates: lifecycle.terminalStates,
    },
    hint: "Move the GitHub Project item to an active state or run 'gh-symphony workflow preview' to inspect WORKFLOW.md state mappings.",
  };
}

export function findActiveLinkedPullRequest(
  issue: TrackedIssue,
  lifecycle: WorkflowLifecycleConfig
): { id: string; identifier: string; projectState: string } | null {
  if (isStateActive(issue.state, lifecycle)) {
    return null;
  }

  const linkedPullRequests = issue.linkedPullRequests ?? [];
  for (const pullRequest of linkedPullRequests) {
    const projectState =
      typeof pullRequest.projectState === "string"
        ? pullRequest.projectState
        : null;
    if (projectState && isStateActive(projectState, lifecycle)) {
      return {
        id: pullRequest.id,
        identifier: pullRequest.identifier,
        projectState,
      };
    }
  }

  return null;
}

function explainRuntimeOwnership(
  issue: TrackedIssue,
  issueRecords: readonly IssueOrchestrationRecord[],
  runs: readonly OrchestratorRunRecord[],
  issueWorkspaces: readonly IssueWorkspaceRecord[],
  convergenceLockOptions: {
    now?: Date;
    ttlMs?: number;
  } = {}
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
  const legacyWorkspaceKey =
    record?.workspaceKey === deriveLegacyWorkspaceKey(issue.identifier) &&
    record.workspaceKey !== issue.identifier;

  if (activeRun) {
    return {
      id: "runtime_ownership",
      status: "block",
      message: `${legacyWorkspaceKey ? `Workspace key: legacy (${record.workspaceKey}). ` : ""}Existing ${activeRun.status} run ${activeRun.runId} already owns the issue.`,
      details: {
        runId: activeRun.runId,
        status: activeRun.status,
        retryKind: activeRun.retryKind,
        nextRetryAt: activeRun.nextRetryAt,
      },
      hint: "Run 'gh-symphony repo status' or 'gh-symphony repo logs --issue <owner/repo#number>' to inspect the current owner.",
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
      hint: "Run 'gh-symphony repo status' to inspect active and retrying work.",
    };
  }

  const convergenceRun = hasConvergenceLockedRunForIssue(
    runs,
    issue.id,
    issue.state,
    issue.updatedAt,
    convergenceLockOptions
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

  const legacyFailureRetrySuppressedState =
    latestRun?.status === "suppressed" &&
    latestRun.lastError?.includes(MAX_FAILURE_RETRIES_EXCEEDED_REASON)
      ? latestRun.issueState
      : null;
  // Suppression state is written only by exhaustion paths, so a positive count
  // is sufficient here even though the configured retry cap is unavailable.
  if (
    record &&
    record.failureRetryCount > 0 &&
    isFailureRetrySuppressedForState(
      record,
      issue.state,
      legacyFailureRetrySuppressedState
    )
  ) {
    return {
      id: "runtime_ownership",
      status: "block",
      message:
        "Failure retry limit has suppressed redispatch for the current tracker state.",
      details: {
        failureRetryCount: record.failureRetryCount,
        runId: latestRun?.runId ?? null,
        lastError: latestRun?.lastError ?? null,
      },
      hint: FAILURE_RETRY_REARM_HINT,
    };
  }

  if (
    latestRun?.status === "suppressed" &&
    latestRun.recovery?.kind === "incomplete-turn-dirty-workspace" &&
    isRecoveryWorkspaceActionable(
      latestRun,
      latestRun.recovery,
      issueWorkspaces
    )
  ) {
    return {
      id: "runtime_ownership",
      status: "warn",
      message:
        "Latest run has a recoverable incomplete-turn dirty workspace; dispatch will start a recovery turn.",
      details: {
        runId: latestRun.recovery.runId,
        issueId: latestRun.recovery.issueId,
        workspacePath: latestRun.recovery.workspacePath,
        dirtyFiles: latestRun.recovery.dirtyFiles,
        lastEvent: latestRun.recovery.lastEvent,
        lastEventAt: latestRun.recovery.lastEventAt,
        sessionId: latestRun.recovery.sessionId,
        threadId: latestRun.recovery.threadId,
        suggestedCommand: latestRun.recovery.suggestedCommand,
      },
      hint: latestRun.recovery.suggestedCommand,
    };
  }

  return {
    id: "runtime_ownership",
    status: "pass",
    message: `${legacyWorkspaceKey ? `Workspace key: legacy (${record.workspaceKey}). ` : ""}No active run, retry, convergence lock, or suppression owns the issue.`,
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

  const normalizedState = normalizeWorkflowState(issue.state);
  const stateLimit = maxConcurrentAgentsByState[normalizedState];
  if (stateLimit !== undefined) {
    const activeInState = runs.filter(
      (run) =>
        normalizeWorkflowState(run.issueState) === normalizedState &&
        isActiveRunRecordStatus(run.status)
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

function parseConvergenceTimestampMs(value: string | null | undefined): number {
  if (!value) {
    throw new Error(
      "Convergence lock timestamp is missing; refusing to apply a silent fallback."
    );
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Convergence lock timestamp is invalid: ${JSON.stringify(value)}`
    );
  }

  return parsed;
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
