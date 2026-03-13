import type { TrackedIssue } from "../contracts/tracker-adapter.js";

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
  url: string | null;
  state: string;
  repository: string;
};

/**
 * Variables available for prompt template rendering.
 *
 * - `issue` — normalized issue payload
 * - `attempt` — null for first execution, attempt number for retries
 * - `guidelines` — workspace-level prompt guidelines
 */
export type PromptVariables = {
  issue: PromptIssueVariables;
  attempt: number | null;
  guidelines: string;
};

/**
 * Build normalized prompt variables from a tracked issue and execution context.
 */
export function buildPromptVariables(
  issue: TrackedIssue,
  options: {
    attempt: number | null;
    guidelines: string;
  }
): PromptVariables {
  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      number: issue.number,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      state: issue.state,
      repository: `${issue.repository.owner}/${issue.repository.name}`,
    },
    attempt: options.attempt,
    guidelines: options.guidelines,
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
  const flatVars = flattenVariables(variables);

  const rendered = template.replace(
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

  if (strict) {
    const unresolvedMatch = rendered.match(/\{\{([a-zA-Z_][a-zA-Z0-9_.]*)\}\}/);
    if (unresolvedMatch) {
      throw new Error(
        `template_render_error: unresolved variable "{{${unresolvedMatch[1]}}}" in rendered prompt`
      );
    }
  }

  return rendered;
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
