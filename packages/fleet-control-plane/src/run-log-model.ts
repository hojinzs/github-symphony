import {
  LIMITS,
  readResultSchema,
  readSelectionSchema,
  type LogStream,
  type ReadSelection,
} from "@gh-symphony/management-protocol";

export interface LogIdentity {
  environmentId: string;
  projectId: string;
  runId: string;
  stream: LogStream;
}
export type LogPhase =
  | "empty"
  | "loading"
  | "ready"
  | "reset-required"
  | "unavailable"
  | "expired"
  | "offline";

/** Browser-local state only: never persists raw logs or chooses filesystem paths. */
export class RunLogModel {
  readonly identity: Readonly<LogIdentity>;
  phase: LogPhase = "empty";
  text = "";
  cursor: string | undefined;
  fetchedAt: string | undefined;
  historical = false;
  following = false;
  online = true;
  private revision = 0;
  private pending: number | undefined;
  private needsReset = false;

  constructor(identity: LogIdentity, knownRunIds: readonly string[]) {
    if (!knownRunIds.includes(identity.runId))
      throw new Error("Unknown run selection");
    readSelectionSchema.parse({
      kind: "log-chunk",
      runId: identity.runId,
      stream: identity.stream,
      maxBytes: LIMITS.logChunkBytes,
    });
    this.identity = Object.freeze({ ...identity });
  }

  begin(): { revision: number; selection: ReadSelection } | undefined {
    if (
      !this.online ||
      this.pending !== undefined ||
      this.phase === "reset-required"
    )
      return undefined;
    const revision = ++this.revision;
    this.pending = revision;
    this.phase = "loading";
    return {
      revision,
      selection: {
        kind: "log-chunk",
        runId: this.identity.runId,
        stream: this.identity.stream,
        maxBytes: LIMITS.logChunkBytes,
        ...(this.cursor === undefined ? {} : { cursor: this.cursor }),
      },
    };
  }

  receive(revision: number, input: unknown, historical = false): void {
    if (revision !== this.pending) return;
    const result = readResultSchema.parse(input);
    if (result.state === "pending") return;
    if (result.state === "completed") {
      const payload = result.payload;
      if (
        payload.kind !== "log-chunk" ||
        payload.runId !== this.identity.runId ||
        payload.stream !== this.identity.stream
      )
        throw new Error("Mismatched log result");
      this.pending = undefined;
      if (payload.reset) {
        this.needsReset = true;
        this.phase = "reset-required";
        this.following = false;
        this.historical = true;
        return;
      }
      // Bound retained text as well as each wire chunk. Evict whole Unicode
      // code points so a byte limit never splits a surrogate pair.
      const points = Array.from(this.text + payload.text);
      let bytes = new TextEncoder().encode(points.join("")).length;
      let start = 0;
      while (bytes > LIMITS.logChunkBytes)
        bytes -= new TextEncoder().encode(points[start++]).length;
      this.text = points.slice(start).join("");
      this.cursor = payload.cursor;
      this.fetchedAt = result.completedAt;
      this.historical = historical;
      this.phase = "ready";
      if (historical) this.following = false;
      return;
    }
    this.pending = undefined;
    this.phase = result.state;
    this.following = false;
    this.historical = true;
  }

  pause(): void {
    this.following = false;
  }

  follow(): void {
    if (this.online && this.phase !== "reset-required") this.following = true;
  }

  disconnect(): void {
    this.online = false;
    this.following = false;
    this.historical = true;
    this.pending = undefined;
    this.phase = "offline";
  }

  reconnect(): void {
    this.online = true;
    // Reconnection alone never resumes reads or makes retained text current.
    if (this.phase === "offline")
      this.phase = this.needsReset ? "reset-required" : "ready";
  }

  reset(): void {
    if (!this.online) return;
    this.pending = undefined;
    this.needsReset = false;
    this.cursor = undefined;
    this.text = "";
    this.fetchedAt = undefined;
    this.following = false;
    this.phase = "empty";
  }
}
