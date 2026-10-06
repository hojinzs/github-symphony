import { describe, expect, it } from "vitest";
import { parseWorkflowMarkdown } from "@gh-symphony/core";
import {
  exporterCredentialNames,
  stripExporterCredentials,
} from "./exporter-environment.js";

describe("OT-09 exporter credential ownership", () => {
  it.each([false, true])(
    "strips all final sources when enabled=%s",
    (enabled) => {
      const workflow = parseWorkflowMarkdown(
        `---
observability:
  otlp:
    enabled: ${enabled}
    headers:
      Authorization: $ARBITRARY_AUTH
---
Prompt`,
        {}
      );
      const names = exporterCredentialNames(workflow, ["TRACKER_AUTH"]);
      expect(
        stripExporterCredentials(
          {
            ARBITRARY_AUTH: "explicit-secret",
            OTEL_EXPORTER_OTLP_HEADERS: "project-secret",
            OTEL_EXPORTER_OTLP_LOGS_CLIENT_KEY: "process-secret",
            OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE: "certificate",
            OPENAI_API_KEY: "agent-secret",
            TRACKER_AUTH: "tracker-secret",
            NON_SECRET: "unchanged",
          },
          names
        )
      ).toEqual({
        OPENAI_API_KEY: "agent-secret",
        TRACKER_AUTH: "tracker-secret",
        NON_SECRET: "unchanged",
      });
    }
  );

  it.each([
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CUSTOM_AUTH",
    "TRACKER_AUTH",
    "OTEL_EXPORTER_OTLP_HEADERS",
  ])("rejects shared name %s without reading a value", (name) => {
    const workflow = parseWorkflowMarkdown(
      `---
runtime:
  kind: custom
  command: agent
  auth:
    env: ${name === "CUSTOM_AUTH" || name === "OTEL_EXPORTER_OTLP_HEADERS" ? name : "CUSTOM_AUTH"}
observability:
  otlp:
    enabled: false
    headers:
      Authorization: $${name}
---
Prompt`,
      {}
    );
    expect(() => exporterCredentialNames(workflow, ["TRACKER_AUTH"])).toThrow(
      /use a distinct exporter credential name/
    );
  });
});
