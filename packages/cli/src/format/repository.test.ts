import { describe, expect, it } from "vitest";
import { formatRepositoryDisplay } from "./repository.js";

describe("formatRepositoryDisplay", () => {
  it("prefers repository owner/name when present", () => {
    expect(
      formatRepositoryDisplay({
        repository: { owner: "acme", name: "platform", cloneUrl: "" },
      } as never)
    ).toBe("acme/platform");
  });

  it("falls back to legacy slug when repository is absent", () => {
    expect(formatRepositoryDisplay({ slug: "tenant-a" } as never)).toBe(
      "tenant-a"
    );
  });

  it("uses the default fallback when both repository and slug are absent", () => {
    expect(formatRepositoryDisplay({} as never)).toBe("repository");
  });
});
