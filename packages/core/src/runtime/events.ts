export type AgentEventName =
  | "agent.turnStarted"
  | "agent.turnCompleted"
  | "agent.turnFailed"
  | "agent.turnCancelled"
  | "agent.toolCallRequested"
  | "agent.inputRequired"
  | "agent.rateLimit"
  | "agent.messageDelta"
  | "agent.tokenUsageUpdated"
  | "agent.error";

type AgentEventPayloadBase = {
  observabilityEvent?: string;
  suppressUpdate?: true;
};

export const DEFAULT_AGENT_INPUT_REQUIRED_REASON =
  "turn_input_required: agent requires user input";

export function buildAgentInputRequiredReason(prompt: unknown): string {
  if (typeof prompt === "string") {
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt) {
      return `turn_input_required: ${trimmedPrompt}`;
    }
  }

  return DEFAULT_AGENT_INPUT_REQUIRED_REASON;
}

export type AgentTurnStartedEvent = {
  name: "agent.turnStarted";
  payload: AgentEventPayloadBase & {
    params: Record<string, unknown>;
  };
};

export type AgentTurnCompletedEvent = {
  name: "agent.turnCompleted";
  payload: AgentEventPayloadBase & {
    params: Record<string, unknown>;
    inputRequired: boolean;
  };
};

export type AgentTurnFailedEvent = {
  name: "agent.turnFailed";
  payload: AgentEventPayloadBase & {
    params: Record<string, unknown>;
  };
};

export type AgentTurnCancelledEvent = {
  name: "agent.turnCancelled";
  payload: AgentEventPayloadBase & {
    params: Record<string, unknown>;
  };
};

export type AgentToolCallRequestedEvent = {
  name: "agent.toolCallRequested";
  payload: AgentEventPayloadBase & {
    params: Record<string, unknown>;
    callId: string;
    toolName: string;
    threadId: string;
    turnId: string;
    arguments: unknown;
  };
};

export type AgentInputRequiredEvent = {
  name: "agent.inputRequired";
  payload: AgentEventPayloadBase & {
    params: Record<string, unknown>;
    reason: string;
  };
};

export type AgentRateLimitEvent = {
  name: "agent.rateLimit";
  payload: AgentEventPayloadBase & {
    // Rate-limit data stays in params so runtimes can preserve provider-specific
    // shapes while worker-side extraction remains centralized.
    params: Record<string, unknown>;
  };
};

export type AgentMessageDeltaEvent = {
  name: "agent.messageDelta";
  payload: AgentEventPayloadBase & {
    params: Record<string, unknown>;
    delta: string;
    itemId: string;
  };
};

export type AgentTokenUsageUpdatedEvent = {
  name: "agent.tokenUsageUpdated";
  payload: AgentEventPayloadBase & {
    params: Record<string, unknown>;
  };
};

export type AgentErrorEvent = {
  name: "agent.error";
  payload: AgentEventPayloadBase & {
    params: Record<string, unknown>;
    error: string;
  };
};

export type AgentEvent =
  | AgentTurnStartedEvent
  | AgentTurnCompletedEvent
  | AgentTurnFailedEvent
  | AgentTurnCancelledEvent
  | AgentToolCallRequestedEvent
  | AgentInputRequiredEvent
  | AgentRateLimitEvent
  | AgentMessageDeltaEvent
  | AgentTokenUsageUpdatedEvent
  | AgentErrorEvent;
