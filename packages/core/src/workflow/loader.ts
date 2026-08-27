import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { DEFAULT_WORKFLOW_DEFINITION, type ParsedWorkflow } from "./config.js";
import { parseWorkflowMarkdown } from "./parser.js";
import type { WorkflowResolution } from "../contracts/status-surface.js";

type WorkflowCacheEntry = {
  fingerprint: string;
  envSignature: string;
  workflow: ParsedWorkflow;
  revision: string;
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
    const cached = this.cache.get(workflowPath);
    const markdown = await readFile(workflowPath, "utf8");
    const fingerprint = `${fileStat.mtimeMs}:${fileStat.size}:${createHash(
      "sha256"
    )
      .update(markdown)
      .digest("hex")}`;
    const envSignature = createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      )
      .digest("hex");

    if (
      cached &&
      cached.fingerprint === fingerprint &&
      cached.envSignature === envSignature
    ) {
      return toWorkflowResolution(workflowPath, cached.workflow, {
        revision: cached.revision,
        loadedAt: cached.loadedAt,
        isValid: true,
        usedLastKnownGood: false,
        validationError: null,
      });
    }

    try {
      const workflow = parseWorkflowMarkdown(markdown, env);
      const revision = createWorkflowRevision(workflow);
      const loadedAt = new Date().toISOString();
      this.cache.set(workflowPath, {
        fingerprint,
        envSignature,
        workflow,
        revision,
        loadedAt,
      });
      return toWorkflowResolution(workflowPath, workflow, {
        revision,
        loadedAt,
        isValid: true,
        usedLastKnownGood: false,
        validationError: null,
      });
    } catch (error) {
      if (cached) {
        return toWorkflowResolution(workflowPath, cached.workflow, {
          revision: cached.revision,
          loadedAt: cached.loadedAt,
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
    revision: null,
    loadedAt: null,
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
    revision: string | null;
    loadedAt: string | null;
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
    revision: metadata.revision,
    loadedAt: metadata.loadedAt,
    isValid: metadata.isValid,
    usedLastKnownGood: metadata.usedLastKnownGood,
    validationError: metadata.validationError,
  };
}

function createWorkflowRevision(workflow: ParsedWorkflow): string {
  return `sha256:${calculateWorkflowVersionHash(workflow).slice(0, 12)}`;
}
