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
      url: issue.url,
      state: issue.state,
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

  // In strict mode, validate the original template BEFORE substitution.
  // This ensures that {{...}} patterns introduced by substituted values
  // (e.g. issue descriptions containing "{{variable.path}}") are not
  // mistakenly flagged as unresolved template variables.
  if (strict) {
    const varPattern = /\{\{([a-zA-Z_][a-zA-Z0-9_.]*)\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = varPattern.exec(template)) !== null) {
      const key = match[1];
      if (!flatVars.has(key)) {
        throw new Error(
          `template_render_error: unresolved variable "{{${key}}}" in rendered prompt`
        );
      }
    }
  }

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
