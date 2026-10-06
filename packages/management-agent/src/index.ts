export { AgentRegistry, localProjectId } from "./registry.js";
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
