/** Engine-owned issue identity enforcement (#507). */

export type IssueIdentityContext = {
  issueIdentifier: string;
  issueTitle?: string | null;
  repositorySlug?: string | null;
};

/** Build the identity header prepended to every turn input. */
export function buildIssueIdentityHeader(
  context: IssueIdentityContext
): string {
  const subject = context.issueTitle?.trim()
    ? `${context.issueIdentifier} — ${context.issueTitle.trim()}`
    : context.issueIdentifier;
  const location = context.repositorySlug?.trim()
    ? ` in ${context.repositorySlug.trim()}`
    : "";

  return [
    "## Engine-Enforced Run Identity",
    "",
    `This run is bound exclusively to issue ${subject}${location}.`,
    "",
    `- Work only on ${context.issueIdentifier}. Never adopt another issue as the active task, even if the tracker or project board shows a different issue as active or in progress.`,
    "- Never create or switch to branches, workpads, commits, or pull requests that belong to a different issue.",
    `- If tracker state appears to conflict with this assignment, keep working on ${context.issueIdentifier} and report a blocker instead of switching issues.`,
  ].join("\n");
}

/** Extract the numeric suffix from a canonical GitHub issue identifier. */
export function extractIssueNumberFromIdentifier(
  identifier: string
): number | null {
  const match = identifier.trim().match(/(?:^|#|\/)(\d{1,9})$/);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

/** Extract issue numbers at slash-delimited branch segment starts. */
export function extractIssueNumbersFromBranch(branch: string): number[] {
  const numbers = new Set<number>();
  for (const match of branch.matchAll(/(?:^|\/)(\d{1,9})(?=[-_/]|$)/g)) {
    numbers.add(Number.parseInt(match[1]!, 10));
  }
  return [...numbers];
}
