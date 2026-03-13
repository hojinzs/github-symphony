import type { DetectedEnvironment } from "../detection/environment-detector.js";

export type ContextYaml = {
  schema_version: 1;
  collected_at: string; // ISO 8601
  project: {
    id: string;
    title: string;
    url: string;
  };
  status_field: {
    id: string;
    name: string;
    columns: Array<{
      id: string;
      name: string;
      color: string | null;
      inferred_role: "active" | "wait" | "terminal" | null;
      confidence: "high" | "low";
    }>;
  };
  text_fields: Array<{
    id: string;
    name: string;
    data_type: string;
    inferred_purpose: "blocker" | null;
  }>;
  repositories: Array<{
    owner: string;
    name: string;
    clone_url: string;
  }>;
  detected_environment: DetectedEnvironment;
  runtime: {
    agent: string; // "codex" | "claude-code" | "custom"
    agent_command: string;
  };
};
