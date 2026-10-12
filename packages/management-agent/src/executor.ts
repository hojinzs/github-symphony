import { randomUUID } from "node:crypto";
import {
  LIMITS,
  acknowledgmentSchema,
  claimResponseSchema,
  pollResponseSchema,
  type AgentControlPlaneClient,
  type AgentEnvelope,
  type PollResponse,
  type JsonValue,
} from "@gh-symphony/management-protocol";
import { AgentRegistry } from "./registry.js";
import { CommandJournal, sameCommand, type CommandResult } from "./journal.js";
import { LocalLifecycleAdapter, type LifecycleResult } from "./lifecycle.js";
import { AgentTransportError } from "./transport.js";

export type CommandClient = Pick<
  AgentControlPlaneClient,
  "claim" | "publishResult"
>;

/** The enrolled agent's durable executor. The registry owns its lifetime lock. */
export class CommandExecutor {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(
    private readonly registry: AgentRegistry,
    private readonly journal: CommandJournal,
    private readonly lifecycle: LocalLifecycleAdapter
  ) {}

  /** Call even on empty polls so receipt/result recovery never depends on redelivery. */
  async handlePoll(input: PollResponse, client: CommandClient): Promise<void> {
    const response = pollResponseSchema.parse(input);
    const identity = this.registry.identity;
    if (!identity || identity.environmentId !== response.environmentId)
      throw new AgentTransportError("response_identity_mismatch", false);
    for (const command of response.commands)
      await this.journal.receive(command);
    const entries = this.journal
      .list()
      .filter(
        (entry) =>
          (!entry.acknowledged || entry.result?.state === "unknown") &&
          !entry.retiredAt
      );
    // Bound local work even if retained recovery records outnumber one poll.
    const results: PromiseSettledResult<void>[] = [];
    for (
      let offset = 0;
      offset < entries.length;
      offset += LIMITS.activeCommandsPerAgent
    ) {
      results.push(
        ...(await Promise.allSettled(
          entries
            .slice(offset, offset + LIMITS.activeCommandsPerAgent)
            .map((entry) =>
              this.serialize(entry.command.localProjectId, () =>
                this.run(entry.command.commandId, response, client)
              )
            )
        ))
      );
    }
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  private async run(
    id: string,
    envelope: AgentEnvelope,
    client: CommandClient
  ): Promise<void> {
    let entry = this.journal.get(id)!;
    if (
      (entry.acknowledged && entry.result?.state !== "unknown") ||
      entry.retiredAt
    )
      return;
    const request = { ...wireEnvelope(envelope), commandId: id };
    let claim;
    try {
      claim = claimResponseSchema.parse(await client.claim(request));
    } catch (error) {
      if (
        error instanceof AgentTransportError &&
        error.code === "command_expired" &&
        !entry.claim?.claimedAt &&
        !entry.effectStartedAt
      ) {
        await this.journal.retire(id);
        return;
      }
      throw error;
    }
    correlate(claim, request);
    if (
      !sameCommand(entry.command, claim.command) ||
      claim.command.owner?.agentId !== entry.agentId
    )
      throw new AgentTransportError("claim_owner_conflict", false);
    await this.journal.recordClaim(id, claim.command);
    entry = this.journal.get(id)!;
    if (
      claim.command.closure ||
      (entry.result?.state === "unknown" &&
        (claim.command.state === "succeeded" ||
          claim.command.state === "failed"))
    ) {
      await this.journal.retire(id);
      return;
    }
    if (entry.result?.state === "unknown" && entry.effectStartedAt) {
      const recovered = await this.inspectOutcome(
        entry.command.localProjectId,
        entry.command.operation,
        entry.canonicalPath,
        entry.stopTarget
      );
      if (recovered.state !== "unknown") {
        await this.journal.saveResult(id, makeResult(id, recovered));
        entry = this.journal.get(id)!;
      }
    }
    if (!entry.result) {
      if (
        claim.command.state === "succeeded" ||
        claim.command.state === "failed" ||
        claim.command.closure
      ) {
        await this.journal.retire(id);
        return;
      }
      let outcome: LifecycleResult;
      if (entry.effectStartedAt) {
        outcome = await this.inspectOutcome(
          entry.command.localProjectId,
          entry.command.operation,
          entry.canonicalPath,
          entry.stopTarget
        );
      } else if (claim.command.state !== "executing") {
        // Unknown/terminal replay never restores permission, even without a marker.
        outcome = unknownOutcome();
      } else {
        const deadline =
          Date.parse(claim.command.claimedAt!) +
          LIMITS.executionObservationTimeoutMs;
        if (deadline <= Date.now()) {
          outcome = unknownOutcome();
        } else if (await this.journal.beginEffect(id)) {
          try {
            outcome =
              entry.command.operation === "start"
                ? await this.lifecycle.start(
                    entry.command.localProjectId,
                    deadline
                  )
                : await this.lifecycle.stop(
                    entry.command.localProjectId,
                    {
                      persistStopTarget: (target) =>
                        this.journal.persistStopTarget(id, target),
                    },
                    undefined,
                    deadline
                  );
          } catch {
            // A driver/persistence exception cannot prove an effect failed.
            // Keep diagnostics fixed: local exception text may contain credentials.
            outcome = unknownOutcome();
          }
        } else {
          const current = this.journal.get(id)!;
          outcome = await this.inspectOutcome(
            current.command.localProjectId,
            current.command.operation,
            current.canonicalPath,
            current.stopTarget
          );
        }
      }
      await this.journal.saveResult(id, makeResult(id, outcome));
    }
    if (this.journal.get(id)!.acknowledged) return;
    const result = this.journal.get(id)!.result!;
    const upload = { ...wireEnvelope(envelope), result };
    const acknowledgment = acknowledgmentSchema.parse(
      await client.publishResult(upload)
    );
    correlate(acknowledgment, upload);
    await this.journal.acknowledge(id);
  }
  private async inspectOutcome(
    ...args: Parameters<LocalLifecycleAdapter["reconcile"]>
  ): Promise<LifecycleResult> {
    try {
      return await this.lifecycle.reconcile(...args);
    } catch {
      return unknownOutcome();
    }
  }
  private serialize(
    projectId: string,
    action: () => Promise<void>
  ): Promise<void> {
    const previous = this.pending.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.pending.set(projectId, current);
    void current
      .finally(() => {
        if (this.pending.get(projectId) === current)
          this.pending.delete(projectId);
      })
      .catch(() => {});
    return current;
  }
}
function wireEnvelope(input: AgentEnvelope): AgentEnvelope {
  return {
    protocolVersion: 1,
    environmentId: input.environmentId,
    sessionId: input.sessionId,
    requestId: randomUUID(),
  };
}
function correlate(response: AgentEnvelope, request: AgentEnvelope): void {
  if (
    response.requestId !== request.requestId ||
    response.environmentId !== request.environmentId ||
    response.sessionId !== request.sessionId
  )
    throw new AgentTransportError("response_identity_mismatch", false);
}
function unknownOutcome(): LifecycleResult {
  const diagnostic = {
    code: "unresolved_command" as const,
    message:
      "Durable operation could not be verified; reconcile or explicitly close it without blind replay",
  };
  return {
    state: "unknown",
    process: {
      state: "unknown",
      observedAt: new Date().toISOString(),
      diagnostic,
    },
    diagnostic,
  };
}
function makeResult(id: string, outcome: LifecycleResult): CommandResult {
  const process = outcome.process;
  const evidence: JsonValue =
    process.state === "running"
      ? {
          state: process.state,
          observedAt: process.observedAt,
          pid: process.pid,
          identity: process.identity,
        }
      : process.state === "unknown"
        ? {
            state: process.state,
            observedAt: process.observedAt,
            diagnostic: { ...process.diagnostic },
          }
        : { state: process.state, observedAt: process.observedAt };
  return {
    kind: "command",
    commandId: id,
    state: outcome.state,
    observedAt: new Date().toISOString(),
    evidence: { verified: outcome.state !== "unknown", process: evidence },
    ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}),
  };
}
