import { spawn } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { parseWorkflowMarkdown, DEFAULT_WORKFLOW_LIFECYCLE } from "@github-symphony/shared";
import type { RepositoryRef } from "@github-symphony/shared";
import type { WorkflowResolution } from "./types.js";

export async function cloneRepositoryForRun(input: {
  repository: RepositoryRef;
  targetDirectory: string;
}): Promise<string> {
  await mkdir(input.targetDirectory, { recursive: true });
  const repositoryDirectory = join(input.targetDirectory, "repository");
  try {
    await access(join(repositoryDirectory, ".git"), constants.R_OK);
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
  repository: RepositoryRef
): Promise<WorkflowResolution> {
  const workflowPath = join(repositoryDirectory, "WORKFLOW.md");

  try {
    await access(workflowPath, constants.R_OK);
    const markdown = await readFile(workflowPath, "utf8");
    const parsed = parseWorkflowMarkdown(markdown);

    return {
      lifecycle: parsed.lifecycle,
      promptGuidelines: parsed.promptGuidelines,
      agentCommand: parsed.agentCommand,
      hookPath: parsed.hookPath,
      workflowPath
    };
  } catch {
    return {
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
      promptGuidelines: "",
      agentCommand: "bash -lc codex app-server",
      hookPath: "hooks/after_create.sh",
      workflowPath: null
    };
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
