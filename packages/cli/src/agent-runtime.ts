import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AgentTransportError,
  CommandExecutor,
  CommandJournal,
  createAgentTransport,
  createInventorySnapshot,
  createLinuxProjectLaunchContext,
  launchMacOSProject,
  runForegroundAgent,
  type AgentIdentity,
  type ProjectIdentityResolver,
} from "@gh-symphony/management-agent";
import type { AgentControlPlaneClient } from "@gh-symphony/management-protocol";
import {
  createLocalManagementAdapter,
  createLocalReadAdapter,
  type ProjectLaunchContext,
} from "./management-local.js";
import type { AgentHostConfig } from "./agent-config.js";
declare const __CLI_VERSION__: string;

/** Fleet UUID allocation has no v1 HTTP route yet. Never mint server identities locally. */
export interface AgentRuntimePorts {
  resolveIdentities?: ProjectIdentityResolver;
  client?: (
    identity: AgentIdentity,
    signal: AbortSignal
  ) => AgentControlPlaneClient;
}
export async function runAgentRuntime(
  config: AgentHostConfig,
  options: {
    signal: AbortSignal;
    nativeService?: "linux" | "darwin";
    ports?: AgentRuntimePorts;
    report?: (state: string, code?: string) => void;
  }
): Promise<void> {
  const ca = config.caFile ? await readFile(config.caFile) : undefined;
  await runForegroundAgent({
    directory: config.dataDirectory,
    agentVersion: __CLI_VERSION__,
    signal: options.signal,
    client:
      options.ports?.client ??
      ((identity, signal) =>
        createAgentTransport({
          serverOrigin: identity.serverOrigin,
          identity: () => identity,
          ca,
          signal,
        })),
    snapshot: async (registry, signal) => {
      const resolveIdentities: ProjectIdentityResolver =
        options.ports?.resolveIdentities ??
        (async (_environment, ids) => {
          if (ids.length) {
            options.report?.(
              "blocked",
              "inventory_identity_allocation_unavailable"
            );
            throw new AgentTransportError(
              "inventory_identity_allocation_unavailable",
              false
            );
          }
          return [];
        });
      return createInventorySnapshot({
        cliVersion: __CLI_VERSION__,
        resolveIdentities,
        reader: {
          inspect: async (project) => {
            const { inspectLocalProject } =
              await import("./management-local.js");
            return inspectLocalProject(config.projectConfigDir, project);
          },
        },
      })(registry, signal);
    },
    createDeliveryHandler: async ({ registry, client }) => {
      if (!client.claim || !client.publishResult)
        throw new Error("Agent command transport unavailable");
      const launchContext: ProjectLaunchContext =
        options.nativeService === "linux"
          ? createLinuxProjectLaunchContext({
              managementCredentials: [registry.identity!.credential],
            })
          : options.nativeService === "darwin"
            ? {
                kind: "native-service",
                launchIsolatedProject: launchMacOSProject,
              }
            : { kind: "foreground" };
      const journal = await CommandJournal.open(registry);
      const { adapter } = createLocalManagementAdapter(registry, {
        configDir: config.projectConfigDir,
        executable: config.nodePath,
        argumentPrefix: [config.cliPath],
        launchContext,
      });
      const executor = new CommandExecutor(registry, journal, adapter);
      const reader = createLocalReadAdapter(registry, config.projectConfigDir);
      const commandClient = {
        claim: client.claim.bind(client),
        publishResult: client.publishResult.bind(client),
      };
      return async (response) => {
        // Independent lanes: a command failure cannot discard a bounded read delivery.
        const results = await Promise.allSettled([
          executor.handlePoll(response, commandClient),
          (async () => {
            for (const request of response.reads) {
              const result = await reader.read(request);
              if (result.state === "pending")
                throw new Error("Local read did not complete");
              await commandClient.publishResult({
                protocolVersion: 1,
                environmentId: response.environmentId,
                sessionId: response.sessionId,
                requestId: randomUUID(),
                result: { kind: "read", result },
              });
            }
          })(),
        ]);
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      };
    },
    onConnection: options.report,
  });
}
