import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { once } from "node:events";

export type ClaudeWireMessage = Record<string, unknown>;

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
  result: "success" | "process-error" | "cancelled";
};

export type SpawnLike = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
) => ChildProcess;

export type ClaudeSpawnDependencies = {
  spawnImpl?: SpawnLike;
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

  const records: ClaudeSpawnRecord[] = [];
  const stdoutDone = collectNdjsonStream(child.stdout, "stdout", records);
  const stderrDone = collectNdjsonStream(child.stderr, "stderr", records);

  const stdinMessages = Array.isArray(input.stdinMessages)
    ? input.stdinMessages
    : [input.stdinMessages];

  for (const message of stdinMessages) {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  }
  child.stdin?.end();

  const [exitCode, signal] = (await once(child, "close")) as [
    number | null,
    NodeJS.Signals | null,
  ];

  await Promise.all([stdoutDone, stderrDone]);

  return {
    command,
    args: [...input.args],
    cwd: input.cwd,
    records,
    exitCode,
    signal,
    result: classifyClaudeTurnResult(exitCode, signal),
  };
}

export function classifyClaudeTurnResult(
  exitCode: number | null,
  signal: NodeJS.Signals | null
): ClaudeSpawnTurnResult["result"] {
  if (signal === "SIGTERM") {
    return "cancelled";
  }

  if (exitCode === 0) {
    return "success";
  }

  return "process-error";
}

async function collectNdjsonStream(
  stream: NodeJS.ReadableStream | null | undefined,
  channel: ClaudeSpawnRecord["stream"],
  records: ClaudeSpawnRecord[]
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

      records.push(parseClaudeRecord(channel, line));
    }
  });

  await once(stream, "end");

  const trailingLine = buffer.trim();
  if (trailingLine.length > 0) {
    records.push(parseClaudeRecord(channel, trailingLine));
  }
}

function parseClaudeRecord(
  stream: ClaudeSpawnRecord["stream"],
  line: string
): ClaudeSpawnRecord {
  try {
    return {
      stream,
      line,
      message: JSON.parse(line) as ClaudeWireMessage,
    };
  } catch (error) {
    return {
      stream,
      line,
      parseError:
        error instanceof Error ? error.message : "Unknown JSON parse error.",
    };
  }
}
