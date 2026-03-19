import type { TrackedIssue } from "../contracts/tracker-adapter.js";
import { Liquid } from "liquidjs";

/**
 * Normalized issue variables for prompt template rendering.
 *
 * These variables are available in the `WORKFLOW.md` prompt template
 * via `{{issue.identifier}}`, `{{issue.title}}`, etc.
 */
export type PromptIssueVariables = {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description: string | null;
  priority: number | null;
  url: string | null;
  state: string;
  labels: string[];
  blocked_by: TrackedIssue["blockedBy"];
  branch_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  repository: string;
};

/**
 * Variables available for prompt template rendering.
 *
 * - `issue` — normalized issue payload
 * - `attempt` — null for first execution, attempt number for retries
 */
export type PromptVariables = {
  issue: PromptIssueVariables;
  attempt: number | null;
};

/**
 * Build normalized prompt variables from a tracked issue and execution context.
 */
export function buildPromptVariables(
  issue: TrackedIssue,
  options: {
    attempt: number | null;
  }
): PromptVariables {
  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      number: issue.number,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      url: issue.url,
      state: issue.state,
      labels: issue.labels,
      blocked_by: issue.blockedBy,
      branch_name: issue.branchName,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      repository: `${issue.repository.owner}/${issue.repository.name}`,
    },
    attempt: options.attempt,
  };
}

/**
 * Options for prompt template rendering.
 */
export type RenderPromptOptions = {
  /**
   * When `true` (default), throw an error if any `{{...}}` variables remain
   * unresolved after substitution. Set to `false` to preserve legacy behavior
   * where unresolved variables are left as-is.
   */
  strict?: boolean;
};

const STRICT_LIQUID_ENGINE = new Liquid({
  strictVariables: true,
  strictFilters: true,
  ownPropertyOnly: true,
  lenientIf: true,
});

/**
 * Render a prompt template with the given variables.
 *
 * Supports simple `{{variable}}` and `{{object.key}}` substitution.
 *
 * When `strict` is `true` (the default), an error is thrown if any
 * `{{...}}` patterns remain after substitution. Set `strict` to `false`
 * to preserve the legacy behavior of leaving unresolved variables as-is.
 *
 * The template body is the Markdown content of `WORKFLOW.md` after the
 * YAML front matter. It typically contains the base prompt guidelines
 * mixed with template variables.
 */
export function renderPrompt(
  template: string,
  variables: PromptVariables,
  options: RenderPromptOptions = {}
): string {
  const strict = options.strict ?? true;

  if (!strict) {
    return renderLegacyPrompt(template, variables);
  }

  try {
    return STRICT_LIQUID_ENGINE.parseAndRenderSync(template, variables);
  } catch (error) {
    throw new Error(
      `template_render_error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Flatten nested variables into a dot-notation map.
 *
 * `{ issue: { title: "Fix bug" } }` → `Map { "issue.title" → "Fix bug" }`
 */
function flattenVariables(
  obj: Record<string, unknown>,
  prefix = ""
): Map<string, unknown> {
  const result = new Map<string, unknown>();

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of flattenVariables(
        value as Record<string, unknown>,
        fullKey
      )) {
        result.set(nestedKey, nestedValue);
      }
    } else {
      result.set(fullKey, value);
    }
  }

  return result;
}

function renderLegacyPrompt(
  template: string,
  variables: PromptVariables
): string {
  const flatVars = flattenVariables(variables);

  return template.replace(
    /\{\{([a-zA-Z_][a-zA-Z0-9_.]*)\}\}/g,
    (match, key: string) => {
      const value = flatVars.get(key);
      if (value === undefined) {
        return match;
      }
      if (value === null) {
        return "";
      }
      return String(value);
    }
  );
}
