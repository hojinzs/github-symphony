import { describe, expect, it } from "vitest";
import {
  buildIssueIdentityHeader,
  extractIssueNumberFromIdentifier,
  extractIssueNumbersFromBranch,
} from "./issue-identity.js";

describe("buildIssueIdentityHeader", () => {
  it("binds the run to a single issue with exclusivity constraints", () => {
    const header = buildIssueIdentityHeader({
      issueIdentifier: "acme/platform#507",
      issueTitle: "Fix identity isolation",
      repositorySlug: "acme/platform",
    });
    expect(header).toContain("## Engine-Enforced Run Identity");
    expect(header).toContain(
      "bound exclusively to issue acme/platform#507 — Fix identity isolation in acme/platform"
    );
    expect(header).toContain("Never adopt another issue as the active task");
    expect(header).toContain("report a blocker instead of switching issues");
  });

  it("renders without optional title and repository", () => {
    const header = buildIssueIdentityHeader({ issueIdentifier: "#173" });
    expect(header).toContain("bound exclusively to issue #173.");
  });
});

describe("extractIssueNumberFromIdentifier", () => {
  it("parses canonical identifier shapes", () => {
    expect(extractIssueNumberFromIdentifier("acme/platform#507")).toBe(507);
    expect(extractIssueNumberFromIdentifier("#173")).toBe(173);
    expect(extractIssueNumberFromIdentifier("173")).toBe(173);
    expect(extractIssueNumberFromIdentifier("ACME-42")).toBeNull();
    expect(extractIssueNumberFromIdentifier("no-number")).toBeNull();
  });
});

describe("extractIssueNumbersFromBranch", () => {
  it("finds issue numbers at conventional segment starts", () => {
    expect(extractIssueNumbersFromBranch("feat/507-identity")).toEqual([507]);
    expect(extractIssueNumbersFromBranch("fix/172-decode-nonascii")).toEqual([
      172,
    ]);
    expect(extractIssueNumbersFromBranch("507-quickfix")).toEqual([507]);
  });

  it("ignores version-like fragments inside segments", () => {
    expect(extractIssueNumbersFromBranch("chore/upgrade-node-24")).toEqual([]);
    expect(extractIssueNumbersFromBranch("main")).toEqual([]);
    expect(extractIssueNumbersFromBranch("release/v2")).toEqual([]);
  });
});
