import { describe, expect, it } from "vitest";
import { parseWorkflowMarkdown } from "@gh-symphony/core";
import {
  buildProviderDeprecationDiagnostics,
  buildStateConcurrencyDiagnostics,
} from "./priority-diagnostics.js";

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

describe("buildStateConcurrencyDiagnostics", () => {
  it("renders complete grammar for blank state names", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
agent:
  max_concurrent_agents_by_state:
    "  ": 3
codex:
  command: codex
---
Prompt`);

    expect(buildStateConcurrencyDiagnostics(workflow)).toEqual([
      expect.objectContaining({
        summary:
          'agent.max_concurrent_agents_by_state["  "] is ignored: state name is blank after normalization.',
      }),
    ]);
  });

  it("renders collision warnings with grammar and padded paths", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
agent:
  max_concurrent_agents_by_state:
    Ready: 1
    " READY ": 2
codex:
  command: codex
---
Prompt`);

    expect(buildStateConcurrencyDiagnostics(workflow)).toEqual([
      expect.objectContaining({
        summary:
          'agent.max_concurrent_agents_by_state.Ready is ignored: duplicates agent.max_concurrent_agents_by_state[" READY "] after state-name normalization.',
      }),
    ]);
  });
});
