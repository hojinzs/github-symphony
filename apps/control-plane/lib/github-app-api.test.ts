import { describe, expect, it } from "vitest";
import { buildGitHubAppManifest } from "./github-app-api";

describe("buildGitHubAppManifest", () => {
  it("requests the repository write permissions required for approval-gated delivery", () => {
    const manifest = buildGitHubAppManifest("https://control-plane.example.com");

    expect(manifest.default_permissions.contents).toBe("write");
    expect(manifest.default_permissions.pull_requests).toBe("write");
    expect(manifest.default_permissions.issues).toBe("write");
  });
});
