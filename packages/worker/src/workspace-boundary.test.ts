import { describe, expect, it } from "vitest";
import {
  findCwdBoundaryViolation,
  formatEventCwdSuffix,
} from "./workspace-boundary.js";

const boundary = "/runtime/workspaces/acme_platform_507/repository";

describe("findCwdBoundaryViolation", () => {
  it("allows cwds inside the workspace boundary", () => {
    expect(findCwdBoundaryViolation({ cwd: boundary }, boundary)).toBeNull();
    expect(
      findCwdBoundaryViolation({ cwd: `${boundary}/packages/core` }, boundary)
    ).toBeNull();
    expect(
      findCwdBoundaryViolation({ item: { cwd: boundary } }, boundary)
    ).toBeNull();
  });

  it("flags cwds outside the boundary", () => {
    expect(
      findCwdBoundaryViolation({ cwd: "/Users/steve/other-project" }, boundary)
    ).toBe("/Users/steve/other-project");
    expect(
      findCwdBoundaryViolation(
        { item: { cwd: "/runtime/workspaces/acme_platform_172/repository" } },
        boundary
      )
    ).toBe("/runtime/workspaces/acme_platform_172/repository");
  });

  it("is not fooled by sibling directories sharing a prefix", () => {
    expect(
      findCwdBoundaryViolation({ cwd: `${boundary}-other` }, boundary)
    ).toBe(`${boundary}-other`);
  });

  it("resolves relative cwds against the boundary", () => {
    expect(
      findCwdBoundaryViolation({ cwd: "packages/core" }, boundary)
    ).toBeNull();
    expect(findCwdBoundaryViolation({ cwd: "../../escape" }, boundary)).toBe(
      "../../escape"
    );
  });

  it("ignores events without a cwd", () => {
    expect(findCwdBoundaryViolation({}, boundary)).toBeNull();
    expect(findCwdBoundaryViolation(null, boundary)).toBeNull();
    expect(findCwdBoundaryViolation("text", boundary)).toBeNull();
  });
});

describe("formatEventCwdSuffix", () => {
  it("appends the untruncated cwd when present", () => {
    expect(formatEventCwdSuffix({ cwd: boundary })).toBe(` cwd=${boundary}`);
    expect(formatEventCwdSuffix({ item: { cwd: boundary } })).toBe(
      ` cwd=${boundary}`
    );
  });

  it("returns an empty suffix without a cwd", () => {
    expect(formatEventCwdSuffix({})).toBe("");
    expect(formatEventCwdSuffix(undefined)).toBe("");
  });
});
