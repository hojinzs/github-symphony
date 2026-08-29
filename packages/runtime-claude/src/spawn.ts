import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { AgentEvent } from "@gh-symphony/core";
import {
  classifyClaudeTurnExit,
  type ClaudeTurnExitKind,
  type ClaudeTurnExitClassification,
} from "./exit-classifier.js";
import {
  ClaudePrintEventMapper,
  parseClaudePrintNdjsonLine,
  type ClaudePrintWireEvent,
} from "./events.js";

export type ClaudeWireMessage = ClaudePrintWireEvent;

export type ClaudeSpawnRecord = {
  stream: "stdout" | "stderr";
  line: string;
  message?: ClaudeWireMessage;
  parseError?: string;
};

export type ClaudeSpawnTurnInput = {
  command?: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdinMessages: ClaudeWireMessage | readonly ClaudeWireMessage[];
  /** Maximum wait for the first child output. */
  initialOutputTimeoutMs?: number;
  /** Maximum silence interval; every stdout or stderr chunk resets it. */
  turnTimeoutMs?: number;
};

export type ClaudeSpawnTurnResult = {
  command: string;
  args: string[];
  cwd: string;
  records: ClaudeSpawnRecord[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  result: ClaudeTurnExitKind;
  classification: ClaudeTurnExitClassification;
  errorMessage?: string;
};

export type SpawnLike = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
) => ChildProcess;

export type ClaudeSpawnDependencies = {
  spawnImpl?: SpawnLike;
  onSpawned?: (child: ChildProcess) => void;
  onEvent?: (event: AgentEvent) => void;
};

export async function spawnClaudeTurn(
  input: ClaudeSpawnTurnInput,
  dependencies: ClaudeSpawnDependencies = {}
): Promise<ClaudeSpawnTurnResult> {
  const command = input.command ?? "claude";
  const child = (dependencies.spawnImpl ?? spawn)(command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: "pipe",
  });
  dependencies.onSpawned?.(child);

  const records: ClaudeSpawnRecord[] = [];
  const eventMapper = new ClaudePrintEventMapper();
  let timeoutMessage: string | undefined;
  let sawOutput = false;
  let readTimer: NodeJS.Timeout | undefined;
  let silenceTimer: NodeJS.Timeout | undefined;
  let terminationTimer: NodeJS.Timeout | undefined;
  const clearTimers = () => {
    if (readTimer) clearTimeout(readTimer);
    if (silenceTimer) clearTimeout(silenceTimer);
    if (terminationTimer) clearTimeout(terminationTimer);
    readTimer = undefined;
    silenceTimer = undefined;
    terminationTimer = undefined;
  };
  const terminateForTimeout = (message: string) => {
    if (timeoutMessage) return;
    timeoutMessage = message;
    try {
      child.kill("SIGTERM");
    } catch {
      // The child may already have exited while the timer fired.
    }
    terminationTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may have exited while the escalation timer fired.
      }
    }, 1_000);
  };
  const armSilenceTimer = () => {
    if (input.turnTimeoutMs && input.turnTimeoutMs > 0) {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(
        () =>
          terminateForTimeout(
            `turn_timeout: Claude produced no output for ${input.turnTimeoutMs}ms`
          ),
        input.turnTimeoutMs
      );
    }
  };
  const noteOutput = () => {
    sawOutput = true;
    if (readTimer) {
      clearTimeout(readTimer);
      readTimer = undefined;
    }
    armSilenceTimer();
  };
  if (input.initialOutputTimeoutMs && input.initialOutputTimeoutMs > 0) {
    readTimer = setTimeout(() => {
      if (!sawOutput) {
        terminateForTimeout(
          `response_timeout: Claude produced no output for ${input.initialOutputTimeoutMs}ms`
        );
      }
    }, input.initialOutputTimeoutMs);
  }
  // The initial silence interval begins when the child is launched; each
  // output chunk resets it, while the read timer remains until first output.
  armSilenceTimer();
  let emittedErrorEvent = false;
  const emitEvent = (event: AgentEvent) => {
    if (event.name === "agent.error") {
      emittedErrorEvent = true;
    }
    dependencies.onEvent?.(event);
  };
  const stdoutDone = collectNdjsonStream(
    child.stdout,
    "stdout",
    records,
    eventMapper,
    emitEvent,
    noteOutput
  );
  const stderrDone = collectNdjsonStream(
    child.stderr,
    "stderr",
    records,
    null,
    null,
    noteOutput
  );
  const exitDone = waitForChildExit(child, records);

  const stdinMessages = Array.isArray(input.stdinMessages)
    ? input.stdinMessages
    : [input.stdinMessages];

  for (const message of stdinMessages) {
    const didWrite = await writeToStdin(
      child.stdin,
      `${JSON.stringify(message)}\n`
    );

    if (!didWrite) {
      break;
    }
  }
  if (
    child.stdin &&
    !child.stdin.destroyed &&
    !child.stdin.writableEnded &&
    !child.stdin.writableFinished
  ) {
    child.stdin.end();
  }

  const outcome = await exitDone;
  clearTimers();

  await Promise.all([stdoutDone, stderrDone]);
  const mapperState = eventMapper.snapshot();
  const classification = timeoutMessage
    ? {
        kind: "process-error" as const,
        transient: true,
        reason: timeoutMessage,
      }
    : classifyClaudeTurnExit({
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        resultEvent: mapperState.latestResultEvent,
        errorEvent: mapperState.latestErrorEvent,
        sawRateLimit: mapperState.sawRateLimit,
        spawnErrorMessage:
          "errorMessage" in outcome ? outcome.errorMessage : undefined,
      });

  if (
    (classification.kind === "app-error" ||
      classification.kind === "process-error") &&
    !emittedErrorEvent
  ) {
    const stderrSummary = summarizeClaudeStderr(records);
    emitEvent({
      name: "agent.error",
      payload: {
        observabilityEvent:
          classification.kind === "app-error"
            ? "claude-print/app-error"
            : "claude-print/process-exit",
        params: {
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          classification,
          errorMessage:
            "errorMessage" in outcome ? outcome.errorMessage : undefined,
          stderr: stderrSummary ?? undefined,
        },
        error: stderrSummary
          ? `${classification.reason}: ${stderrSummary}`
          : classification.reason,
      },
    });
  }

  return {
    command,
    args: [...input.args],
    cwd: input.cwd,
    records,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    result: classification.kind,
    classification,
    errorMessage:
      timeoutMessage ??
      ("errorMessage" in outcome ? outcome.errorMessage : undefined),
  };
}

function summarizeClaudeStderr(records: ClaudeSpawnRecord[]): string | null {
  const stderrLines = records
    .filter((record) => record.stream === "stderr")
    .map((record) => record.line || record.parseError)
    .filter((line): line is string => Boolean(line?.trim()))
    .map((line) => line.trim());

  if (stderrLines.length === 0) {
    return null;
  }

  return stderrLines.slice(-3).join(" | ").slice(0, 1000);
}

export function classifyClaudeTurnResult(
  exitCode: number | null,
  signal: NodeJS.Signals | null
): ClaudeSpawnTurnResult["result"] {
  return classifyClaudeTurnExit({ exitCode, signal }).kind;
}

async function collectNdjsonStream(
  stream: NodeJS.ReadableStream | null | undefined,
  channel: ClaudeSpawnRecord["stream"],
  records: ClaudeSpawnRecord[],
  eventMapper: ClaudePrintEventMapper | null,
  onEvent: ((event: AgentEvent) => void) | null,
  onActivity: () => void
): Promise<void> {
  if (!stream) {
    return;
  }

  let buffer = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    onActivity();
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      records.push(parseClaudeRecord(channel, line, eventMapper, onEvent));
    }
  });

  try {
    await finished(stream);
  } catch (error) {
    records.push({
      stream: channel,
      line: "",
      parseError:
        error instanceof Error ? error.message : "Unknown stream error.",
    });
  }

  const trailingLine = buffer.trim();
  if (trailingLine.length > 0) {
    records.push(
      parseClaudeRecord(channel, trailingLine, eventMapper, onEvent)
    );
  }
}

function parseClaudeRecord(
  stream: ClaudeSpawnRecord["stream"],
  line: string,
  eventMapper: ClaudePrintEventMapper | null,
  onEvent: ((event: AgentEvent) => void) | null
): ClaudeSpawnRecord {
  // collectNdjsonStream filters empty lines before parsing, so this is non-null.
  const record = parseClaudePrintNdjsonLine(line)!;

  if (record.message) {
    if (!eventMapper) {
      return {
        stream,
        line: record.line,
        message: record.message,
      };
    }

    for (const event of eventMapper.mapMessage(record.message)) {
      onEvent?.(event);
    }

    return {
      stream,
      line: record.line,
      message: record.message,
    };
  }

  return {
    stream,
    line: record.line,
    parseError: record.parseError!,
  };
}

async function writeToStdin(
  stream: Writable | null | undefined,
  line: string
): Promise<boolean> {
  if (!stream || stream.destroyed || stream.writableEnded) {
    return false;
  }

  if (stream.write(line)) {
    return true;
  }

  return waitForDrainOrClosure(stream);
}

function waitForDrainOrClosure(stream: Writable): Promise<boolean> {
  return new Promise((resolve) => {
    const cleanup = () => {
      stream.removeListener("drain", handleDrain);
      stream.removeListener("close", handleClose);
      stream.removeListener("finish", handleFinish);
      stream.removeListener("error", handleError);
    };
    const handleDrain = () => {
      cleanup();
      resolve(true);
    };
    const handleClose = () => {
      cleanup();
      resolve(false);
    };
    const handleFinish = () => {
      cleanup();
      resolve(false);
    };
    const handleError = () => {
      cleanup();
      resolve(false);
    };

    stream.once("drain", handleDrain);
    stream.once("close", handleClose);
    stream.once("finish", handleFinish);
    stream.once("error", handleError);
  });
}

function waitForChildExit(
  child: ChildProcess,
  records: ClaudeSpawnRecord[]
): Promise<
  | {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      errorMessage?: undefined;
    }
  | {
      exitCode: null;
      signal: null;
      errorMessage: string;
    }
> {
  return new Promise((resolve) => {
    const handleClose = (
      exitCode: number | null,
      signal: NodeJS.Signals | null
    ) => {
      cleanup();
      resolve({ exitCode, signal });
    };
    const handleError = (error: Error) => {
      cleanup();
      records.push({
        stream: "stderr",
        line: "",
        parseError: error.message,
      });
      resolve({
        exitCode: null,
        signal: null,
        errorMessage: error.message,
      });
    };
    const cleanup = () => {
      child.removeListener("close", handleClose);
      child.removeListener("error", handleError);
    };

    child.on("close", handleClose);
    child.on("error", handleError);
  });
}
