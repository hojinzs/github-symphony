import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import {
  DEFAULT_WORKFLOW_DEFINITION,
  type ParsedWorkflow
} from "./config.js";
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
        usedLastKnownGood: false,
        validationError: null
      });
    }

    const markdown = await readFile(workflowPath, "utf8");

    try {
      const workflow = parseWorkflowMarkdown(markdown, env);
      this.cache.set(workflowPath, {
        fingerprint,
        workflow,
        loadedAt: new Date().toISOString()
      });
      return toWorkflowResolution(workflowPath, workflow, {
        usedLastKnownGood: false,
        validationError: null
      });
    } catch (error) {
      if (cached) {
        return toWorkflowResolution(workflowPath, cached.workflow, {
          usedLastKnownGood: true,
          validationError: error instanceof Error ? error.message : "Invalid workflow definition."
        });
      }
      throw error;
    }
  }
}

export function createDefaultWorkflowResolution(): WorkflowResolution {
  return toWorkflowResolution(null, DEFAULT_WORKFLOW_DEFINITION, {
    usedLastKnownGood: false,
    validationError: null
  });
}

export function calculateWorkflowVersionHash(workflow: ParsedWorkflow): string {
  return createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
}

function toWorkflowResolution(
  workflowPath: string | null,
  workflow: ParsedWorkflow,
  metadata: {
    usedLastKnownGood: boolean;
    validationError: string | null;
  }
): WorkflowResolution {
  return {
    workflowPath,
    workflow,
    lifecycle: workflow.lifecycle,
    promptGuidelines: workflow.promptGuidelines,
    promptTemplate: workflow.promptTemplate,
    agentCommand: workflow.agentCommand,
    hookPath: workflow.hookPath,
    usedLastKnownGood: metadata.usedLastKnownGood,
    validationError: metadata.validationError
  };
}
