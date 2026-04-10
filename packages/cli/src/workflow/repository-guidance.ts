import type { DetectedEnvironment } from "../detection/environment-detector.js";

export type RepositoryGuidanceInput = Pick<
  DetectedEnvironment,
  "packageManager" | "testCommand" | "lintCommand" | "buildCommand" | "monorepo"
>;

export function buildRepositoryValidationGuidance(
  input: RepositoryGuidanceInput
): string[] {
  const lines: string[] = [];
  const commands = [
    input.testCommand ? `test: \`${input.testCommand}\`` : null,
    input.lintCommand ? `lint: \`${input.lintCommand}\`` : null,
    input.buildCommand ? `build: \`${input.buildCommand}\`` : null,
  ].filter((value): value is string => value !== null);

  if (commands.length > 0) {
    lines.push(
      `Detected repository validation commands: ${commands.join(" ; ")}.`
    );
    lines.push(
      "Prefer these repository-defined commands over generic guesses when validating changes."
    );
    lines.push(
      "Use the smallest relevant command during iteration, then run the full available validation sequence before handoff in this order when applicable: test, lint, build."
    );
  } else {
    lines.push(
      "No repository-specific test/lint/build scripts were detected. Keep the generic fallback posture: infer the smallest meaningful validation command from the files you changed, and explicitly report when no automated validation is available."
    );
  }

  if (input.packageManager) {
    lines.push(
      `Use \`${input.packageManager}\` conventions for ad hoc install/run commands unless the repository clearly requires something else.`
    );
  }

  if (input.monorepo) {
    lines.push(
      "This repository appears to be a monorepo. Infer the affected package or workspace first, prefer workspace-scoped validation when available, and avoid unnecessary full-repo runs unless cross-package changes require them."
    );
  }

  return lines;
}
