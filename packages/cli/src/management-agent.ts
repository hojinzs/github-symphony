/** Bundled foreground management boundary for service/application composition. */
export {
  AgentRegistry,
  createInventorySnapshot,
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
  ProjectIdentityResolver,
  ForegroundOptions,
  TransportOptions,
} from "@gh-symphony/management-agent";
