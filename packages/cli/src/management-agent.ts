/** Bundled foreground management boundary for service/application composition. */
export {
  AgentRegistry,
  createAgentTransport,
  enrollAgent,
  agentServerOrigin,
  AgentTransportError,
  runForegroundAgent,
  observationPages,
  reconnectDelay,
  CommandJournal,
  CommandExecutor,
} from "@gh-symphony/management-agent";
export type {
  AgentIdentity,
  ForegroundOptions,
  TransportOptions,
  ForegroundClient,
  CommandClient,
  JournalEntry,
  CommandResult,
} from "@gh-symphony/management-agent";
