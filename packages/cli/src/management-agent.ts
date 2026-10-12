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
  LinuxAgentService,
  LINUX_AGENT_UNIT,
  renderLinuxAgentUnit,
  createLinuxProjectLaunchContext,
} from "@gh-symphony/management-agent";
export type {
  AgentIdentity,
  ForegroundOptions,
  TransportOptions,
  LinuxServiceConfig,
  LinuxServiceOptions,
  LinuxServiceDiagnosis,
  LinuxProjectLaunchRequest,
  LinuxProjectLauncherOptions,
} from "@gh-symphony/management-agent";
