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
  LinuxAgentService,
  LINUX_AGENT_UNIT,
  renderLinuxAgentUnit,
  createLinuxProjectLaunchContext,
  CommandJournal,
  CommandExecutor,
  MacOSAgentService,
  runLaunchctl,
  launchMacOSProject,
} from "@gh-symphony/management-agent";
export type {
  AgentIdentity,
  ProjectIdentityResolver,
  ForegroundOptions,
  TransportOptions,
  LinuxServiceConfig,
  LinuxServiceOptions,
  LinuxServiceDiagnosis,
  LinuxProjectLaunchRequest,
  LinuxProjectLauncherOptions,
  ForegroundClient,
  CommandClient,
  JournalEntry,
  CommandResult,
  MacOSServiceConfig,
  MacOSServiceStatus,
  MacOSProjectLaunch,
  LaunchctlRunner,
} from "@gh-symphony/management-agent";

export { setupAgent } from "@gh-symphony/management-agent";
export type { SetupOptions, SetupService } from "@gh-symphony/management-agent";
export { loadAgentConfig, defaultAgentConfigPath } from "./agent-config.js";
export type { AgentHostConfig } from "./agent-config.js";
export { createNativeAgentService } from "./agent-service.js";
export type { NativeAgentService, NativeServiceHost } from "./agent-service.js";
export { runAgentRuntime } from "./agent-runtime.js";
export type { AgentRuntimePorts } from "./agent-runtime.js";
