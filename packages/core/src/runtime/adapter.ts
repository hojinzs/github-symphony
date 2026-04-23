import type { AgentEventName } from "./events.js";

export type AgentRuntimeEnv = Record<string, string>;

export type AgentRuntimeCredentialBrokerResponse = {
  env: AgentRuntimeEnv;
  expires_at?: string;
};

// Loose runtime event shape used by adapters before narrowing to AgentEvent.
export type AgentRuntimeEvent = {
  name: AgentEventName;
  payload?: unknown;
};

export type AgentRuntimeEventHandler<
  RuntimeEvent extends AgentRuntimeEvent = AgentRuntimeEvent,
> = (event: RuntimeEvent) => void;

export type AgentRuntimeEventSubscription = () => void;

/**
 * Spawn-loop contract for agent runtimes.
 *
 * A worker prepares the runtime once, subscribes to the neutral event stream,
 * calls {@link spawnTurn} for each turn in the run, and finally calls
 * {@link shutdown} or {@link cancel}. This lets a long-running daemon such as
 * Codex app-server map one turn to an in-process RPC, while a one-shot runtime
 * such as `claude -p` can map one turn to a brand-new process invocation.
 */
export interface AgentRuntimeAdapter<
  PrepareContext = unknown,
  TurnInput = unknown,
  TurnResult = unknown,
  RuntimeEvent extends AgentRuntimeEvent = AgentRuntimeEvent,
  BrokerResponse extends AgentRuntimeCredentialBrokerResponse = AgentRuntimeCredentialBrokerResponse,
  ResolvedCredentials extends AgentRuntimeEnv = AgentRuntimeEnv,
> {
  /**
   * Perform pre-spawn setup for the run, such as MCP composition, credential
   * resolution, or runtime session selection.
   */
  prepare(context: PrepareContext): Promise<void> | void;

  /**
   * Execute one logical Symphony turn.
   *
   * Implementations may translate this to a daemon turn on a long-lived
   * process, or to a fresh process spawn for one-shot runtimes.
   */
  spawnTurn(input: TurnInput): Promise<TurnResult> | TurnResult;

  /**
   * Subscribe to runtime events that have already been normalized away from the
   * runtime wire protocol.
   */
  onEvent(
    handler: AgentRuntimeEventHandler<RuntimeEvent>
  ): AgentRuntimeEventSubscription;

  /**
   * Extract runtime-specific environment variables from a credential broker
   * response without coupling the worker to a specific provider.
   */
  resolveCredentials(brokerResponse: BrokerResponse): ResolvedCredentials;

  /**
   * Release runtime resources once the spawn loop is complete.
   */
  shutdown(): Promise<void> | void;

  /**
   * Abort in-flight work when the worker terminates the run early.
   */
  cancel(reason?: string): Promise<void> | void;
}
