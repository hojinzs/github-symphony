import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  createDefaultWorkflowResolution,
  WorkflowConfigStore,
  type RepositoryRef,
  type WorkflowResolution
} from "@github-symphony/core";

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

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
