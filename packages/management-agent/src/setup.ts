import type { AgentControlPlaneClient } from "@gh-symphony/management-protocol";
import { AgentRegistry, type AgentIdentity } from "./registry.js";
import { agentServerOrigin, enrollAgent } from "./transport.js";

/** Native adapters own OS lifecycle; setup never operates on managed projects. */
export interface SetupService {
  check(): Promise<string[]>;
  install(): Promise<void>;
  start(): Promise<void>;
}
export interface SetupOptions {
  directory: string;
  serverOrigin: string;
  client: Pick<AgentControlPlaneClient, "enroll">;
  readToken(): Promise<string>;
  service?: SetupService;
  report(
    stage: "prerequisites" | "enrolled" | "resumed" | "installed" | "started",
    limitations?: string[]
  ): void;
}

/** Release the shared owner lock before starting the service that acquires it. */
export async function setupAgent(
  options: SetupOptions
): Promise<AgentIdentity> {
  const origin = agentServerOrigin(options.serverOrigin);
  const registry = await AgentRegistry.open(options.directory);
  let identity: AgentIdentity;
  try {
    const saved = registry.identity;
    if (saved && saved.serverOrigin !== origin)
      throw new Error(
        "Saved agent belongs to another server; repair local configuration explicitly"
      );
    const limitations = await options.service?.check();
    options.report("prerequisites", limitations);
    identity = await enrollAgent(
      registry,
      options.client,
      origin,
      saved ? "" : await options.readToken()
    );
    options.report(saved ? "resumed" : "enrolled");
    if (options.service) {
      await options.service.install();
      options.report("installed");
    }
  } finally {
    await registry.close();
  }
  if (options.service) {
    await options.service.start();
    options.report("started");
  }
  return identity;
}
