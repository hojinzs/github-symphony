export const CORE_WORKSPACE_BOUNDARY = {
  module: "workspace",
  responsibilities: ["issue-scoped identity", "workspace lifecycle", "hook surfaces"]
} as const;

export * from "./safety.js";
export * from "./identity.js";
export * from "./hooks.js";
