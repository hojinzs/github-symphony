export const CLAUDE_RUNTIME_CONSTRAINTS_SECTION = `## Runtime Constraints

1. This run uses \`claude -p\` in non-interactive mode.
2. Slash commands such as \`/commit\`, \`/push\`, \`/gh-project\`, \`/gh-pr-writeup\` are NOT available (CLI limitation, independent of isolation settings).
3. Use \`gh\`, \`git\`, repository scripts, and configured MCP tools directly instead.
4. If a required permission or tool is unavailable, post a blocker comment on the issue and exit. Do not wait for human input.`;

export const CLAUDE_PERMISSIVE_ISOLATION_NOTE =
  "<!-- Permissive preset requires an isolated workspace. Symphony runs each issue in `.runtime/symphony-workspaces/<workspace-id>/`, a throwaway clone. If you disable workspace isolation or mount host paths into worker containers, do not use this runtime in production. -->";

export const CLAUDE_ISOLATION_OFF_NOTE =
  "<!-- Isolation is off by default — the agent will pick up your `CLAUDE.md`, project skills, and personal MCPs from `~/.claude/`. Turn isolation on when running in multi-operator CI, shared infrastructure, or when reproducibility across machines matters. -->";

export const CLAUDE_RUNTIME_PROMPT_PREAMBLE = [
  CLAUDE_RUNTIME_CONSTRAINTS_SECTION,
  CLAUDE_PERMISSIVE_ISOLATION_NOTE,
  CLAUDE_ISOLATION_OFF_NOTE,
].join("\n\n");
