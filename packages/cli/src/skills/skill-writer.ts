import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillTemplate, SkillTemplateContext } from "./types.js";

function normalizeRuntimeForSkills(
  runtime: string
): "claude-code" | "codex" | null {
  if (runtime === "claude-code" || runtime.includes("claude-code")) {
    return "claude-code";
  }
  if (runtime === "codex" || runtime.includes("codex")) {
    return "codex";
  }
  return null;
}

export function resolveSkillsDir(
  repoRoot: string,
  runtime: string
): string | null {
  const normalizedRuntime = normalizeRuntimeForSkills(runtime);
  if (normalizedRuntime === "claude-code") {
    return join(repoRoot, ".claude", "skills");
  }
  if (normalizedRuntime === "codex") {
    return join(repoRoot, ".codex", "skills");
  }
  return null;
}

export async function writeSkillFile(
  skillsDir: string,
  template: SkillTemplate,
  context: SkillTemplateContext,
  options?: { overwrite?: boolean }
): Promise<{ written: boolean; path: string }> {
  const skillDir = join(skillsDir, template.name);
  const filePath = join(skillDir, template.fileName);

  if (!options?.overwrite) {
    try {
      await readFile(filePath, "utf8");
      return { written: false, path: filePath };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }
  }

  await mkdir(skillDir, { recursive: true });
  const content = template.generate(context);
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(temporaryPath, filePath);

  return { written: true, path: filePath };
}

export async function writeAllSkills(
  repoRoot: string,
  runtime: string,
  templates: SkillTemplate[],
  context: SkillTemplateContext,
  options?: { overwrite?: boolean }
): Promise<{ written: string[]; skipped: string[] }> {
  const skillsDir = resolveSkillsDir(repoRoot, runtime);
  if (!skillsDir) {
    return { written: [], skipped: [] };
  }

  const written: string[] = [];
  const skipped: string[] = [];

  for (const template of templates) {
    const result = await writeSkillFile(skillsDir, template, context, options);
    if (result.written) {
      written.push(result.path);
    } else {
      skipped.push(result.path);
    }
  }

  return { written, skipped };
}
