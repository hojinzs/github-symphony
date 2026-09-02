import { describe, expect, it } from "vitest";
import {
  attributeDirtyWorkToIssue,
  buildIssueIdentityHeader,
  extractIssueNumberFromIdentifier,
  extractIssueNumbersFromBranch,
  extractIssueNumbersFromWorkpadFiles,
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
    const header = buildIssueIdentityHeader({
      issueIdentifier: "#173",
    });

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

describe("extractIssueNumbersFromWorkpadFiles", () => {
  it("reads issue numbers from workpad paths only", () => {
    expect(
      extractIssueNumbersFromWorkpadFiles([
        ".gh-symphony/workpads/172.md",
        ".gh-symphony/workpads/DEV2-54.md",
        "src/index.ts",
        "docs/172-notes.md",
      ])
    ).toEqual([172, 54]);
  });
});

describe("attributeDirtyWorkToIssue", () => {
  it("attributes a Linear issue from its normalized branch identifier", () => {
    const result = attributeDirtyWorkToIssue({
      issueIdentifier: "DEV-54",
      currentBranch: "dev-54-fix",
      dirtyFiles: ["src/fix.ts"],
    });

    expect(result.attributed).toBe(true);
  });

  it("attributes a Linear issue from its workpad identifier", () => {
    const result = attributeDirtyWorkToIssue({
      issueIdentifier: "DEV-54",
      currentBranch: "main",
      dirtyFiles: [".gh-symphony/workpads/DEV-54.md"],
    });

    expect(result.attributed).toBe(true);
  });

  it("denies attribution when a branch names another Linear issue", () => {
    const result = attributeDirtyWorkToIssue({
      issueIdentifier: "DEV-54",
      currentBranch: "eng-12-other",
      dirtyFiles: ["src/other.ts"],
    });

    expect(result.attributed).toBe(false);
    expect(result.reason).toContain("ENG-12");
  });

  it("denies a different Linear team with the same issue number", () => {
    const result = attributeDirtyWorkToIssue({
      issueIdentifier: "DEV-54",
      currentBranch: "eng-54-other",
      dirtyFiles: ["src/other.ts"],
    });

    expect(result.attributed).toBe(false);
    expect(result.reason).toContain("ENG-54");
  });

  it("attributes a digit-bearing Linear team key from its own workpad", () => {
    const result = attributeDirtyWorkToIssue({
      issueIdentifier: "DEV2-54",
      currentBranch: "main",
      dirtyFiles: [".gh-symphony/workpads/DEV2-54.md"],
    });

    expect(result.attributed).toBe(true);
  });

  it("fails closed for bare numeric artifacts on a Linear issue", () => {
    const branch = attributeDirtyWorkToIssue({
      issueIdentifier: "DEV-54",
      currentBranch: "feat/54-other",
      dirtyFiles: ["src/other.ts"],
    });
    const workpad = attributeDirtyWorkToIssue({
      issueIdentifier: "DEV-54",
      currentBranch: "main",
      dirtyFiles: [".gh-symphony/workpads/54.md"],
    });

    expect(branch.attributed).toBe(false);
    expect(branch.reason).toContain("no dirty artifact");
    expect(workpad.attributed).toBe(false);
    expect(workpad.reason).toContain("no dirty artifact");
  });

  it("denies a foreign Linear branch for a GitHub issue", () => {
    const result = attributeDirtyWorkToIssue({
      issueIdentifier: "acme/platform#173",
      currentBranch: "dev-54-fix",
      dirtyFiles: [".gh-symphony/workpads/173.md"],
    });

    expect(result.attributed).toBe(false);
    expect(result.reason).toContain("DEV-54");
  });

  it("does not treat version-like branch fragments as foreign tracker evidence", () => {
    const result = attributeDirtyWorkToIssue({
      issueIdentifier: "DEV-54",
      currentBranch: "chore/node-24",
      dirtyFiles: [".gh-symphony/workpads/DEV-54.md"],
    });

    expect(result.attributed).toBe(true);
  });

  it("denies attribution when the branch belongs to another issue", () => {
    const result = attributeDirtyWorkToIssue({
      issueIdentifier: "acme/platform#173",
      currentBranch: "fix/172-decode-nonascii-handles",
      dirtyFiles: ["src/handles.ts"],
    });

    expect(result.attributed).toBe(false);
    expect(result.reason).toContain("#172");
  });

  it("denies attribution when a dirty workpad belongs to another issue", () => {
    const result = attributeDirtyWorkToIssue({
      issueIdentifier: "acme/platform#173",
      currentBranch: "main",
      dirtyFiles: [".gh-symphony/workpads/172.md"],
    });

    expect(result.attributed).toBe(false);
    expect(result.reason).toContain("#172");
  });

  it("attributes work on the issue's own branch", () => {
    const result = attributeDirtyWorkToIssue({
      issueIdentifier: "acme/platform#507",
      currentBranch: "feat/507-issue-identity-isolation",
      dirtyFiles: ["packages/core/src/index.ts"],
    });

    expect(result.attributed).toBe(true);
  });

  it("attributes work on a tracker-linked branch without an issue number", () => {
    const result = attributeDirtyWorkToIssue({
      issueIdentifier: "acme/platform#507",
      currentBranch: "identity-hardening",
      dirtyFiles: ["packages/core/src/index.ts"],
      expectedBranches: ["identity-hardening"],
    });

    expect(result.attributed).toBe(true);
  });

  it("fails closed when no artifact carries attribution evidence", () => {
    const result = attributeDirtyWorkToIssue({
      issueIdentifier: "acme/platform#507",
      currentBranch: "main",
      dirtyFiles: ["partial.txt"],
    });

    expect(result.attributed).toBe(false);
    expect(result.reason).toContain("no dirty artifact");
  });

  it("prefers foreign evidence over positive evidence", () => {
    const result = attributeDirtyWorkToIssue({
      issueIdentifier: "acme/platform#173",
      currentBranch: "feat/173-own-work",
      dirtyFiles: [".gh-symphony/workpads/172.md"],
    });

    expect(result.attributed).toBe(false);
  });
});
