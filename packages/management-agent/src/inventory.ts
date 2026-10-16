import {
  uuidSchema,
  projectObservationSchema,
  type ProjectIdentity,
  type ProjectObservation,
} from "@gh-symphony/management-protocol";
import type { AgentRegistry, LocalInventoryReader } from "./registry.js";
import { AgentTransportError } from "./transport.js";

/** Trusted transport/composition port. The fleet allocates UUIDs, never paths.
 * The consumer authenticates the enrolled environment; no allocation HTTP
 * endpoint is implied by this library interface. */
export type ProjectIdentityResolver = (
  environmentId: string,
  localProjectIds: string[],
  signal: AbortSignal
) => Promise<ProjectIdentity[]>;

/** Direct ForegroundOptions.snapshot implementation, with no outage buffer. */
export function createInventorySnapshot(options: {
  reader: LocalInventoryReader;
  cliVersion: string;
  resolveIdentities: ProjectIdentityResolver;
}): (
  registry: AgentRegistry,
  signal: AbortSignal
) => Promise<ProjectObservation[]> {
  return async (registry, signal) => {
    signal.throwIfAborted();
    const identity = registry.identity;
    if (!identity) throw new AgentTransportError("identity_required", false);
    const inventory = await registry.inventory(
      options.reader,
      options.cliVersion
    );
    signal.throwIfAborted();
    const ids = inventory.map((p) => p.localProjectId);
    const allocated = await options.resolveIdentities(
      identity.environmentId,
      ids,
      signal
    );
    signal.throwIfAborted();
    try {
      if (
        allocated.length !== ids.length ||
        new Set(allocated.map((p) => p.localProjectId)).size !== ids.length ||
        new Set(allocated.map((p) => p.projectId)).size !== ids.length
      )
        throw new Error();
      for (const p of allocated) {
        uuidSchema.parse(p.projectId);
        if (
          p.environmentId !== identity.environmentId ||
          !ids.includes(p.localProjectId)
        )
          throw new Error();
      }
      const byLocal = new Map(
        allocated.map((p) => [p.localProjectId, p.projectId])
      );
      return inventory.map((p) =>
        projectObservationSchema.parse({
          ...p,
          projectId: byLocal.get(p.localProjectId),
        })
      );
    } catch {
      throw new AgentTransportError("invalid_inventory_identity", false);
    }
  };
}
