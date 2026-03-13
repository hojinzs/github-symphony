import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectDetail, ProjectStatusField } from "../github/client.js";
import type { DetectedEnvironment } from "../detection/environment-detector.js";
import {
  buildContextYaml,
  generateContextYamlString,
  writeContextYaml,
} from "./generate-context-yaml.js";

describe("generate-context-yaml", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `test-context-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("generates normal context.yaml with 3 columns, 2 repos, 1 text field", () => {
    const projectDetail: ProjectDetail = {
      id: "PVT_123",
      title: "My Project",
      url: "https://github.com/orgs/acme/projects/1",
      statusFields: [],
      textFields: [
        {
          id: "FIELD_1",
          name: "Blocked By",
          dataType: "text",
        },
      ],
      linkedRepositories: [
        {
          owner: "acme",
          name: "api",
          url: "https://github.com/acme/api",
          cloneUrl: "https://github.com/acme/api.git",
        },
        {
          owner: "acme",
          name: "web",
          url: "https://github.com/acme/web",
          cloneUrl: "https://github.com/acme/web.git",
        },
      ],
    };

    const statusField: ProjectStatusField = {
      id: "STATUS_1",
      name: "Status",
      options: [
        {
          id: "OPT_1",
          name: "Todo",
          description: null,
          color: "#CCCCCC",
        },
        {
          id: "OPT_2",
          name: "In Progress",
          description: null,
          color: "#0366D6",
        },
        {
          id: "OPT_3",
          name: "Done",
          description: null,
          color: "#28A745",
        },
      ],
    };

    const detectedEnvironment: DetectedEnvironment = {
      packageManager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      testCommand: "vitest",
      buildCommand: "tsc",
      lintCommand: "eslint",
      ciPlatform: "github-actions",
      monorepo: true,
      existingSkills: [],
    };

    const context = buildContextYaml({
      projectDetail,
      statusField,
      detectedEnvironment,
      runtime: { agent: "codex", agent_command: "codex run" },
      blockedByFieldName: "Blocked By",
    });

    expect(context.schema_version).toBe(1);
    expect(context.project.id).toBe("PVT_123");
    expect(context.project.title).toBe("My Project");
    expect(context.status_field.id).toBe("STATUS_1");
    expect(context.status_field.columns).toHaveLength(3);
    expect(context.status_field.columns[0].id).toBe("OPT_1");
    expect(context.status_field.columns[0].name).toBe("Todo");
    expect(context.status_field.columns[1].inferred_role).toBe("active");
    expect(context.status_field.columns[2].inferred_role).toBe("terminal");
    expect(context.text_fields).toHaveLength(1);
    expect(context.text_fields[0].inferred_purpose).toBe("blocker");
    expect(context.repositories).toHaveLength(2);
    expect(context.repositories[0].owner).toBe("acme");
    expect(context.repositories[0].name).toBe("api");
    expect(context.repositories[0].clone_url).toBe(
      "https://github.com/acme/api.git"
    );
    expect(context.detected_environment.packageManager).toBe("pnpm");
    expect(context.runtime.agent).toBe("codex");
  });

  it("quotes special characters in YAML values", () => {
    const projectDetail: ProjectDetail = {
      id: "PVT_456",
      title: "Project: With Colon",
      url: "https://github.com/orgs/test/projects/2",
      statusFields: [],
      textFields: [],
      linkedRepositories: [],
    };

    const statusField: ProjectStatusField = {
      id: "STATUS_2",
      name: "Status Field",
      options: [
        {
          id: "OPT_A",
          name: "Won't Do",
          description: null,
          color: null,
        },
        {
          id: "OPT_B",
          name: "In Progress (Blocked)",
          description: null,
          color: "#FF6B6B",
        },
      ],
    };

    const detectedEnvironment: DetectedEnvironment = {
      packageManager: null,
      lockfile: null,
      testCommand: null,
      buildCommand: null,
      lintCommand: null,
      ciPlatform: null,
      monorepo: false,
      existingSkills: [],
    };

    const context = buildContextYaml({
      projectDetail,
      statusField,
      detectedEnvironment,
      runtime: { agent: "claude-code", agent_command: "claude code" },
    });

    const yaml = generateContextYamlString(context);

    expect(yaml).toContain('"Project: With Colon"');
    expect(yaml).toContain('"Won\'t Do"');
    expect(yaml).toContain('"In Progress (Blocked)"');
    expect(yaml).not.toContain("ghp_");
    expect(yaml).not.toContain("token");
  });

  it("preserves field IDs and option IDs", () => {
    const projectDetail: ProjectDetail = {
      id: "PVT_789",
      title: "Test",
      url: "https://github.com/orgs/test/projects/3",
      statusFields: [],
      textFields: [
        {
          id: "CUSTOM_FIELD_ID_XYZ",
          name: "Custom Field",
          dataType: "text",
        },
      ],
      linkedRepositories: [],
    };

    const statusField: ProjectStatusField = {
      id: "CUSTOM_STATUS_ID_ABC",
      name: "Status",
      options: [
        {
          id: "CUSTOM_OPTION_ID_1",
          name: "Open",
          description: null,
          color: null,
        },
      ],
    };

    const detectedEnvironment: DetectedEnvironment = {
      packageManager: null,
      lockfile: null,
      testCommand: null,
      buildCommand: null,
      lintCommand: null,
      ciPlatform: null,
      monorepo: false,
      existingSkills: [],
    };

    const context = buildContextYaml({
      projectDetail,
      statusField,
      detectedEnvironment,
      runtime: { agent: "custom", agent_command: "custom-agent" },
    });

    const yaml = generateContextYamlString(context);

    expect(yaml).toContain("CUSTOM_STATUS_ID_ABC");
    expect(yaml).toContain("CUSTOM_OPTION_ID_1");
    expect(yaml).toContain("CUSTOM_FIELD_ID_XYZ");
  });

  it("does not include tokens or secrets in output", () => {
    const projectDetail: ProjectDetail = {
      id: "PVT_TOKENS",
      title: "Token Test Project",
      url: "https://github.com/orgs/test/projects/6",
      statusFields: [],
      textFields: [],
      linkedRepositories: [
        {
          owner: "test-org",
          name: "test-repo",
          url: "https://github.com/test-org/test-repo",
          cloneUrl: "https://github.com/test-org/test-repo.git",
        },
      ],
    };

    const statusField: ProjectStatusField = {
      id: "STATUS_TOKENS",
      name: "Status",
      options: [
        {
          id: "OPT_TOKENS",
          name: "Open",
          description: null,
          color: null,
        },
      ],
    };

    const detectedEnvironment: DetectedEnvironment = {
      packageManager: null,
      lockfile: null,
      testCommand: null,
      buildCommand: null,
      lintCommand: null,
      ciPlatform: null,
      monorepo: false,
      existingSkills: [],
    };

    const context = buildContextYaml({
      projectDetail,
      statusField,
      detectedEnvironment,
      runtime: { agent: "codex", agent_command: "codex run" },
    });

    const yaml = generateContextYamlString(context);

    expect(yaml).not.toContain("ghp_");
    expect(yaml).not.toContain("ghu_");
    expect(yaml).not.toContain("github_pat_");
    expect(yaml).not.toContain("password");
  });

  it("includes schema_version: 1 in output", () => {
    const projectDetail: ProjectDetail = {
      id: "PVT_VERSION",
      title: "Version Test",
      url: "https://github.com/orgs/test/projects/4",
      statusFields: [],
      textFields: [],
      linkedRepositories: [],
    };

    const statusField: ProjectStatusField = {
      id: "STATUS_VERSION",
      name: "Status",
      options: [],
    };

    const detectedEnvironment: DetectedEnvironment = {
      packageManager: null,
      lockfile: null,
      testCommand: null,
      buildCommand: null,
      lintCommand: null,
      ciPlatform: null,
      monorepo: false,
      existingSkills: [],
    };

    const context = buildContextYaml({
      projectDetail,
      statusField,
      detectedEnvironment,
      runtime: { agent: "codex", agent_command: "codex run" },
    });

    const yaml = generateContextYamlString(context);

    expect(yaml).toContain("schema_version: 1");
    expect(context.schema_version).toBe(1);
  });

  it("writes context.yaml to .gh-symphony/context.yaml with atomic write", async () => {
    const projectDetail: ProjectDetail = {
      id: "PVT_WRITE",
      title: "Write Test",
      url: "https://github.com/orgs/test/projects/5",
      statusFields: [],
      textFields: [],
      linkedRepositories: [],
    };

    const statusField: ProjectStatusField = {
      id: "STATUS_WRITE",
      name: "Status",
      options: [
        {
          id: "OPT_WRITE",
          name: "Done",
          description: null,
          color: null,
        },
      ],
    };

    const detectedEnvironment: DetectedEnvironment = {
      packageManager: null,
      lockfile: null,
      testCommand: null,
      buildCommand: null,
      lintCommand: null,
      ciPlatform: null,
      monorepo: false,
      existingSkills: [],
    };

    const context = buildContextYaml({
      projectDetail,
      statusField,
      detectedEnvironment,
      runtime: { agent: "codex", agent_command: "codex run" },
    });

    await writeContextYaml(tempDir, context);

    const contextPath = join(tempDir, ".gh-symphony", "context.yaml");
    const content = await readFile(contextPath, "utf8");

    expect(content).toContain("schema_version: 1");
    expect(content).toContain("PVT_WRITE");
    expect(content).toContain("Write Test");
  });
});
