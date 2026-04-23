export const DEFAULT_CONTINUATION_GUIDANCE =
  "Continue working on the issue. Review your progress and complete any remaining tasks.";

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
  if (template.includes("{%") || template.includes("%}")) {
    throw new Error(
      "template_parse_error: continuation guidance does not support Liquid tags."
    );
  }

  let rendered = "";
  let lastIndex = 0;
  const pattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

  for (const match of template.matchAll(pattern)) {
    const matchedText = match[0];
    const expression = match[1];
    const index = match.index ?? 0;
    rendered += template.slice(lastIndex, index);

    if (!(expression in variables)) {
      throw new Error(
        `template_render_error: unsupported continuation guidance variable '${expression}'.`
      );
    }

    rendered += variables[expression] ?? "";
    lastIndex = index + matchedText.length;
  }

  rendered += template.slice(lastIndex);

  const strayLiquidExpression = rendered.match(/\{\{[^}]*\}\}/);
  if (strayLiquidExpression) {
    throw new Error(
      `template_parse_error: invalid continuation guidance expression '${strayLiquidExpression[0]}'.`
    );
  }

  return rendered;
}
