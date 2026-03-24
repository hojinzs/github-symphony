export type ThreadBootstrapMode = "fresh" | "resume" | "soft-resume";

export const DEFAULT_CONTINUATION_GUIDANCE =
  "Continue working on the issue. Review your progress and complete any remaining tasks.";

type BuildInitialTurnInputParams = {
  renderedPrompt: string;
  mode: ThreadBootstrapMode;
  lastTurnSummary?: string | null;
  cumulativeTurnCount?: number;
  continuationGuidance?: string | null;
};

type BuildContinuationTurnInputParams = {
  continuationGuidance?: string | null;
  lastTurnSummary?: string | null;
  cumulativeTurnCount?: number;
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
  cumulativeTurnCount = 0,
  continuationGuidance,
}: BuildInitialTurnInputParams): string {
  if (mode === "fresh") {
    return renderedPrompt;
  }

  const renderedContinuationGuidance = buildContinuationTurnInput({
    continuationGuidance,
    lastTurnSummary,
    cumulativeTurnCount,
  });
  const normalizedSummary =
    normalizeContinuationVariable(lastTurnSummary) ??
    "No previous turn summary was captured.";
  const normalizedCumulativeTurnCount = Math.max(
    0,
    parseNonNegativeInteger(cumulativeTurnCount)
  );

  if (mode === "resume") {
    return [
      "Resume work on this issue using the existing thread context.",
      `Previous worker turns completed: ${normalizedCumulativeTurnCount}.`,
      `Previous session summary: ${normalizedSummary}`,
      renderedContinuationGuidance,
    ].join("\n");
  }

  return [
    "Resume work on this issue from a previous worker session.",
    "",
    "Original issue instructions:",
    renderedPrompt,
    "",
    "Previous session summary:",
    normalizedSummary,
    "",
    renderedContinuationGuidance,
  ].join("\n");
}

export function buildContinuationTurnInput({
  continuationGuidance,
  lastTurnSummary,
  cumulativeTurnCount = 0,
}: BuildContinuationTurnInputParams): string {
  const template =
    continuationGuidance?.trim() || DEFAULT_CONTINUATION_GUIDANCE;

  return renderContinuationGuidance(template, {
    lastTurnSummary:
      normalizeContinuationVariable(lastTurnSummary) ??
      "No previous turn summary was captured.",
    cumulativeTurnCount: String(
      Math.max(0, parseNonNegativeInteger(cumulativeTurnCount))
    ),
  });
}

function normalizeContinuationVariable(
  value: string | null | undefined
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function renderContinuationGuidance(
  template: string,
  variables: Record<string, string>
): string {
  return template.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
    (match, key: string) => variables[key] ?? match
  );
}
