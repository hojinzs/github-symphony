import type { TrackedIssue } from "../contracts/tracker-adapter.js";
import type {
  TrackedIssueContentType,
  TrackedPullRequestContext,
} from "../contracts/tracker-adapter.js";
import {
  Liquid,
  ParseError,
  RenderError,
  TokenizationError,
  UndefinedVariableError,
} from "liquidjs";

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
  content_type: TrackedIssueContentType;
  linked_pull_requests: TrackedPullRequestContext[];
  primary_pull_request: TrackedPullRequestContext | null;
  has_linked_pr: boolean;
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

export type ContinuationGuidanceVariables = {
  lastTurnSummary: string;
  cumulativeTurnCount: string;
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
  const contentType = issue.metadata.contentType ?? "Issue";
  const linkedPullRequests = Array.isArray(issue.metadata.linkedPullRequests)
    ? issue.metadata.linkedPullRequests
    : [];
  const primaryPullRequest =
    contentType === "PullRequest"
      ? (issue.metadata.pullRequest ??
        linkedPullRequests[0] ??
        buildPullRequestContextFromIssue(issue))
      : (linkedPullRequests[0] ?? null);

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
      content_type: contentType,
      linked_pull_requests: linkedPullRequests,
      primary_pull_request: primaryPullRequest,
      has_linked_pr: linkedPullRequests.length > 0,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      repository: `${issue.repository.owner}/${issue.repository.name}`,
    },
    attempt: options.attempt,
  };
}

function buildPullRequestContextFromIssue(
  issue: TrackedIssue
): TrackedPullRequestContext {
  return {
    id: issue.id,
    number: issue.number,
    identifier: issue.identifier,
    url: issue.url,
    state: null,
    projectState: issue.state,
    headRefName: issue.branchName,
    repository: {
      owner: issue.repository.owner,
      name: issue.repository.name,
      url: issue.repository.url ?? "",
      cloneUrl: issue.repository.cloneUrl,
    },
  };
}

/**
 * Options for prompt template rendering.
 */
export type RenderPromptOptions = {
  /**
   * When `true` (default), render with strict Liquid semantics so unknown
   * variables and filters fail immediately. Set to `false` to preserve the
   * legacy `{{variable.path}}` substitution behavior where unresolved
   * variables are left as-is.
   */
  strict?: boolean;
};

const STRICT_LIQUID_ENGINE = new Liquid({
  strictVariables: true,
  strictFilters: true,
  ownPropertyOnly: true,
});

/**
 * Render a prompt template with the given variables.
 *
 * In strict mode, this supports Liquid-compatible tags, loops, and filters
 * while rejecting unknown variables or filters. Set `strict` to `false` to
 * preserve the legacy `{{variable}}` / `{{object.key}}` substitution path.
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
    throw normalizeTemplateError(error);
  }
}

function normalizeTemplateError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (
    error instanceof UndefinedVariableError ||
    error instanceof RenderError ||
    (error instanceof ParseError && message.startsWith("undefined filter:"))
  ) {
    return new Error(`template_render_error: ${message}`, { cause: error });
  }

  if (error instanceof ParseError || error instanceof TokenizationError) {
    return new Error(`template_parse_error: ${message}`, { cause: error });
  }

  return new Error(`template_render_error: ${message}`, { cause: error });
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

const CONTINUATION_GUIDANCE_PATTERN =
  /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

export function renderContinuationGuidance(
  template: string,
  variables: ContinuationGuidanceVariables
): string {
  if (template.includes("{%") || template.includes("%}")) {
    throw new Error(
      "template_parse_error: continuation guidance does not support Liquid tags."
    );
  }

  let rendered = "";
  let lastIndex = 0;

  for (const match of template.matchAll(CONTINUATION_GUIDANCE_PATTERN)) {
    const matchedText = match[0];
    const expression = match[1];
    const index = match.index ?? 0;
    rendered += template.slice(lastIndex, index);

    if (!(expression in variables)) {
      throw new Error(
        `template_render_error: unsupported continuation guidance variable '${expression}'.`
      );
    }

    rendered += variables[expression as keyof ContinuationGuidanceVariables];
    lastIndex = index + matchedText.length;
  }

  rendered += template.slice(lastIndex);

  const strayLiquidExpression = rendered.match(/\{\{[^}]*\}\}/);
  if (strayLiquidExpression) {
    throw new Error(
      `template_parse_error: invalid continuation guidance expression '${strayLiquidExpression[0]}'.`
    );
  }

  return rendered;
}
