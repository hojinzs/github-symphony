import type { AgentEvent } from "@gh-symphony/core";

export type ClaudePrintWireEvent = Record<string, unknown>;

export type ClaudePrintNdjsonRecord = {
  line: string;
  message?: ClaudePrintWireEvent;
  parseError?: string;
};

export type ClaudePrintEventMapperOptions = {
  threadId?: string;
  turnId?: string;
};

export type ClaudePrintEventMapperState = {
  hasStartedTurn: boolean;
  latestResultEvent: ClaudePrintWireEvent | null;
  latestErrorEvent: ClaudePrintWireEvent | null;
  sawRateLimit: boolean;
};

const CLAUDE_OBSERVABILITY_PREFIX = "claude-print/";

export function parseClaudePrintNdjsonLine(
  line: string
): ClaudePrintNdjsonRecord | null {
  const trimmedLine = line.trim();
  if (!trimmedLine) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmedLine);
    if (!asRecord(parsed)) {
      return {
        line: trimmedLine,
        parseError: "Claude stream-json line is not a JSON object.",
      };
    }

    return {
      line: trimmedLine,
      message: parsed,
    };
  } catch (error) {
    return {
      line: trimmedLine,
      parseError:
        error instanceof Error ? error.message : "Unknown JSON parse error.",
    };
  }
}

export class ClaudePrintEventMapper {
  private hasStartedTurn = false;
  private latestResultEvent: ClaudePrintWireEvent | null = null;
  private latestErrorEvent: ClaudePrintWireEvent | null = null;
  private sawRateLimit = false;

  constructor(private readonly options: ClaudePrintEventMapperOptions = {}) {}

  mapLine(line: string): AgentEvent[] {
    const record = parseClaudePrintNdjsonLine(line);
    if (!record?.message) {
      return [];
    }

    return this.mapMessage(record.message);
  }

  mapMessage(message: ClaudePrintWireEvent): AgentEvent[] {
    const type = getEventType(message);
    const events: AgentEvent[] = [];

    if (type === "message_start") {
      events.push(this.buildTurnStartedEvent(message, type));
      this.hasStartedTurn = true;
      return events;
    }

    if (type === "content_block_start" || type === "tool_use") {
      const toolUseEvent = mapToolUseEvent(message, this.options);
      if (toolUseEvent) {
        events.push(toolUseEvent);
      }
    }

    if (type === "content_block_delta") {
      if (!this.hasStartedTurn) {
        events.push(this.buildTurnStartedEvent(message, type));
        this.hasStartedTurn = true;
      }

      events.push({
        name: "agent.messageDelta",
        payload: {
          observabilityEvent: observabilityEventName(type),
          params: message,
          delta: extractDeltaText(message),
          itemId: extractItemId(message),
        },
      });
    }

    if (type === "result") {
      this.latestResultEvent = message;
      const rateLimit = extractRateLimit(message);

      if (rateLimit) {
        this.sawRateLimit = true;
        events.push({
          name: "agent.rateLimit",
          payload: {
            observabilityEvent: observabilityEventName(type),
            params: {
              source: "claude",
              rate_limit: rateLimit,
              usage: asRecord(message.usage),
              result: message,
            },
          },
        });
      }

      if (isClaudeResultError(message)) {
        events.push(buildClaudeErrorEvent(message, type));
      } else {
        events.push({
          name: "agent.turnCompleted",
          payload: {
            observabilityEvent: observabilityEventName(type),
            params: message,
            inputRequired: false,
          },
        });
      }
    }

    if (type === "error") {
      this.latestErrorEvent = message;
      events.push(buildClaudeErrorEvent(message, type));
    }

    return events;
  }

  snapshot(): ClaudePrintEventMapperState {
    return {
      hasStartedTurn: this.hasStartedTurn,
      latestResultEvent: this.latestResultEvent,
      latestErrorEvent: this.latestErrorEvent,
      sawRateLimit: this.sawRateLimit,
    };
  }

  private buildTurnStartedEvent(
    message: ClaudePrintWireEvent,
    type: string
  ): AgentEvent {
    return {
      name: "agent.turnStarted",
      payload: {
        observabilityEvent: observabilityEventName(type),
        params: message,
      },
    };
  }
}

export function mapClaudePrintEvent(
  message: ClaudePrintWireEvent,
  options: ClaudePrintEventMapperOptions = {}
): AgentEvent[] {
  // Single-message helper. Use ClaudePrintEventMapper directly for streams so
  // turn-start inference and latest result/error state are preserved.
  return new ClaudePrintEventMapper(options).mapMessage(message);
}

export function isClaudeResultError(message: ClaudePrintWireEvent): boolean {
  const subtype = getString(message.subtype);
  const stopReason = getString(message.stop_reason);

  return (
    message.is_error === true ||
    (subtype !== undefined && subtype.startsWith("error")) ||
    (stopReason !== undefined && stopReason.startsWith("error"))
  );
}

export function extractRateLimit(
  message: ClaudePrintWireEvent
): Record<string, unknown> | null {
  const usage = asRecord(message.usage);
  const rateLimit = usage ? asRecord(usage.rate_limit) : null;
  if (rateLimit) {
    return rateLimit;
  }

  return asRecord(message.rate_limit);
}

export function getClaudeResultStatus(
  message: ClaudePrintWireEvent | null | undefined
): string | undefined {
  if (!message) {
    return undefined;
  }

  return getString(message.subtype) ?? getString(message.stop_reason);
}

function mapToolUseEvent(
  message: ClaudePrintWireEvent,
  options: ClaudePrintEventMapperOptions
): AgentEvent | null {
  const type = getEventType(message);
  const contentBlock = asRecord(message.content_block);
  const toolUse =
    type === "tool_use"
      ? message
      : contentBlock && getString(contentBlock.type) === "tool_use"
        ? contentBlock
        : null;

  if (!toolUse) {
    return null;
  }

  const input = "input" in toolUse ? toolUse.input : toolUse.arguments;

  return {
    name: "agent.toolCallRequested",
    payload: {
      observabilityEvent: observabilityEventName(type),
      params: message,
      callId: getString(toolUse.id) ?? "",
      toolName: getString(toolUse.name) ?? "",
      threadId: options.threadId ?? getString(message.thread_id) ?? "",
      turnId: options.turnId ?? getString(message.turn_id) ?? "",
      arguments: input,
    },
  };
}

function buildClaudeErrorEvent(
  message: ClaudePrintWireEvent,
  type: string
): AgentEvent {
  return {
    name: "agent.error",
    payload: {
      observabilityEvent: observabilityEventName(type),
      params: message,
      error: describeClaudeError(message),
    },
  };
}

function describeClaudeError(message: ClaudePrintWireEvent): string {
  const error = asRecord(message.error);
  return (
    getString(error?.message) ??
    getString(error?.type) ??
    getString(message.message) ??
    getString(message.subtype) ??
    getString(message.stop_reason) ??
    JSON.stringify(message)
  );
}

function extractDeltaText(message: ClaudePrintWireEvent): string {
  const delta = asRecord(message.delta);
  return (
    getString(delta?.text) ??
    getString(delta?.partial_json) ??
    getString(message.text) ??
    ""
  );
}

function extractItemId(message: ClaudePrintWireEvent): string {
  return (
    getString(message.item_id) ??
    getString(message.content_block_id) ??
    getString(message.index) ??
    ""
  );
}

function getEventType(message: ClaudePrintWireEvent): string {
  return getString(message.type) ?? "";
}

function observabilityEventName(type: string): string {
  return `${CLAUDE_OBSERVABILITY_PREFIX}${type || "unknown"}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return undefined;
}
