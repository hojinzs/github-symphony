import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { DEFAULT_WORKFLOW_DEFINITION, type ParsedWorkflow } from "./config.js";
import { parseWorkflowMarkdown } from "./parser.js";
import type { WorkflowResolution } from "../contracts/status-surface.js";

type WorkflowCacheEntry = {
  fingerprint: string;
  workflow: ParsedWorkflow;
  loadedAt: string;
};

export class WorkflowConfigStore {
  private readonly cache = new Map<string, WorkflowCacheEntry>();

  async load(
    workflowPath: string,
    env: NodeJS.ProcessEnv = process.env
  ): Promise<WorkflowResolution> {
    await access(workflowPath, constants.R_OK);
    const fileStat = await stat(workflowPath);
    const fingerprint = `${fileStat.mtimeMs}:${fileStat.size}`;
    const cached = this.cache.get(workflowPath);

    if (cached && cached.fingerprint === fingerprint) {
      return toWorkflowResolution(workflowPath, cached.workflow, {
        isValid: true,
        usedLastKnownGood: false,
        validationError: null,
      });
    }

    const markdown = await readFile(workflowPath, "utf8");

    try {
      const workflow = parseWorkflowMarkdown(markdown, env);
      this.cache.set(workflowPath, {
        fingerprint,
        workflow,
        loadedAt: new Date().toISOString(),
      });
      return toWorkflowResolution(workflowPath, workflow, {
        isValid: true,
        usedLastKnownGood: false,
        validationError: null,
      });
    } catch (error) {
      if (cached) {
        return toWorkflowResolution(workflowPath, cached.workflow, {
          isValid: false,
          usedLastKnownGood: true,
          validationError:
            error instanceof Error
              ? error.message
              : "Invalid workflow definition.",
        });
      }
      throw error;
    }
  }
}

export function createDefaultWorkflowResolution(): WorkflowResolution {
  return createInvalidWorkflowResolution(null, "missing_workflow_file");
}

export function createInvalidWorkflowResolution(
  workflowPath: string | null,
  validationError: string
): WorkflowResolution {
  return toWorkflowResolution(workflowPath, DEFAULT_WORKFLOW_DEFINITION, {
    isValid: false,
    usedLastKnownGood: false,
    validationError,
  });
}

export function calculateWorkflowVersionHash(workflow: ParsedWorkflow): string {
  return createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
}

function toWorkflowResolution(
  workflowPath: string | null,
  workflow: ParsedWorkflow,
  metadata: {
    isValid: boolean;
    usedLastKnownGood: boolean;
    validationError: string | null;
  }
): WorkflowResolution {
  return {
    workflowPath,
    workflow,
    lifecycle: workflow.lifecycle,
    promptTemplate: workflow.promptTemplate,
    agentCommand: workflow.agentCommand,
    hookPath: workflow.hookPath ?? "",
    isValid: metadata.isValid,
    usedLastKnownGood: metadata.usedLastKnownGood,
    validationError: metadata.validationError,
  };
}
