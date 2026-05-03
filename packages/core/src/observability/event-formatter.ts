import type { IssueStatusEvent } from "../contracts/status-surface.js";
import type { OrchestratorEvent } from "./structured-events.js";

export function formatEventMessage(event: OrchestratorEvent): string | null {
  switch (event.event) {
    case "run-dispatched":
      return event.issueState
        ? `Dispatched from ${event.issueState}`
        : "Dispatched";
    case "run-recovered":
      return "Recovered existing run";
    case "run-retried":
      return `Retry ${event.attempt} scheduled (${event.retryKind})`;
    case "run-failed":
      return event.lastError;
    case "run-suppressed":
      return event.reason;
    case "hook-executed":
      return `${event.hook}: ${event.outcome}`;
    case "hook-failed":
      return event.error;
    case "workspace-cleanup":
      return event.error ? `${event.outcome}: ${event.error}` : event.outcome;
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
    return JSON.parse(line) as OrchestratorEvent;
  } catch {
    return null;
  }
}
