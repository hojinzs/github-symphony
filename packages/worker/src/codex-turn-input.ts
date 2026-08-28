import { buildIssueIdentityHeader } from "@gh-symphony/core";
import { buildContinuationTurnInput } from "./thread-resume.js";

export function buildCodexTurnInput({
  isFirstTurn,
  renderedPrompt,
  issueIdentifier,
  issueTitle,
  continuationGuidance,
  cumulativeTurnCount,
}: {
  isFirstTurn: boolean;
  renderedPrompt: string;
  issueIdentifier: string;
  issueTitle: string | null | undefined;
  continuationGuidance: string | null;
  cumulativeTurnCount: number;
}): string {
  if (isFirstTurn) {
    return renderedPrompt;
  }

  return [
    buildIssueIdentityHeader({
      issueIdentifier: issueIdentifier || "the assigned issue",
      issueTitle: issueTitle ?? null,
    }),
    "",
    buildContinuationTurnInput({
      continuationGuidance,
      cumulativeTurnCount,
    }),
  ].join("\n");
}
