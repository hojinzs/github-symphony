import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  IssueWorkspaceRecord,
  OrchestratorRunRecord,
  RepositoryRef,
} from "@gh-symphony/core";

const execFileAsync = promisify(execFile);

export type WorkflowSourceRelationship =
  | "linked"
  | "synchronized-copy"
  | "stale-copy"
  | "independent"
  | "no-repository-policy"
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

export async function resolveWorkflowRepositoryDirectory(input: {
  repository: RepositoryRef;
  issueWorkspaces?: IssueWorkspaceRecord[];
  runs?: OrchestratorRunRecord[];
  baseDirectory?: string;
  dependencies?: WorkflowSourceIdentityDependencies;
}): Promise<string | null> {
  const execGit = input.dependencies?.execGit ?? defaultExecGit;
  const configuredPath = resolveConfiguredRepositoryPath(
    input.repository,
    input.baseDirectory ?? process.cwd()
  );
  const workspacePaths = [...(input.issueWorkspaces ?? [])]
    .filter((workspace) => workspace.status !== "removed")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((workspace) => workspace.repositoryPath);
  const runPaths = [...(input.runs ?? [])]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((run) => run.workingDirectory);

  for (const candidate of [configuredPath, ...workspacePaths, ...runPaths]) {
    if (!candidate) continue;
    try {
      if (
        (
          await execGit(candidate, ["rev-parse", "--is-inside-work-tree"])
        ).trim() === "true"
      ) {
        return candidate;
      }
    } catch {
      // Persisted workspace and run records can outlive their local checkout.
    }
  }
  return null;
}

function resolveConfiguredRepositoryPath(
  repository: RepositoryRef,
  baseDirectory: string
): string | null {
  if (repository.path) return repository.path;
  try {
    const url = new URL(repository.cloneUrl);
    return url.protocol === "file:" ? fileURLToPath(url) : null;
  } catch {
    return isAbsolute(repository.cloneUrl)
      ? repository.cloneUrl
      : repository.cloneUrl.startsWith(".")
        ? resolve(baseDirectory, repository.cloneUrl)
        : null;
  }
}

function contentRevision(content: string): string {
  return `sha256:${createHash("sha256")
    .update(normalizePolicyContent(content))
    .digest("hex")
    .slice(0, 12)}`;
}

function normalizePolicyContent(content: string): string {
  return content.replaceAll("\r\n", "\n");
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
  const repositoryWorkflowPath = join(input.repositoryDirectory, "WORKFLOW.md");
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
  let linked = false;
  try {
    const sourceStats = await lstat(input.workflowPath);
    sourceContent = await readFile(input.workflowPath, "utf8");
    if (sourceStats.isSymbolicLink()) {
      const [sourceTarget, repositoryTarget] = await Promise.all([
        realpath(input.workflowPath),
        realpath(repositoryWorkflowPath),
      ]);
      if (sourceTarget === repositoryTarget) {
        linked = true;
      }
    }
  } catch {
    return unavailable(null);
  }

  const sourceRevision = contentRevision(sourceContent);
  const repositoryRef = input.baseRef?.trim() || "HEAD";
  try {
    const repositoryCommit = (
      await execGit(input.repositoryDirectory, ["rev-parse", repositoryRef])
    ).trim();
    const repositoryPolicyPath = (
      await execGit(input.repositoryDirectory, [
        "ls-tree",
        "--name-only",
        repositoryRef,
        "--",
        "WORKFLOW.md",
      ])
    ).trim();
    if (!repositoryPolicyPath) {
      return {
        path: input.workflowPath,
        relationship: "no-repository-policy",
        contentRevision: sourceRevision,
        repositoryPath: repositoryWorkflowPath,
        repositoryRef,
        repositoryCommit,
        repositoryRevision: null,
        matchedRepositoryCommit: null,
      };
    }
    const repositoryContent = await execGit(input.repositoryDirectory, [
      "show",
      `${repositoryRef}:WORKFLOW.md`,
    ]);
    const repositoryRevision = contentRevision(repositoryContent);
    const common = {
      path: input.workflowPath,
      contentRevision: sourceRevision,
      repositoryPath: repositoryWorkflowPath,
      repositoryRef,
      repositoryCommit,
      repositoryRevision,
    };
    if (linked) {
      return {
        ...common,
        relationship: "linked",
        matchedRepositoryCommit: repositoryCommit,
      };
    }
    if (
      normalizePolicyContent(sourceContent) ===
      normalizePolicyContent(repositoryContent)
    ) {
      return {
        ...common,
        relationship: "synchronized-copy",
        matchedRepositoryCommit: repositoryCommit,
      };
    }

    const revisions = (
      await execGit(input.repositoryDirectory, [
        "rev-list",
        "--full-history",
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
          normalizePolicyContent(sourceContent) ===
          normalizePolicyContent(
            await execGit(input.repositoryDirectory, [
              "show",
              `${revision}:WORKFLOW.md`,
            ])
          )
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
