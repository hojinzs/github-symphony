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
  phase: string;
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
      phase: issue.phase,
      repository: `${issue.repository.owner}/${issue.repository.name}`,
    },
    attempt: options.attempt,
    guidelines: options.guidelines,
  };
}

/**
 * Render a prompt template with the given variables.
 *
 * Supports simple `{{variable}}` and `{{object.key}}` substitution.
 * Unresolved variables are left as-is to allow downstream processing.
 *
 * The template body is the Markdown content of `WORKFLOW.md` after the
 * YAML front matter. It typically contains the base prompt guidelines
 * mixed with template variables.
 */
export function renderPrompt(
  template: string,
  variables: PromptVariables
): string {
  const flatVars = flattenVariables(variables);

  return template.replace(
    /\{\{([a-zA-Z_][a-zA-Z0-9_.]*)\}\}/g,
    (match, key: string) => {
      const value = flatVars.get(key);
      if (value === undefined || value === null) {
        return match;
      }
      return String(value);
    }
  );
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
