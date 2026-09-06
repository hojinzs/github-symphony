import { createHash } from "node:crypto";
import type { IssueStatusEvent } from "../contracts/status-surface.js";
import type { OrchestratorEvent } from "./structured-events.js";

export function formatEventMessage(event: OrchestratorEvent): string | null {
  switch (event.event) {
    case "tracker.list":
      return `Tracker list saw ${event.issue.identifier}`;
    case "tracker.fetchByIds":
      return `Tracker fetch refreshed ${event.issue.identifier}`;
    case "tracker.state":
      return event.error
        ? `${event.requestType}: ${event.outcome} (${event.error})`
        : `${event.requestType}: ${event.outcome} (${event.confirmedState ?? "unknown"})`;
    case "tracker.transition-comment":
      return event.error
        ? `transition comment: ${event.outcome} (${event.error})`
        : `transition comment: ${event.outcome}`;
    case "run-dispatched":
      return event.issueState
        ? `Dispatched from ${event.issueState}`
        : "Dispatched";
    case "run-recovered":
      return "Recovered existing run";
    case "run-restart-failed":
      return event.retrySuppressed
        ? `Restart failed and retries were suppressed: ${event.error}`
        : `Restart failed; retry scheduled: ${event.error}`;
    case "run-retried":
      return `Retry ${event.attempt} scheduled (${event.retryKind})${event.error ? `: ${event.error}` : ""}`;
    case "retry-postponed":
      return `Retry ${event.attempt} postponed until ${event.dueAt}: ${event.reason}`;
    case "run-finalization-deferred":
      return `Finalization deferred ${event.consecutiveDeferrals}/${event.maxDeferrals} (${event.reason})${event.exhausted ? " — bound exhausted" : ""}`;
    case "run-failed":
      return event.lastError;
    case "run-suppressed":
      return event.reason;
    case "run-ownership-skipped":
      return `Skipped ${event.operation} (${event.reason})`;
    case "convergence-lock-expired":
      return `Convergence lock expired after ${event.ttlMs}ms`;
    case "recovery-dirty-workspace":
      return `Dirty workspace retained at ${event.workspacePath} on branch ${event.currentBranch ?? "unknown"}; recovery is continuing${event.recoveryWorkspacePath ? ` from ${event.recoveryWorkspacePath}` : ""}`;
    case "hook-executed":
      return `${event.hook}: ${event.outcome}`;
    case "hook-failed":
      return event.error;
    case "workspace-cleanup":
      return event.error ? `${event.outcome}: ${event.error}` : event.outcome;
    case "workspace-root-relocated":
      return `Workspace root changed from ${event.previousWorkspacePath} to ${event.configuredWorkspacePath}`;
    case "worker-error":
      return event.error;
    case "turn_started":
      return `Turn ${event.turnCount} started`;
    case "turn_completed":
      return `Turn ${event.turnCount} completed in ${event.durationMs}ms`;
    case "turn_failed":
      return event.error ?? `Turn ${event.turnCount} failed`;
    case "session_invalidated":
      return event.reason;
    default:
      return null;
  }
}

export function parseRecentEvents(
  raw: string,
  limit: number,
  options: { allowPartialFirstLine: boolean }
): IssueStatusEvent[] {
  const lines = raw.split("\n");
  if (options.allowPartialFirstLine) {
    lines.shift();
  }

  const events: IssueStatusEvent[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    const event = parseRunEventLine(line);
    if (!event) {
      continue;
    }

    events.push({
      at: event.at,
      event: event.event,
      message: formatEventMessage(event),
    });
    if (events.length === limit) {
      break;
    }
  }

  return events.reverse();
}

export function parseRunEventLine(line: string): OrchestratorEvent | null {
  try {
    const parsed = JSON.parse(line) as OrchestratorEvent & {
      integrity?: unknown;
    };
    if (parsed.integrity === undefined) {
      return parsed;
    }
    if (typeof parsed.integrity !== "string") {
      return null;
    }

    const integrity = parsed.integrity;
    delete parsed.integrity;
    const expected = `sha256:${createHash("sha256")
      .update(JSON.stringify(parsed))
      .digest("hex")}`;
    return integrity === expected ? parsed : null;
  } catch {
    return null;
  }
}
