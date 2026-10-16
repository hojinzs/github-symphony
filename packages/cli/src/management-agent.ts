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
  MacOSAgentService,
  runLaunchctl,
  launchMacOSProject,
} from "@gh-symphony/management-agent";
export type {
  AgentIdentity,
  ProjectIdentityResolver,
  ForegroundOptions,
  TransportOptions,
  MacOSServiceConfig,
  MacOSServiceStatus,
  MacOSProjectLaunch,
  LaunchctlRunner,
} from "@gh-symphony/management-agent";
