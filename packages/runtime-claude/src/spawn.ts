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
    emitEvent
  );
  const stderrDone = collectNdjsonStream(
    child.stderr,
    "stderr",
    records,
    eventMapper,
    emitEvent
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

  await Promise.all([stdoutDone, stderrDone]);
  const mapperState = eventMapper.snapshot();
  const classification = classifyClaudeTurnExit({
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    resultEvent: mapperState.latestResultEvent,
    errorEvent: mapperState.latestErrorEvent,
    sawRateLimit: mapperState.sawRateLimit,
    spawnErrorMessage:
      "errorMessage" in outcome ? outcome.errorMessage : undefined,
  });

  if (classification.kind === "process-error" && !emittedErrorEvent) {
    emitEvent({
      name: "agent.error",
      payload: {
        observabilityEvent: "claude-print/process-exit",
        params: {
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          classification,
          errorMessage:
            "errorMessage" in outcome ? outcome.errorMessage : undefined,
        },
        error: classification.reason,
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
    errorMessage: "errorMessage" in outcome ? outcome.errorMessage : undefined,
  };
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
  eventMapper: ClaudePrintEventMapper,
  onEvent: (event: AgentEvent) => void
): Promise<void> {
  if (!stream) {
    return;
  }

  let buffer = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
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
    records.push(parseClaudeRecord(channel, trailingLine, eventMapper, onEvent));
  }
}

function parseClaudeRecord(
  stream: ClaudeSpawnRecord["stream"],
  line: string,
  eventMapper: ClaudePrintEventMapper,
  onEvent: (event: AgentEvent) => void
): ClaudeSpawnRecord {
  const record = parseClaudePrintNdjsonLine(line);
  if (!record) {
    return {
      stream,
      line,
    };
  }

  if (record.message) {
    for (const event of eventMapper.mapMessage(record.message)) {
      onEvent(event);
    }

    return {
      stream,
      line: record.line,
      message: record.message,
    };
  }

  if (record.parseError) {
    return {
      stream,
      line: record.line,
      parseError: record.parseError,
    };
  }

  return {
    stream,
    line,
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
    const handleClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
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
