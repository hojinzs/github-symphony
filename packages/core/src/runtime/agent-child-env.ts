import { join } from "node:path";
import { readAgentVisibleSymphonyContext } from "./custom-child-env.js";

/** Builds host-constructed environment assignments shared by agent runtimes. */
export function buildAgentChildEnvironmentAssignments(options: {
  childHome: string;
  sources: ReadonlyArray<NodeJS.ProcessEnv | undefined>;
  excludeNames?: Iterable<string>;
}): NodeJS.ProcessEnv {
  const context = readAgentVisibleSymphonyContext(...options.sources);
  for (const name of options.excludeNames ?? []) {
    delete context[name];
  }

  return {
    ...context,
    HOME: options.childHome,
    USERPROFILE: options.childHome,
    GH_CONFIG_DIR: join(options.childHome, "gh"),
    DOCKER_CONFIG: join(options.childHome, ".docker"),
  };
}
