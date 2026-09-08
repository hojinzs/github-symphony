import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WorkflowSourceRelationship =
  | "linked"
  | "synchronized-copy"
  | "stale-copy"
  | "independent"
  | "unavailable";

export type WorkflowSourceIdentity = {
  path: string;
  relationship: WorkflowSourceRelationship;
  contentRevision: string | null;
  repositoryPath: string | null;
  repositoryRef: string | null;
  repositoryCommit: string | null;
  repositoryRevision: string | null;
  matchedRepositoryCommit: string | null;
};

export type WorkflowSourceIdentityDependencies = {
  execGit?: (cwd: string, args: string[]) => Promise<string>;
};

function contentRevision(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 12)}`;
}

async function defaultExecGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

export async function inspectWorkflowSourceIdentity(input: {
  workflowPath: string;
  repositoryDirectory: string;
  baseRef?: string | null;
  dependencies?: WorkflowSourceIdentityDependencies;
}): Promise<WorkflowSourceIdentity> {
  const execGit = input.dependencies?.execGit ?? defaultExecGit;
  const repositoryWorkflowPath = `${input.repositoryDirectory}/WORKFLOW.md`;
  const unavailable = (
    sourceRevision: string | null
  ): WorkflowSourceIdentity => ({
    path: input.workflowPath,
    relationship: "unavailable",
    contentRevision: sourceRevision,
    repositoryPath: repositoryWorkflowPath,
    repositoryRef: input.baseRef ?? "HEAD",
    repositoryCommit: null,
    repositoryRevision: null,
    matchedRepositoryCommit: null,
  });

  let sourceContent: string;
  try {
    const sourceStats = await lstat(input.workflowPath);
    sourceContent = await readFile(input.workflowPath, "utf8");
    if (sourceStats.isSymbolicLink()) {
      const [sourceTarget, repositoryTarget] = await Promise.all([
        realpath(input.workflowPath),
        realpath(repositoryWorkflowPath),
      ]);
      if (sourceTarget === repositoryTarget) {
        const revision = contentRevision(sourceContent);
        return {
          ...unavailable(revision),
          relationship: "linked",
          repositoryRevision: revision,
        };
      }
    }
  } catch {
    return unavailable(null);
  }

  const sourceRevision = contentRevision(sourceContent);
  const repositoryRef = input.baseRef?.trim() || "HEAD";
  try {
    const [repositoryContent, repositoryCommit] = await Promise.all([
      execGit(input.repositoryDirectory, [
        "show",
        `${repositoryRef}:WORKFLOW.md`,
      ]),
      execGit(input.repositoryDirectory, ["rev-parse", repositoryRef]),
    ]);
    const repositoryRevision = contentRevision(repositoryContent);
    const common = {
      path: input.workflowPath,
      contentRevision: sourceRevision,
      repositoryPath: repositoryWorkflowPath,
      repositoryRef,
      repositoryCommit: repositoryCommit.trim(),
      repositoryRevision,
    };
    if (sourceContent === repositoryContent) {
      return {
        ...common,
        relationship: "synchronized-copy",
        matchedRepositoryCommit: repositoryCommit.trim(),
      };
    }

    const revisions = (
      await execGit(input.repositoryDirectory, [
        "rev-list",
        repositoryRef,
        "--",
        "WORKFLOW.md",
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const revision of revisions) {
      try {
        if (
          sourceContent ===
          (await execGit(input.repositoryDirectory, [
            "show",
            `${revision}:WORKFLOW.md`,
          ]))
        ) {
          return {
            ...common,
            relationship: "stale-copy",
            matchedRepositoryCommit: revision,
          };
        }
      } catch {
        // A revision may precede the file; keep searching its reachable history.
      }
    }
    return {
      ...common,
      relationship: "independent",
      matchedRepositoryCommit: null,
    };
  } catch {
    return unavailable(sourceRevision);
  }
}
