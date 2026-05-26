import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isClaudeRuntime,
  isCodexRuntime,
} from "../workflow/workflow-runtime.js";
import type { SkillTemplate, SkillTemplateContext } from "./types.js";

export type SkillFilePlan = {
  path: string;
  content: string;
};

function normalizeRuntimeForSkills(
  runtime: string
): "claude-code" | "codex" | null {
  if (isClaudeRuntime(runtime)) {
    return "claude-code";
  }
  if (isCodexRuntime(runtime)) {
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

export function buildSkillFilePlans(
  repoRoot: string,
  runtime: string,
  templates: SkillTemplate[],
  context: SkillTemplateContext
): { skillsDir: string | null; files: SkillFilePlan[] } {
  const skillsDir = resolveSkillsDir(repoRoot, runtime);
  if (!skillsDir) {
    return { skillsDir: null, files: [] };
  }

  return {
    skillsDir,
    files: templates.flatMap((template) =>
      template.files.map((file) => ({
        path: join(skillsDir, template.name, file.relativePath),
        content: file.generate(context),
      }))
    ),
  };
}

export async function writeSkillFile(
  skillsDir: string,
  template: SkillTemplate,
  context: SkillTemplateContext,
  options?: {
    overwrite?: boolean;
    content?: string;
    plannedFiles?: SkillFilePlan[];
  }
): Promise<{ written: boolean; path: string }[]> {
  const results: { written: boolean; path: string }[] = [];
  const plannedFiles =
    options?.plannedFiles ??
    template.files.map((file) => ({
      path: join(skillsDir, template.name, file.relativePath),
      content: file.generate(context),
    }));

  if (options?.content !== undefined && plannedFiles.length === 1) {
    plannedFiles[0]!.content = options.content;
  }

  for (const plannedFile of plannedFiles) {
    if (!options?.overwrite) {
      try {
        await readFile(plannedFile.path, "utf8");
        results.push({ written: false, path: plannedFile.path });
        continue;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
      }
    }

    await mkdir(dirname(plannedFile.path), { recursive: true });
    const temporaryPath = `${plannedFile.path}.tmp`;
    await writeFile(temporaryPath, plannedFile.content, "utf8");
    await rename(temporaryPath, plannedFile.path);
    results.push({ written: true, path: plannedFile.path });
  }

  return results;
}

export async function writeAllSkills(
  repoRoot: string,
  runtime: string,
  templates: SkillTemplate[],
  context: SkillTemplateContext,
  options?: { overwrite?: boolean }
): Promise<{ written: string[]; skipped: string[] }> {
  const { skillsDir, files } = buildSkillFilePlans(
    repoRoot,
    runtime,
    templates,
    context
  );
  if (!skillsDir) {
    return { written: [], skipped: [] };
  }

  const written: string[] = [];
  const skipped: string[] = [];

  let plannedFileOffset = 0;
  for (const template of templates) {
    const plannedFiles = files.slice(
      plannedFileOffset,
      plannedFileOffset + template.files.length
    );
    plannedFileOffset += template.files.length;
    const results = await writeSkillFile(skillsDir, template, context, {
      ...options,
      plannedFiles,
    });
    for (const result of results) {
      if (result.written) {
        written.push(result.path);
      } else {
        skipped.push(result.path);
      }
    }
  }

  return { written, skipped };
}
