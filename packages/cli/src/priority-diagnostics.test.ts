import { describe, expect, it } from "vitest";
import { parseWorkflowMarkdown } from "@gh-symphony/core";
import { buildProviderDeprecationDiagnostics } from "./priority-diagnostics.js";

describe("buildProviderDeprecationDiagnostics", () => {
  it("keeps environment references out of migration guidance", () => {
    const workflow = parseWorkflowMarkdown(
      `---
tracker:
  kind: github-project
  api_key: env:PLAIN_TOKEN
codex:
  command: codex
---
Prompt`,
      { PLAIN_TOKEN: "ghp_plain_SECRET" }
    );

    const [diagnostic] = buildProviderDeprecationDiagnostics(workflow);

    expect(diagnostic?.remediation).toContain('api_key: "env:PLAIN_TOKEN"');
    expect(diagnostic?.remediation).not.toContain("ghp_plain_SECRET");
    expect(diagnostic?.details?.providerBlock).toContain(
      'api_key: "env:PLAIN_TOKEN"'
    );
  });
});
