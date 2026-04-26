import {
  extractRateLimit,
  getClaudeResultStatus,
  isClaudeResultError,
  type ClaudePrintWireEvent,
} from "./events.js";

export type ClaudeTurnExitKind =
  | "success"
  | "app-error"
  | "process-error";

export type ClaudeTurnExitClassification = {
  kind: ClaudeTurnExitKind;
  transient: boolean;
  reason: string;
  resultStatus?: string;
};

export type ClaudeTurnExitClassificationInput = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  resultEvent?: ClaudePrintWireEvent | null;
  errorEvent?: ClaudePrintWireEvent | null;
  sawRateLimit?: boolean;
  spawnErrorMessage?: string;
};

const TRANSIENT_ERROR_PATTERNS = [
  /rate.?limit/i,
  /429/,
  /timeout/i,
  /timed?.?out/i,
  /temporar/i,
  /overload/i,
  /unavailable/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
];

export function classifyClaudeTurnExit(
  input: ClaudeTurnExitClassificationInput
): ClaudeTurnExitClassification {
  const resultStatus = getClaudeResultStatus(input.resultEvent);

  if (input.exitCode === 0 && input.resultEvent && !isClaudeResultError(input.resultEvent)) {
    return {
      kind: "success",
      transient: false,
      reason: "result_success",
      resultStatus,
    };
  }

  if (input.exitCode === 0 && input.resultEvent && isClaudeResultError(input.resultEvent)) {
    return {
      kind: "app-error",
      transient: isTransientClaudeFailure(input),
      reason: resultStatus ?? "result_error",
      resultStatus,
    };
  }

  return {
    kind: "process-error",
    transient: isTransientClaudeFailure(input),
    reason: describeProcessFailure(input),
    resultStatus,
  };
}

export function isTransientClaudeFailure(
  input: ClaudeTurnExitClassificationInput
): boolean {
  if (input.sawRateLimit || extractRateLimit(input.resultEvent ?? {}) !== null) {
    return true;
  }

  if (input.signal === "SIGTERM" || input.signal === "SIGINT") {
    return true;
  }

  const text = [
    input.spawnErrorMessage,
    input.errorEvent ? JSON.stringify(input.errorEvent) : undefined,
    input.resultEvent ? JSON.stringify(input.resultEvent) : undefined,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");

  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function describeProcessFailure(
  input: ClaudeTurnExitClassificationInput
): string {
  if (input.signal) {
    return `signal_${input.signal}`;
  }

  if (input.spawnErrorMessage) {
    return input.spawnErrorMessage;
  }

  if (typeof input.exitCode === "number") {
    return `exit_${input.exitCode}`;
  }

  return "process_error";
}
