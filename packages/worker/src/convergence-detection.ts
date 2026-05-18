import { spawnSync } from "node:child_process";

const DEFAULT_MAX_NONPRODUCTIVE_TURNS = 3;

export type TurnWorkspaceSnapshot = {
  fingerprint: string | null;
  changedFiles: string[];
  headSha: string | null;
};

export type TurnProgressSnapshot = TurnWorkspaceSnapshot & {
  lastError: string | null;
};

export type TurnProgressEvaluation = {
  nonProductive: boolean;
  repeatedPattern: boolean;
  reason: string | null;
  headChanged: boolean;
  fingerprintUnchanged: boolean;
};

export function resolveMaxNonProductiveTurns(
  env: NodeJS.ProcessEnv
): number {
  const rawValue = env.SYMPHONY_MAX_NONPRODUCTIVE_TURNS;
  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_NONPRODUCTIVE_TURNS;
}

export function captureTurnWorkspaceSnapshot(
  cwd: string
): TurnWorkspaceSnapshot {
  const headSha = captureGitHeadSha(cwd);
  const result = spawnSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd,
      encoding: "utf8",
    }
  );

  if (result.status !== 0) {
    return {
      fingerprint: null,
      changedFiles: [],
      headSha,
    };
  }

  const changedFiles = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .sort();

  return {
    fingerprint: changedFiles.join("\n"),
    changedFiles,
    headSha,
  };
}

export function evaluateTurnProgress(
  previous: TurnProgressSnapshot,
  current: TurnProgressSnapshot
): TurnProgressEvaluation {
  const headChanged =
    previous.headSha !== null &&
    current.headSha !== null &&
    previous.headSha !== current.headSha;
  const fingerprintUnchanged =
    previous.fingerprint !== null &&
    current.fingerprint !== null &&
    previous.fingerprint === current.fingerprint;
  const normalizedPreviousError = normalizeError(previous.lastError);
  const normalizedCurrentError = normalizeError(current.lastError);
  const repeatedError =
    normalizedPreviousError !== null &&
    normalizedCurrentError !== null &&
    normalizedPreviousError === normalizedCurrentError;

  if (headChanged) {
    return {
      nonProductive: false,
      repeatedPattern: false,
      reason: null,
      headChanged,
      fingerprintUnchanged,
    };
  }

  if (repeatedError) {
    return {
      nonProductive: true,
      repeatedPattern: true,
      reason: `repeated error: ${normalizedCurrentError}`,
      headChanged,
      fingerprintUnchanged,
    };
  }

  if (fingerprintUnchanged) {
    return {
      nonProductive: true,
      repeatedPattern: true,
      reason:
        current.changedFiles.length > 0
          ? `workspace diff unchanged (${current.changedFiles.length} tracked change${current.changedFiles.length === 1 ? "" : "s"})`
          : "workspace unchanged",
      headChanged,
      fingerprintUnchanged,
    };
  }

  return {
    nonProductive: false,
    repeatedPattern: false,
    reason: null,
    headChanged,
    fingerprintUnchanged,
  };
}

function captureGitHeadSha(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return null;
  }

  const headSha = result.stdout.trim();
  return headSha.length > 0 ? headSha : null;
}

function normalizeError(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
