import { describe, expect, it } from "vitest";
import { resolveTrackerAdapter } from "./tracker-adapters.js";

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
