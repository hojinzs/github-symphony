import { describe, expect, it } from "vitest";
import { parseCreateIssueInput } from "./issue-service";

describe("parseCreateIssueInput", () => {
  it("parses a valid issue payload", () => {
    expect(
      parseCreateIssueInput({
        workspaceId: "workspace-1",
        repositoryOwner: "acme",
        repositoryName: "platform",
        title: "Ship dashboard",
        body: "Implement observability."
      })
    ).toEqual({
      workspaceId: "workspace-1",
      repositoryOwner: "acme",
      repositoryName: "platform",
      title: "Ship dashboard",
      body: "Implement observability."
    });
  });
});
