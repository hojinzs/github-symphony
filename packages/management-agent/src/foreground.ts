import { randomUUID } from "node:crypto";
import { hostname, platform } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  LIMITS,
  sessionResponseSchema,
  acknowledgmentSchema,
  pollResponseSchema,
  observationRequestSchema,
  type AgentControlPlaneClient,
  type AgentEnvelope,
  type ObservationRequest,
  type ProjectObservation,
  type PollResponse,
  type SessionResponse,
} from "@gh-symphony/management-protocol";
import { AgentRegistry, type AgentIdentity } from "./registry.js";
import { AgentTransportError } from "./transport.js";

export interface ForegroundOptions {
  directory: string;
  agentVersion: string;
  signal: AbortSignal;
  client: (
    identity: AgentIdentity,
    signal: AbortSignal
  ) => Pick<AgentControlPlaneClient, "openSession" | "observe" | "poll">;
  /** Supplies redacted current state. Exceptions retry with backoff; partial errors belong in observations. */
  snapshot: (
    registry: AgentRegistry,
    signal: AbortSignal
  ) => Promise<ProjectObservation[]>;
  /** Handles validated deliveries. Exceptions retry; the sibling journal must fence repeated effects. */
  handlePoll?: (response: PollResponse, signal: AbortSignal) => Promise<void>;
  onConnection?: (state: "online" | "retrying", code?: string) => void;
  random?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}
async function wait(ms: number, signal: AbortSignal) {
  try {
    await sleep(ms, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}
export function reconnectDelay(
  attempt: number,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(
    30_000,
    1_000 * 2 ** Math.min(30, Math.max(0, attempt))
  );
  return Math.floor(ceiling * (0.5 + Math.min(1, Math.max(0, random())) / 2));
}
/** One complete current revision. No previous snapshots are buffered across reconnection. */
export function observationPages(
  envelope: AgentEnvelope,
  projects: ProjectObservation[],
  sequence: number
): ObservationRequest[] {
  if (
    projects.length > LIMITS.managedProjectsPerAgent ||
    new Set(projects.map((p) => p.projectId)).size !== projects.length ||
    new Set(projects.map((p) => p.localProjectId)).size !== projects.length
  )
    throw new AgentTransportError("invalid_inventory", false);
  const revisionId = randomUUID();
  const observedAt = new Date().toISOString();
  function page(
    entries: ProjectObservation[],
    index: number,
    count: number
  ): ObservationRequest {
    return {
      ...envelope,
      requestId: randomUUID(),
      sequence: sequence + index,
      observedAt,
      inventory: {
        revisionId,
        pageIndex: index,
        pageCount: count,
        projects: entries,
      },
    };
  }
  const groups: ProjectObservation[][] = [[]];
  for (const project of projects) {
    const current = groups[groups.length - 1];
    // Reserve the largest permitted page-count/index and sequence width.
    const proposed = page([...current, project], 99, 100);
    proposed.sequence = Number.MAX_SAFE_INTEGER;
    if (
      Buffer.byteLength(JSON.stringify(proposed)) > LIMITS.observationBodyBytes
    ) {
      if (!current.length)
        throw new AgentTransportError("observation_too_large", false);
      groups.push([project]);
      const single = page([project], 99, 100);
      single.sequence = Number.MAX_SAFE_INTEGER;
      if (
        Buffer.byteLength(JSON.stringify(single)) > LIMITS.observationBodyBytes
      )
        throw new AgentTransportError("observation_too_large", false);
    } else current.push(project);
  }
  return groups.map((entries, index) =>
    observationRequestSchema.parse(page(entries, index, groups.length))
  );
}
function correlate<T extends AgentEnvelope>(output: T, sent: AgentEnvelope): T {
  if (
    output.requestId !== sent.requestId ||
    output.environmentId !== sent.environmentId ||
    output.sessionId !== sent.sessionId
  )
    throw new AgentTransportError("response_identity_mismatch", false);
  return output;
}
/** Holds the C03 local owner lock for its entire foreground lifetime. */
export async function runForegroundAgent(
  options: ForegroundOptions
): Promise<void> {
  const os = platform();
  if (os !== "linux" && os !== "darwin")
    throw new AgentTransportError("unsupported_os", false);
  const registry = await AgentRegistry.open(options.directory);
  const pause = options.wait ?? wait;
  let session: SessionResponse | undefined;
  let sequence = 0;
  let attempt = 0;
  try {
    const identity = registry.identity;
    if (!identity) throw new AgentTransportError("identity_required", false);
    while (!options.signal.aborted) {
      const connection = new AbortController();
      const signal = AbortSignal.any([options.signal, connection.signal]);
      let tasks: Promise<void>[] = [];
      try {
        const client = options.client(identity, signal);
        if (!session) {
          const request = {
            protocolVersion: 1 as const,
            requestId: randomUUID(),
            environmentId: identity.environmentId,
            agentId: identity.agentId,
            agentVersion: options.agentVersion,
            host: { hostname: hostname(), os },
          };
          const response = await client.openSession(request);
          try {
            session = sessionResponseSchema.parse(response);
          } catch (error) {
            if (error instanceof AgentTransportError) throw error;
            throw new AgentTransportError("invalid_peer_response", false);
          }
          if (
            session.environmentId !== request.environmentId ||
            session.requestId !== request.requestId
          )
            throw new AgentTransportError("response_identity_mismatch", false);
          sequence = 0;
        }
        const current = session;
        const envelope = (): AgentEnvelope => ({
          protocolVersion: 1,
          environmentId: identity.environmentId,
          sessionId: current.sessionId,
          requestId: randomUUID(),
        });
        async function observe() {
          let projects: ProjectObservation[];
          try {
            projects = await options.snapshot(registry, signal);
          } catch {
            throw new AgentTransportError("local_port_failure", true);
          }
          for (const request of observationPages(
            envelope(),
            projects,
            sequence
          )) {
            sequence = request.sequence + 1;
            correlate(
              acknowledgmentSchema.parse(await client.observe(request)),
              request
            );
          }
        }
        await observe(); // First signal, including zero projects, precedes command delivery.
        options.onConnection?.("online");
        tasks = [
          (async () => {
            while (!signal.aborted) {
              await pause(5_000, signal);
              if (!signal.aborted) await observe();
            }
          })(),
          (async () => {
            while (!signal.aborted) {
              const request = envelope();
              const response = correlate(
                pollResponseSchema.parse(await client.poll(request)),
                request
              );
              if (response.commands.length || response.reads.length) {
                if (!options.handlePoll)
                  throw new AgentTransportError(
                    "delivery_handler_required",
                    false
                  );
                try {
                  await options.handlePoll(response, signal);
                } catch {
                  throw new AgentTransportError("local_port_failure", true);
                }
              }
              // A successful poll proves recovery and resets consecutive failure backoff.
              attempt = 0;
              if (!signal.aborted) await pause(1_000, signal);
            }
          })(),
        ];
        await Promise.all(tasks);
      } catch (error) {
        connection.abort();
        await Promise.allSettled(tasks);
        if (options.signal.aborted) break;
        const failure =
          error instanceof AgentTransportError
            ? error
            : new AgentTransportError("foreground_failure", false);
        if (failure.code === "unauthenticated" && session) {
          // Distinguish expired session from revoked identity by a new authenticated negotiation.
          session = undefined;
        } else if (!failure.retryable && failure.code !== "session_conflict") {
          throw failure;
        }
        options.onConnection?.("retrying", failure.code);
        await pause(reconnectDelay(attempt++, options.random), options.signal);
      } finally {
        connection.abort();
        await Promise.allSettled(tasks);
      }
    }
  } finally {
    await registry.close();
  }
}
