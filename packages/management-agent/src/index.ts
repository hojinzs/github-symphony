export { AgentRegistry, localProjectId } from "./registry.js";
export { CommandJournal } from "./journal.js";
export type { JournalEntry, CommandResult } from "./journal.js";
export { CommandExecutor } from "./executor.js";
export type { CommandClient } from "./executor.js";
export type {
  AgentIdentity,
  RegisteredProject,
  LocalInventory,
  LocalInventoryReader,
  LocalProjectMetadata,
} from "./registry.js";

export { LocalLifecycleAdapter } from "./lifecycle.js";
export type {
  RuntimeBinding,
  StopTarget,
  RuntimeInspection,
  RuntimeDriver,
  StopTargetJournal,
  LifecycleResult,
} from "./lifecycle.js";
export { CliProcess, projectEnvironment } from "./cli-process.js";
export type { CliInvocation, CliProcessOptions } from "./cli-process.js";
export {
  createAgentTransport,
  AgentTransportError,
  agentServerOrigin,
  enrollAgent,
} from "./transport.js";
export type { TransportOptions } from "./transport.js";

export { LocalReadAdapter } from "./local-read.js";
export type {
  LocalReadRuntime,
  LocalReadRuntimeResolver,
} from "./local-read.js";
export {
  runForegroundAgent,
  reconnectDelay,
  observationPages,
} from "./foreground.js";
export type { ForegroundOptions, ForegroundClient } from "./foreground.js";
export { createInventorySnapshot } from "./inventory.js";
export type { ProjectIdentityResolver } from "./inventory.js";

export {
  LinuxAgentService,
  LINUX_AGENT_UNIT,
  renderLinuxAgentUnit,
} from "./linux-service.js";
export type {
  LinuxServiceConfig,
  LinuxServiceOptions,
  LinuxServiceDiagnosis,
} from "./linux-service.js";
export { createLinuxProjectLaunchContext } from "./linux-launcher.js";
export type {
  LinuxProjectLaunchRequest,
  LinuxProjectLauncherOptions,
} from "./linux-launcher.js";
export {
  MacOSAgentService,
  runLaunchctl,
  launchMacOSProject,
} from "./macos-service.js";
export type {
  MacOSServiceConfig,
  MacOSServiceStatus,
  MacOSProjectLaunch,
  LaunchctlRunner,
  LaunchctlResult,
} from "./macos-service.js";

export { setupAgent } from "./setup.js";
export type { SetupOptions, SetupService } from "./setup.js";
