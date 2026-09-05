import { describe, expect, it } from "vitest";
import { buildAgentChildEnvironmentAssignments } from "./agent-child-env.js";

describe("buildAgentChildEnvironmentAssignments", () => {
  it("builds the shared host-constructed child assignments", () => {
    expect(
      buildAgentChildEnvironmentAssignments({
        childHome: "/runtime/child-home",
        sources: [
          { SYMPHONY_ASSIGNED_BRANCH: "symphony/acme-42" },
          { SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#42" },
        ],
      })
    ).toEqual({
      SYMPHONY_ASSIGNED_BRANCH: "symphony/acme-42",
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#42",
      HOME: "/runtime/child-home",
      USERPROFILE: "/runtime/child-home",
      GH_CONFIG_DIR: "/runtime/child-home/gh",
      DOCKER_CONFIG: "/runtime/child-home/.docker",
    });
  });

  it("excludes source context without suppressing pinned isolation", () => {
    expect(
      buildAgentChildEnvironmentAssignments({
        childHome: "/runtime/child-home",
        sources: [{ TARGET_REPOSITORY_URL: "https://github.com/acme/repo" }],
        excludeNames: ["TARGET_REPOSITORY_URL", "USERPROFILE"],
      })
    ).toEqual({
      HOME: "/runtime/child-home",
      USERPROFILE: "/runtime/child-home",
      GH_CONFIG_DIR: "/runtime/child-home/gh",
      DOCKER_CONFIG: "/runtime/child-home/.docker",
    });
  });
});
