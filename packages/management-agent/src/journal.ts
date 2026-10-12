import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  agentResultSchema,
  LIMITS,
  commandRecordSchema,
  lifecycleCommandSchema,
  type AgentResult,
  type CommandRecord,
  type LifecycleCommand,
} from "@gh-symphony/management-protocol";
import type { AgentRegistry } from "./registry.js";
import type { StopTarget } from "./lifecycle.js";

export type CommandResult = Extract<AgentResult, { kind: "command" }>;
export interface JournalEntry {
  command: LifecycleCommand;
  agentId: string;
  canonicalPath: string;
  claim?: CommandRecord;
  effectStartedAt?: string;
  stopTarget?: StopTarget;
  result?: CommandResult;
  acknowledged?: boolean;
  acknowledgedAt?: string;
  retiredAt?: string;
}
interface JournalState {
  version: 1;
  entries: JournalEntry[];
}

/** Shares the registry's lifetime owner lock. Every boundary is fsynced before returning. */
export class CommandJournal {
  private static readonly instances = new WeakMap<
    AgentRegistry,
    Promise<CommandJournal>
  >();
  private writes: Promise<unknown> = Promise.resolve();
  private constructor(
    private registry: AgentRegistry,
    private state: JournalState
  ) {}

  static open(registry: AgentRegistry): Promise<CommandJournal> {
    registry.list(); // Reject closed owners; never acquire an unrelated lifetime lock.
    let instance = this.instances.get(registry);
    if (!instance) {
      instance = this.load(registry);
      this.instances.set(registry, instance);
      void instance.catch(() => this.instances.delete(registry));
    }
    return instance;
  }
  private static async load(registry: AgentRegistry): Promise<CommandJournal> {
    const path = join(registry.directory, "commands.json");
    let state: JournalState = { version: 1, entries: [] };
    try {
      await privateFile(path);
      state = parseState(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const identity = registry.identity;
    if (
      state.entries.some(
        (entry) =>
          !identity ||
          entry.agentId !== identity.agentId ||
          entry.command.environmentId !== identity.environmentId
      )
    )
      throw new Error("Journal belongs to another enrolled identity");
    return new CommandJournal(registry, state);
  }
  list(): JournalEntry[] {
    this.registry.list();
    return structuredClone(this.state.entries);
  }
  get(id: string): JournalEntry | undefined {
    return this.list().find((entry) => entry.command.commandId === id);
  }
  async receive(command: LifecycleCommand): Promise<JournalEntry> {
    const parsed = lifecycleCommandSchema.parse(command);
    const identity = this.registry.identity;
    if (!identity || parsed.environmentId !== identity.environmentId)
      throw new Error("Command targets another enrolled identity");
    const project = await this.registry.resolveManaged(parsed.localProjectId);
    await this.update((entries) => {
      const existing = entries.find(
        (entry) => entry.command.commandId === parsed.commandId
      );
      if (existing) {
        if (
          !sameCommand(existing.command, parsed) ||
          existing.canonicalPath !== project.canonicalPath
        )
          throw new Error("Command ID conflicts with durable receipt");
        return;
      }
      // The authoritative ledger owns the per-project command slot. A later
      // delivery can follow expiry/explicit closure while an older receipt is
      // still retained locally; the executor serializes all project effects.
      entries.push({
        command: parsed,
        agentId: identity.agentId,
        canonicalPath: project.canonicalPath,
      });
    });
    return this.get(parsed.commandId)!;
  }
  async recordClaim(id: string, record: CommandRecord): Promise<void> {
    const claim = commandRecordSchema.parse(record);
    await this.change(id, (entry) => {
      if (
        !sameCommand(entry.command, claim) ||
        (claim.owner && claim.owner.agentId !== entry.agentId)
      )
        throw new Error("Claim does not own durable command");
      if (entry.claim?.claimedAt && entry.claim.claimedAt !== claim.claimedAt)
        throw new Error("Claim replay changed original claim time");
      entry.claim = claim;
    });
  }
  /** Returns false for every replay, including a crash before actual invocation. */
  async beginEffect(id: string): Promise<boolean> {
    let started = false;
    await this.change(id, (entry) => {
      if (entry.effectStartedAt || entry.result) return;
      if (entry.claim?.state !== "executing")
        throw new Error("Executing claim required before effect");
      entry.effectStartedAt = new Date().toISOString();
      started = true;
    });
    return started;
  }
  async persistStopTarget(id: string, target: StopTarget): Promise<void> {
    await this.change(id, (entry) => {
      if (
        entry.command.operation !== "stop" ||
        !entry.effectStartedAt ||
        target.canonicalPath !== entry.canonicalPath
      )
        throw new Error("Stop target requires matching durable effect");
      if (
        entry.stopTarget &&
        JSON.stringify(entry.stopTarget) !== JSON.stringify(target)
      )
        throw new Error("Cannot replace journaled stop target");
      entry.stopTarget = structuredClone(target);
    });
  }
  async saveResult(id: string, value: CommandResult): Promise<void> {
    const result = agentResultSchema.parse(value) as CommandResult;
    await this.change(id, (entry) => {
      if (
        result.kind !== "command" ||
        result.commandId !== id ||
        !entry.claim?.claimedAt
      )
        throw new Error("Result requires original durable claim");
      if (
        entry.result &&
        JSON.stringify(entry.result) !== JSON.stringify(result)
      ) {
        if (entry.result.state !== "unknown" || result.state === "unknown")
          throw new Error("Cannot replace durable result");
        delete entry.acknowledged;
        delete entry.acknowledgedAt;
      }
      entry.result = result;
    });
  }
  async acknowledge(id: string): Promise<void> {
    await this.change(id, (entry) => {
      if (!entry.result) throw new Error("Cannot acknowledge missing result");
      entry.acknowledged = true;
      entry.acknowledgedAt ??= new Date().toISOString();
    });
  }
  /** Authoritative expiry/terminal state retires a receipt without fabricating a result. */
  async retire(id: string): Promise<void> {
    await this.change(id, (entry) => {
      entry.retiredAt ??= new Date().toISOString();
    });
  }
  async prune(now = new Date()): Promise<void> {
    await this.update((entries) => {
      const cutoff =
        now.getTime() - LIMITS.journalRetentionAfterAcknowledgmentMs;
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        const completedAt =
          entry.retiredAt ??
          (entry.result?.state !== "unknown"
            ? entry.acknowledgedAt
            : undefined);
        if (completedAt && Date.parse(completedAt) <= cutoff)
          entries.splice(index, 1);
      }
    });
  }
  private change(
    id: string,
    action: (entry: JournalEntry) => void
  ): Promise<void> {
    return this.update((entries) => {
      const entry = entries.find(
        (candidate) => candidate.command.commandId === id
      );
      if (!entry) throw new Error("Durable command receipt required");
      action(entry);
    });
  }
  private update(action: (entries: JournalEntry[]) => void): Promise<void> {
    const previous = this.writes;
    const task = this.registry.whileOwned(() =>
      previous.then(async () => {
        const next = structuredClone(this.state);
        action(next.entries);
        parseState(JSON.stringify(next));
        const path = join(this.registry.directory, "commands.json");
        const temporary = join(
          this.registry.directory,
          `.commands-${randomUUID()}`
        );
        try {
          const handle = await open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(JSON.stringify(next) + "\n");
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, path);
          const directory = await open(this.registry.directory, "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
          this.state = next;
        } finally {
          await rm(temporary, { force: true });
        }
      })
    );
    this.writes = task.catch(() => {});
    return task;
  }
}
/** Session ownership may transfer, but the original submitted command is immutable. */
export function sameCommand(
  left: LifecycleCommand,
  right: LifecycleCommand
): boolean {
  return (
    left.commandId === right.commandId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId &&
    left.localProjectId === right.localProjectId &&
    left.operation === right.operation &&
    left.actor === right.actor &&
    left.idempotencyKey === right.idempotencyKey &&
    left.submittedAt === right.submittedAt &&
    left.expiresAt === right.expiresAt
  );
}
async function privateFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o600
  )
    throw new Error(
      "Command journal must be a private user-owned regular file"
    );
}
function parseState(text: string): JournalState {
  const state = JSON.parse(text) as JournalState;
  if (state.version !== 1 || !Array.isArray(state.entries))
    throw new Error("Invalid command journal version");
  const ids = new Set<string>();
  for (const entry of state.entries) {
    const command = lifecycleCommandSchema.parse(entry.command);
    if (
      ids.has(command.commandId) ||
      typeof entry.canonicalPath !== "string" ||
      !entry.canonicalPath.startsWith("/") ||
      typeof entry.agentId !== "string"
    )
      throw new Error("Invalid durable command identity");
    ids.add(command.commandId);
    if (entry.claim) {
      const claim = commandRecordSchema.parse(entry.claim);
      if (
        !sameCommand(command, claim) ||
        (claim.owner && claim.owner.agentId !== entry.agentId)
      )
        throw new Error("Invalid journal claim");
    }
    if (
      entry.effectStartedAt &&
      (!entry.claim?.claimedAt ||
        !Number.isFinite(Date.parse(entry.effectStartedAt)))
    )
      throw new Error("Invalid durable effect marker");
    if (entry.stopTarget) {
      const target = entry.stopTarget;
      if (
        !entry.effectStartedAt ||
        command.operation !== "stop" ||
        target.canonicalPath !== entry.canonicalPath ||
        !Number.isSafeInteger(target.pid) ||
        target.pid < 1 ||
        !target.processIdentity ||
        !target.configDir ||
        !target.runtimeProjectId
      )
        throw new Error("Invalid journal stop target");
    }
    if (entry.result) {
      const result = agentResultSchema.parse(entry.result);
      if (
        result.kind !== "command" ||
        result.commandId !== command.commandId ||
        !entry.claim?.claimedAt
      )
        throw new Error("Invalid durable result");
    }
    if (entry.acknowledged && !entry.result)
      throw new Error("Invalid result acknowledgment");
  }
  return state;
}
