import type { DetectedEnvironment } from "../detection/environment-detector.js";

export type RepositoryGuidanceInput = Pick<
  DetectedEnvironment,
  "packageManager" | "testCommand" | "lintCommand" | "buildCommand" | "monorepo"
>;

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function renderInlineCode(command: string): string {
  const normalized = normalizeCommand(command);
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(normalized.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = "`".repeat(longestBacktickRun + 1);
  const padded =
    normalized.startsWith("`") || normalized.endsWith("`")
      ? ` ${normalized} `
      : normalized;

  return `${fence}${padded}${fence}`;
}

function buildRunnableScriptCommand(
  packageManager: RepositoryGuidanceInput["packageManager"],
  scriptName: "test" | "lint" | "build"
): string | null {
  switch (packageManager) {
    case "pnpm":
      return scriptName === "test" ? "pnpm test" : `pnpm ${scriptName}`;
    case "npm":
      return scriptName === "test" ? "npm test" : `npm run ${scriptName}`;
    case "yarn":
      return `yarn ${scriptName}`;
    case "bun":
      return `bun run ${scriptName}`;
    default:
      return null;
  }
}

function formatDetectedCommand(
  label: "test" | "lint" | "build",
  rawCommand: string | null,
  packageManager: RepositoryGuidanceInput["packageManager"]
): string | null {
  if (!rawCommand) {
    return null;
  }

  const runnableCommand = buildRunnableScriptCommand(packageManager, label);
  const normalizedRawCommand = normalizeCommand(rawCommand);

  if (!runnableCommand) {
    return `${label}: ${renderInlineCode(normalizedRawCommand)}`;
  }

  if (normalizeCommand(runnableCommand) === normalizedRawCommand) {
    return `${label}: ${renderInlineCode(runnableCommand)}`;
  }

  return `${label}: ${renderInlineCode(runnableCommand)} (script: ${renderInlineCode(
    normalizedRawCommand
  )})`;
}

export function buildRepositoryValidationGuidance(
  input: RepositoryGuidanceInput
): string[] {
  const lines: string[] = [];
  const commands = [
    formatDetectedCommand("test", input.testCommand, input.packageManager),
    formatDetectedCommand("lint", input.lintCommand, input.packageManager),
    formatDetectedCommand("build", input.buildCommand, input.packageManager),
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
