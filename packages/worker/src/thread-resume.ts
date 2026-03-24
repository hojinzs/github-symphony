export type ThreadBootstrapMode = "fresh" | "resume" | "soft-resume";

type BuildInitialTurnInputParams = {
  renderedPrompt: string;
  mode: ThreadBootstrapMode;
  lastTurnSummary?: string | null;
};

export function parseNonNegativeInteger(
  value: string | number | null | undefined
): number {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return Math.floor(parsed);
}

export function resolveRemainingTurns(
  maxTurns: number,
  cumulativeTurnCount: number
): number {
  return Math.max(
    0,
    parseNonNegativeInteger(maxTurns) - parseNonNegativeInteger(cumulativeTurnCount)
  );
}

export function buildInitialTurnInput({
  renderedPrompt,
  mode,
  lastTurnSummary,
}: BuildInitialTurnInputParams): string {
  if (mode === "fresh") {
    return renderedPrompt;
  }

  if (mode === "resume") {
    return [
      "Resume work on this issue using the existing thread context.",
      "Review the latest state in the thread and continue from where the previous worker stopped.",
    ].join(" ");
  }

  const normalizedSummary = lastTurnSummary?.trim() || "No previous turn summary was captured.";
  return [
    "Resume work on this issue from a previous worker session.",
    "",
    "Original issue instructions:",
    renderedPrompt,
    "",
    "Previous session summary:",
    normalizedSummary,
    "",
    "Use this summary as carry-over context, avoid restarting completed work, and finish the remaining tasks.",
  ].join("\n");
}
