/**
 * Engine-owned issue identity enforcement (#507).
 *
 * The Symphony engine — not the repository WORKFLOW.md template — is
 * responsible for telling the agent which issue a run is bound to, and for
 * deciding whether dirty workspace artifacts belong to that issue before any
 * recovery flow is allowed to commit and push them.
 */

export type IssueIdentityContext = {
  issueIdentifier: string;
  issueTitle?: string | null;
  repositorySlug?: string | null;
};

/**
 * Build the identity header the engine prepends to every turn input
 * (initial, continuation, and recovery), independent of the workflow
 * prompt template.
 */
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

/**
 * Extract the numeric issue number from a canonical issue identifier such as
 * `owner/repo#507`, `#507`, or `507`. Tracker-native identifiers such as
 * `TEAM-507` remain opaque here so legacy numeric consumers stay fail-closed.
 */
export function extractIssueNumberFromIdentifier(
  identifier: string
): number | null {
  const match = identifier.trim().match(/(?:^|#|\/)(\d{1,9})$/);
  if (!match) {
    return null;
  }

  return Number.parseInt(match[1]!, 10);
}

/**
 * Extract issue numbers encoded in a branch name using the conventional
 * `<prefix>/<issue-number>-<slug>` shape (for example `feat/507-identity`).
 * Only numbers at the start of a slash-delimited segment and followed by a
 * separator are considered, so version-like fragments such as `node-24`
 * are ignored.
 */
export function extractIssueNumbersFromBranch(branch: string): number[] {
  const numbers = new Set<number>();
  for (const match of branch.matchAll(/(?:^|\/)(\d{1,9})(?=[-_/]|$)/g)) {
    numbers.add(Number.parseInt(match[1]!, 10));
  }

  return [...numbers];
}

const WORKPAD_FILE_PATTERN = /(?:^|\/)\.gh-symphony\/workpads\/([^/]+)\.md$/;
const TRACKER_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d{1,9}$/;

function normalizeTrackerIdentifier(identifier: string): string | null {
  const normalized = identifier.trim();
  return TRACKER_IDENTIFIER_PATTERN.test(normalized)
    ? normalized.toUpperCase()
    : null;
}

/**
 * Tracker identifiers encoded in a branch name.
 *
 * Positive evidence accepts any `key-number` token at a segment start.
 * Foreign evidence additionally requires a slug after the token because a
 * segment-terminal token is indistinguishable from a version fragment and
 * must never outrank the issue's own evidence.
 */
function extractTrackerIdentifiersFromBranch(branch: string): {
  positive: string[];
  foreign: string[];
} {
  const positive = new Set<string>();
  const foreign = new Set<string>();
  for (const match of branch.matchAll(
    /(?:^|\/)([A-Za-z][A-Za-z0-9]*-\d{1,9})(?=([-_])|\/|$)/g
  )) {
    const identifier = match[1]!.toUpperCase();
    positive.add(identifier);
    if (match[2]) {
      foreign.add(identifier);
    }
  }

  return { positive: [...positive], foreign: [...foreign] };
}

function extractTrackerIdentifiersFromWorkpadFiles(
  dirtyFiles: string[]
): string[] {
  const identifiers = new Set<string>();
  for (const file of dirtyFiles) {
    const match = file.match(WORKPAD_FILE_PATTERN);
    const identifier = match ? normalizeTrackerIdentifier(match[1]!) : null;
    if (identifier) {
      identifiers.add(identifier);
    }
  }

  return [...identifiers];
}

/**
 * Extract issue numbers referenced by dirty workpad files
 * (`.gh-symphony/workpads/<n>.md`).
 */
export function extractIssueNumbersFromWorkpadFiles(
  dirtyFiles: string[]
): number[] {
  const numbers = new Set<number>();
  for (const file of dirtyFiles) {
    const match = file.match(WORKPAD_FILE_PATTERN);
    if (!match) {
      continue;
    }
    const numeric = match[1]!.match(/^(?:[A-Za-z][A-Za-z0-9]*-)?(\d{1,9})$/);
    if (numeric) {
      numbers.add(Number.parseInt(numeric[1]!, 10));
    }
  }

  return [...numbers];
}

export type DirtyWorkAttributionInput = {
  issueIdentifier: string;
  /** Current checked-out branch of the dirty workspace, when readable. */
  currentBranch?: string | null;
  dirtyFiles: string[];
  /** Branches known to belong to this issue (for example the tracker-linked PR head). */
  expectedBranches?: string[];
};

export type DirtyWorkAttribution = {
  attributed: boolean;
  reason: string;
};

/**
 * Decide whether dirty workspace state can be attributed to the run's issue.
 *
 * Fail-closed: attribution requires positive evidence (the issue's own
 * branch, a tracker-linked branch, or the issue's own workpad) and is
 * always denied when any artifact references a different issue.
 */
export function attributeDirtyWorkToIssue(
  input: DirtyWorkAttributionInput
): DirtyWorkAttribution {
  const issueNumber = extractIssueNumberFromIdentifier(input.issueIdentifier);
  const trackerIdentifier = normalizeTrackerIdentifier(input.issueIdentifier);
  const branch = input.currentBranch?.trim() || null;
  const branchNumbers = branch ? extractIssueNumbersFromBranch(branch) : [];
  const workpadNumbers = extractIssueNumbersFromWorkpadFiles(input.dirtyFiles);
  const branchTrackerIdentifiers = branch
    ? extractTrackerIdentifiersFromBranch(branch)
    : { positive: [], foreign: [] };
  const workpadTrackerIdentifiers = extractTrackerIdentifiersFromWorkpadFiles(
    input.dirtyFiles
  );

  const foreignBranchIdentifiers = branchTrackerIdentifiers.foreign.filter(
    (identifier) => identifier !== trackerIdentifier
  );
  if (foreignBranchIdentifiers.length > 0) {
    return {
      attributed: false,
      reason: `current branch '${branch}' references issue ${foreignBranchIdentifiers[0]} instead of ${input.issueIdentifier}`,
    };
  }

  const foreignWorkpadIdentifiers = workpadTrackerIdentifiers.filter(
    (identifier) => identifier !== trackerIdentifier
  );
  if (foreignWorkpadIdentifiers.length > 0) {
    return {
      attributed: false,
      reason: `dirty workpad references issue ${foreignWorkpadIdentifiers[0]} instead of ${input.issueIdentifier}`,
    };
  }

  if (!trackerIdentifier) {
    const foreignBranchNumbers = branchNumbers.filter(
      (number) => number !== issueNumber
    );
    if (foreignBranchNumbers.length > 0) {
      return {
        attributed: false,
        reason: `current branch '${branch}' references issue #${foreignBranchNumbers[0]} instead of ${input.issueIdentifier}`,
      };
    }

    const foreignWorkpadNumbers = workpadNumbers.filter(
      (number) => number !== issueNumber
    );
    if (foreignWorkpadNumbers.length > 0) {
      return {
        attributed: false,
        reason: `dirty workpad references issue #${foreignWorkpadNumbers[0]} instead of ${input.issueIdentifier}`,
      };
    }
  }

  if (branch && input.expectedBranches?.includes(branch)) {
    return {
      attributed: true,
      reason: `current branch '${branch}' is tracker-linked to ${input.issueIdentifier}`,
    };
  }

  if (
    trackerIdentifier &&
    branchTrackerIdentifiers.positive.includes(trackerIdentifier)
  ) {
    return {
      attributed: true,
      reason: `current branch '${branch}' references ${input.issueIdentifier}`,
    };
  }

  if (
    trackerIdentifier &&
    workpadTrackerIdentifiers.includes(trackerIdentifier)
  ) {
    return {
      attributed: true,
      reason: `dirty workpad belongs to ${input.issueIdentifier}`,
    };
  }

  if (
    !trackerIdentifier &&
    issueNumber !== null &&
    branchNumbers.includes(issueNumber)
  ) {
    return {
      attributed: true,
      reason: `current branch '${branch}' references ${input.issueIdentifier}`,
    };
  }

  if (
    !trackerIdentifier &&
    issueNumber !== null &&
    workpadNumbers.includes(issueNumber)
  ) {
    return {
      attributed: true,
      reason: `dirty workpad belongs to ${input.issueIdentifier}`,
    };
  }

  return {
    attributed: false,
    reason: `no dirty artifact could be attributed to ${input.issueIdentifier}`,
  };
}
