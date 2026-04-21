import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeCredentialBrokerResponse,
  AgentRuntimeEvent,
} from "./adapter.js";

type SpawnLoopEventName =
  | "agent.turnStarted"
  | "agent.messageDelta"
  | "agent.turnCompleted";

type SpawnLoopEvent = AgentRuntimeEvent & {
  name: SpawnLoopEventName;
  payload: {
    runtime: "codex" | "claude-print";
    turnId: string;
  };
};

type PrepareContext = {
  sessionId: string;
};

type TurnInput = {
  turnId: string;
  prompt: string;
};

type TurnResult = {
  exitCode: number;
};

type BrokerResponse = AgentRuntimeCredentialBrokerResponse & {
  provider: "openai" | "anthropic";
};

type RuntimeAdapter = AgentRuntimeAdapter<
  PrepareContext,
  TurnInput,
  TurnResult,
  SpawnLoopEvent,
  BrokerResponse
>;

async function executeSpawnLoop(
  adapter: RuntimeAdapter,
  context: PrepareContext,
  input: TurnInput
): Promise<{
  events: SpawnLoopEventName[];
  result: TurnResult;
}> {
  const events: SpawnLoopEventName[] = [];
  await adapter.prepare(context);
  const unsubscribe = adapter.onEvent((event) => {
    events.push(event.name);
  });
  const result = await adapter.spawnTurn(input);
  unsubscribe();
  await adapter.shutdown();
  return { events, result };
}

class CodexRuntimeAdapterStub implements RuntimeAdapter {
  private readonly handlers = new Set<(event: SpawnLoopEvent) => void>();

  async prepare(_context: PrepareContext): Promise<void> {}

  async spawnTurn(input: TurnInput): Promise<TurnResult> {
    this.emit("agent.turnStarted", input.turnId);
    this.emit("agent.messageDelta", input.turnId);
    this.emit("agent.turnCompleted", input.turnId);
    return { exitCode: 0 };
  }

  onEvent(
    handler: (event: SpawnLoopEvent) => void
  ): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  resolveCredentials(brokerResponse: BrokerResponse): Record<string, string> {
    return brokerResponse.provider === "openai"
      ? { OPENAI_API_KEY: brokerResponse.env.OPENAI_API_KEY ?? "" }
      : {};
  }

  async shutdown(): Promise<void> {}

  async cancel(_reason?: string): Promise<void> {}

  private emit(name: SpawnLoopEventName, turnId: string): void {
    for (const handler of this.handlers) {
      handler({
        name,
        payload: {
          runtime: "codex",
          turnId,
        },
      });
    }
  }
}

class ClaudePrintRuntimeAdapterStub implements RuntimeAdapter {
  private readonly handlers = new Set<(event: SpawnLoopEvent) => void>();

  async prepare(_context: PrepareContext): Promise<void> {}

  async spawnTurn(input: TurnInput): Promise<TurnResult> {
    this.emit("agent.turnStarted", input.turnId);
    this.emit("agent.messageDelta", input.turnId);
    this.emit("agent.turnCompleted", input.turnId);
    return { exitCode: 0 };
  }

  onEvent(
    handler: (event: SpawnLoopEvent) => void
  ): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  resolveCredentials(brokerResponse: BrokerResponse): Record<string, string> {
    return brokerResponse.provider === "anthropic"
      ? { ANTHROPIC_API_KEY: brokerResponse.env.ANTHROPIC_API_KEY ?? "" }
      : {};
  }

  async shutdown(): Promise<void> {}

  async cancel(_reason?: string): Promise<void> {}

  private emit(name: SpawnLoopEventName, turnId: string): void {
    for (const handler of this.handlers) {
      handler({
        name,
        payload: {
          runtime: "claude-print",
          turnId,
        },
      });
    }
  }
}

describe("AgentRuntimeAdapter", () => {
  it("supports a shared spawn-loop contract for daemon and one-shot runtimes", async () => {
    const codex = new CodexRuntimeAdapterStub();
    const claude = new ClaudePrintRuntimeAdapterStub();

    expectTypeOf(codex).toMatchTypeOf<RuntimeAdapter>();
    expectTypeOf(claude).toMatchTypeOf<RuntimeAdapter>();

    await expect(
      executeSpawnLoop(codex, { sessionId: "session-1" }, {
        turnId: "turn-1",
        prompt: "implement the change",
      })
    ).resolves.toEqual({
      events: [
        "agent.turnStarted",
        "agent.messageDelta",
        "agent.turnCompleted",
      ],
      result: { exitCode: 0 },
    });

    await expect(
      executeSpawnLoop(claude, { sessionId: "session-2" }, {
        turnId: "turn-2",
        prompt: "implement the change",
      })
    ).resolves.toEqual({
      events: [
        "agent.turnStarted",
        "agent.messageDelta",
        "agent.turnCompleted",
      ],
      result: { exitCode: 0 },
    });
  });

  it("lets each runtime resolve provider-specific credentials from the broker payload", () => {
    const codex = new CodexRuntimeAdapterStub();
    const claude = new ClaudePrintRuntimeAdapterStub();

    expect(
      codex.resolveCredentials({
        provider: "openai",
        env: { OPENAI_API_KEY: "sk-openai" },
        expires_at: "2026-04-21T00:00:00.000Z",
      })
    ).toEqual({ OPENAI_API_KEY: "sk-openai" });

    expect(
      claude.resolveCredentials({
        provider: "anthropic",
        env: { ANTHROPIC_API_KEY: "sk-anthropic" },
        expires_at: "2026-04-21T00:00:00.000Z",
      })
    ).toEqual({ ANTHROPIC_API_KEY: "sk-anthropic" });
  });
});
