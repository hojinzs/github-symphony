import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  createDefaultWorkflowResolution,
  normalizeWorkflowState,
  WorkflowConfigStore,
  type RepositoryRef,
  type WorkflowLifecycleConfig,
  type WorkflowResolution,
} from "@gh-symphony/core";

const workflowConfigStore = new WorkflowConfigStore();

export async function cloneRepositoryForRun(input: {
  repository: RepositoryRef;
  targetDirectory: string;
}): Promise<string> {
  await mkdir(input.targetDirectory, { recursive: true });
  const repositoryDirectory = join(input.targetDirectory, "repository");
  try {
    await access(join(repositoryDirectory, ".git"), constants.R_OK);
    await runCommand("git", ["-C", repositoryDirectory, "pull", "--ff-only"]);
    return repositoryDirectory;
  } catch {
    await runCommand("git", [
      "clone",
      "--depth",
      "1",
      input.repository.cloneUrl,
      repositoryDirectory
    ]);
    return repositoryDirectory;
  }
}

export async function ensureIssueWorkspaceRepository(input: {
  repository: RepositoryRef;
  issueWorkspacePath: string;
}): Promise<string> {
  return cloneRepositoryForRun({
    repository: input.repository,
    targetDirectory: input.issueWorkspacePath
  });
}

export async function loadRepositoryWorkflow(
  repositoryDirectory: string,
  _repository: RepositoryRef
): Promise<WorkflowResolution> {
  const workflowPath = join(repositoryDirectory, "WORKFLOW.md");

  try {
    return await workflowConfigStore.load(workflowPath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }

    return createDefaultWorkflowResolution();
  }
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "pipe"
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

export function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export type WorkflowValidationResult = {
  valid: boolean;
  warnings: string[];
};

export function validateRepoWorkflow(
  repoResolution: WorkflowResolution,
  tenantLifecycle: WorkflowLifecycleConfig | undefined
): WorkflowValidationResult {
  if (!tenantLifecycle) {
    return { valid: true, warnings: [] };
  }

  const warnings: string[] = [];
  const repoLifecycle = repoResolution.lifecycle;
  const tenantActive = tenantLifecycle.activeStates ?? [];
  const tenantTerminal = tenantLifecycle.terminalStates ?? [];

  for (const state of repoLifecycle.activeStates) {
    const normalizedState = normalizeWorkflowState(state);
    const knownInTenant =
      tenantActive.some(
        (s) => normalizeWorkflowState(s) === normalizedState
      ) ||
      tenantTerminal.some(
        (s) => normalizeWorkflowState(s) === normalizedState
      );
    if (!knownInTenant) {
      warnings.push(
        `Repository WORKFLOW.md references active state "${state}" not found in tenant lifecycle.`
      );
    }
  }

  for (const state of repoLifecycle.terminalStates) {
    const normalizedState = normalizeWorkflowState(state);
    const knownInTenant =
      tenantActive.some(
        (s) => normalizeWorkflowState(s) === normalizedState
      ) ||
      tenantTerminal.some(
        (s) => normalizeWorkflowState(s) === normalizedState
      );
    if (!knownInTenant) {
      warnings.push(
        `Repository WORKFLOW.md references terminal state "${state}" not found in tenant lifecycle.`
      );
    }
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}
