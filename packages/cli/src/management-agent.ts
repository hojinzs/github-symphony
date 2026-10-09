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
} from "@gh-symphony/management-agent";
export type {
  AgentIdentity,
  ForegroundOptions,
  TransportOptions,
} from "@gh-symphony/management-agent";
