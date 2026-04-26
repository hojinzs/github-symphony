import { describe, expect, it } from "vitest";
import {
  ClaudePrintEventMapper,
  isClaudeResultError,
  parseClaudePrintNdjsonLine,
} from "./events.js";

describe("ClaudePrintEventMapper", () => {
  it("maps stream-json fixture events to neutral agent events", () => {
    const mapper = new ClaudePrintEventMapper({
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const events = [
      { type: "message_start", message: { id: "msg-1" } },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu-1",
          name: "github_graphql",
          input: { query: "{ viewer { login } }" },
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "hello" },
      },
      {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          rate_limit: {
            limit: 1000,
            remaining: 998,
            reset_at: "2026-04-26T10:00:00.000Z",
          },
        },
      },
      {
        type: "error",
        error: {
          type: "api_error",
          message: "temporary upstream error",
        },
      },
    ].flatMap((message) => mapper.mapMessage(message));

    expect(events.map((event) => event.name)).toEqual([
      "agent.turnStarted",
      "agent.toolCallRequested",
      "agent.messageDelta",
      "agent.rateLimit",
      "agent.turnCompleted",
      "agent.error",
    ]);
    expect(events[1]).toMatchObject({
      name: "agent.toolCallRequested",
      payload: {
        callId: "toolu-1",
        toolName: "github_graphql",
        threadId: "thread-1",
        turnId: "turn-1",
        arguments: { query: "{ viewer { login } }" },
      },
    });
    expect(events[2]).toMatchObject({
      name: "agent.messageDelta",
      payload: {
        delta: "hello",
        itemId: "1",
      },
    });
    expect(events[3]).toMatchObject({
      name: "agent.rateLimit",
      payload: {
        params: {
          source: "claude",
          rate_limit: {
            limit: 1000,
            remaining: 998,
          },
        },
      },
    });
    expect(events[4]).toMatchObject({
      name: "agent.turnCompleted",
      payload: {
        inputRequired: false,
        params: {
          usage: {
            input_tokens: 10,
            output_tokens: 2,
          },
        },
      },
    });
  });

  it("starts a turn from the first content_block_delta when message_start is absent", () => {
    const mapper = new ClaudePrintEventMapper();

    const events = mapper.mapMessage({
      type: "content_block_delta",
      index: 0,
      delta: { text: "first token" },
    });

    expect(events.map((event) => event.name)).toEqual([
      "agent.turnStarted",
      "agent.messageDelta",
    ]);
  });

  it("maps result error subtypes to agent.error instead of turnCompleted", () => {
    const mapper = new ClaudePrintEventMapper();

    const events = mapper.mapMessage({
      type: "result",
      subtype: "error_max_turns",
      stop_reason: "error_max_turns",
      message: "max turns reached",
    });

    expect(events.map((event) => event.name)).toEqual(["agent.error"]);
    expect(isClaudeResultError(events[0]?.payload.params as never)).toBe(true);
  });

  it("parses NDJSON lines without throwing on invalid JSON", () => {
    expect(parseClaudePrintNdjsonLine('{"type":"message_start"}')).toEqual({
      line: '{"type":"message_start"}',
      message: { type: "message_start" },
    });
    expect(parseClaudePrintNdjsonLine("not-json")?.parseError).toBeTypeOf(
      "string"
    );
    expect(parseClaudePrintNdjsonLine("   ")).toBeNull();
  });
});
