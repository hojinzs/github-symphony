export const RUNTIME_CLAUDE_BOUNDARY = {
  package: "@gh-symphony/runtime-claude",
  responsibilities: ["claude credential resolution"],
} as const;

export * from "./adapter.js";
