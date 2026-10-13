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
  MacOSAgentService,
  runLaunchctl,
  launchMacOSProject,
} from "@gh-symphony/management-agent";
export type {
  AgentIdentity,
  ForegroundOptions,
  TransportOptions,
  ForegroundClient,
  CommandClient,
  JournalEntry,
  CommandResult,
  MacOSServiceConfig,
  MacOSServiceStatus,
  MacOSProjectLaunch,
  LaunchctlRunner,
} from "@gh-symphony/management-agent";
