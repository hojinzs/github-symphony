import { describe, expect, it } from "vitest";
import {
  getSupportedTrackerKinds,
  resolveTrackerAdapter,
} from "./tracker-adapters.js";

describe("resolveTrackerAdapter", () => {
  it("registers the Linear adapter", () => {
    const adapter = resolveTrackerAdapter({
      adapter: "linear",
      bindingId: "project-slug",
      settings: {
        projectSlug: "project-slug",
      },
    });

    expect(adapter.buildWorkerEnvironment).toBeTypeOf("function");
  });
});

it("exports adapter-owned tracker kinds for workflow validation", () => {
  expect(getSupportedTrackerKinds()).toEqual(
    expect.arrayContaining(["github-project", "file", "linear"])
  );
});
