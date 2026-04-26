export const RUNTIME_CLAUDE_BOUNDARY = {
  package: "@gh-symphony/runtime-claude",
  responsibilities: [
    "claude print argv composition",
    "claude print spawn loop",
    "claude runtime credential resolution",
  ],
} as const;

export * from "./adapter.js";
export * from "./argv.js";
export * from "./spawn.js";
