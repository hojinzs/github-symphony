import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  resolveSkillsDir,
  writeSkillFile,
  writeAllSkills,
} from "./skill-writer.js";
import type { SkillTemplate, SkillTemplateContext } from "./types.js";

describe("skill-writer", () => {
  describe("resolveSkillsDir", () => {
    it("resolves claude-code runtime to .claude/skills", () => {
      const result = resolveSkillsDir("/repo", "claude-code");
      expect(result).toBe(join("/repo", ".claude", "skills"));
    });

    it("resolves codex runtime to .codex/skills", () => {
      const result = resolveSkillsDir("/repo", "codex");
      expect(result).toBe(join("/repo", ".codex", "skills"));
    });

    it("returns null for unknown runtime", () => {
      const result = resolveSkillsDir("/repo", "unknown");
      expect(result).toBeNull();
    });
  });

  describe("writeSkillFile", () => {
    it("writes skill file for claude-code runtime", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "skill-test-"));
      const skillsDir = join(tempDir, ".claude", "skills");

      const template: SkillTemplate = {
        name: "test-skill",
        fileName: "SKILL.md",
        generate: () => "# Test Skill\n\nContent here.",
      };

      const context: SkillTemplateContext = {
        runtime: "claude-code",
        projectId: "proj-123",
        projectTitle: "Test Project",
        repositories: [{ owner: "acme", name: "platform" }],
        statusColumns: [
          { id: "col-1", name: "Todo", role: "active" },
          { id: "col-2", name: "Done", role: "terminal" },
        ],
        statusFieldId: "field-123",
        contextYamlPath: "context.yaml",
        referenceWorkflowPath: "WORKFLOW.md",
      };

      const result = await writeSkillFile(skillsDir, template, context);

      expect(result.written).toBe(true);
      expect(result.path).toBe(join(skillsDir, "test-skill", "SKILL.md"));

      const content = await readFile(result.path, "utf8");
      expect(content).toBe("# Test Skill\n\nContent here.");
    });

    it("skips existing file when overwrite is false", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "skill-test-"));
      const skillsDir = join(tempDir, ".claude", "skills");

      const template: SkillTemplate = {
        name: "test-skill",
        fileName: "SKILL.md",
        generate: () => "# New Content",
      };

      const context: SkillTemplateContext = {
        runtime: "claude-code",
        projectId: "proj-123",
        projectTitle: "Test Project",
        repositories: [],
        statusColumns: [],
        statusFieldId: "field-123",
        contextYamlPath: "context.yaml",
        referenceWorkflowPath: "WORKFLOW.md",
      };

      const firstResult = await writeSkillFile(skillsDir, template, context);
      expect(firstResult.written).toBe(true);

      const secondResult = await writeSkillFile(skillsDir, template, context, {
        overwrite: false,
      });
      expect(secondResult.written).toBe(false);
      expect(secondResult.path).toBe(firstResult.path);

      const content = await readFile(secondResult.path, "utf8");
      expect(content).toBe("# New Content");
    });

    it("overwrites existing file when overwrite is true", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "skill-test-"));
      const skillsDir = join(tempDir, ".claude", "skills");

      const template: SkillTemplate = {
        name: "test-skill",
        fileName: "SKILL.md",
        generate: () => "# Updated Content",
      };

      const context: SkillTemplateContext = {
        runtime: "claude-code",
        projectId: "proj-123",
        projectTitle: "Test Project",
        repositories: [],
        statusColumns: [],
        statusFieldId: "field-123",
        contextYamlPath: "context.yaml",
        referenceWorkflowPath: "WORKFLOW.md",
      };

      const firstResult = await writeSkillFile(skillsDir, template, context);
      expect(firstResult.written).toBe(true);

      const secondResult = await writeSkillFile(skillsDir, template, context, {
        overwrite: true,
      });
      expect(secondResult.written).toBe(true);

      const content = await readFile(secondResult.path, "utf8");
      expect(content).toBe("# Updated Content");
    });
  });

  describe("writeAllSkills", () => {
    it("writes multiple skills for claude-code runtime", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "skill-test-"));

      const templates: SkillTemplate[] = [
        {
          name: "skill-1",
          fileName: "SKILL.md",
          generate: () => "# Skill 1",
        },
        {
          name: "skill-2",
          fileName: "SKILL.md",
          generate: () => "# Skill 2",
        },
      ];

      const context: SkillTemplateContext = {
        runtime: "claude-code",
        projectId: "proj-123",
        projectTitle: "Test Project",
        repositories: [],
        statusColumns: [],
        statusFieldId: "field-123",
        contextYamlPath: "context.yaml",
        referenceWorkflowPath: "WORKFLOW.md",
      };

      const result = await writeAllSkills(
        tempDir,
        "claude-code",
        templates,
        context
      );

      expect(result.written).toHaveLength(2);
      expect(result.skipped).toHaveLength(0);
      expect(result.written[0]).toContain("skill-1");
      expect(result.written[1]).toContain("skill-2");
    });

    it("writes multiple skills for codex runtime", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "skill-test-"));

      const templates: SkillTemplate[] = [
        {
          name: "skill-1",
          fileName: "SKILL.md",
          generate: () => "# Skill 1",
        },
      ];

      const context: SkillTemplateContext = {
        runtime: "codex",
        projectId: "proj-123",
        projectTitle: "Test Project",
        repositories: [],
        statusColumns: [],
        statusFieldId: "field-123",
        contextYamlPath: "context.yaml",
        referenceWorkflowPath: "WORKFLOW.md",
      };

      const result = await writeAllSkills(tempDir, "codex", templates, context);

      expect(result.written).toHaveLength(1);
      expect(result.written[0]).toContain(".codex/skills");
    });

    it("returns empty arrays for unknown runtime", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "skill-test-"));

      const templates: SkillTemplate[] = [
        {
          name: "skill-1",
          fileName: "SKILL.md",
          generate: () => "# Skill 1",
        },
      ];

      const context: SkillTemplateContext = {
        runtime: "unknown",
        projectId: "proj-123",
        projectTitle: "Test Project",
        repositories: [],
        statusColumns: [],
        statusFieldId: "field-123",
        contextYamlPath: "context.yaml",
        referenceWorkflowPath: "WORKFLOW.md",
      };

      const result = await writeAllSkills(
        tempDir,
        "unknown",
        templates,
        context
      );

      expect(result.written).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
    });

    it("returns correct written/skipped arrays with mixed results", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "skill-test-"));

      const templates: SkillTemplate[] = [
        {
          name: "skill-1",
          fileName: "SKILL.md",
          generate: () => "# Skill 1",
        },
        {
          name: "skill-2",
          fileName: "SKILL.md",
          generate: () => "# Skill 2",
        },
      ];

      const context: SkillTemplateContext = {
        runtime: "claude-code",
        projectId: "proj-123",
        projectTitle: "Test Project",
        repositories: [],
        statusColumns: [],
        statusFieldId: "field-123",
        contextYamlPath: "context.yaml",
        referenceWorkflowPath: "WORKFLOW.md",
      };

      const firstResult = await writeAllSkills(
        tempDir,
        "claude-code",
        templates,
        context
      );
      expect(firstResult.written).toHaveLength(2);
      expect(firstResult.skipped).toHaveLength(0);

      const secondResult = await writeAllSkills(
        tempDir,
        "claude-code",
        templates,
        context,
        { overwrite: false }
      );
      expect(secondResult.written).toHaveLength(0);
      expect(secondResult.skipped).toHaveLength(2);
    });
  });
});
