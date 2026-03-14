import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProjectDetail, ProjectStatusField } from "../github/client.js";
import type { DetectedEnvironment } from "../detection/environment-detector.js";
import { inferStateRole } from "../mapping/smart-defaults.js";
import type { ContextYaml } from "./context-types.js";

export type BuildContextYamlParams = {
  projectDetail: ProjectDetail;
  statusField: ProjectStatusField;
  detectedEnvironment: DetectedEnvironment;
  runtime: { agent: string; agent_command: string };
};

function yamlQuote(value: string): string {
  const specialChars = /[:#{'"\]{}()\\[]|\n/;
  if (specialChars.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

export function generateContextYamlString(context: ContextYaml): string {
  const lines: string[] = [];

  lines.push("schema_version: 1");
  lines.push(`collected_at: ${context.collected_at}`);
  lines.push("");

  lines.push("project:");
  lines.push(`  id: ${context.project.id}`);
  lines.push(`  title: ${yamlQuote(context.project.title)}`);
  lines.push(`  url: ${context.project.url}`);
  lines.push("");

  lines.push("status_field:");
  lines.push(`  id: ${context.status_field.id}`);
  lines.push(`  name: ${yamlQuote(context.status_field.name)}`);
  lines.push("  columns:");
  for (const column of context.status_field.columns) {
    lines.push(`    - id: ${column.id}`);
    lines.push(`      name: ${yamlQuote(column.name)}`);
    lines.push(
      `      color: ${column.color === null ? "null" : yamlQuote(column.color)}`
    );
    lines.push(
      `      inferred_role: ${column.inferred_role === null ? "null" : column.inferred_role}`
    );
    lines.push(`      confidence: ${column.confidence}`);
  }
  lines.push("");

  lines.push("text_fields:");
  if (context.text_fields.length === 0) {
    lines.push("  []");
  } else {
    for (const field of context.text_fields) {
      lines.push(`  - id: ${field.id}`);
      lines.push(`    name: ${yamlQuote(field.name)}`);
      lines.push(`    data_type: ${field.data_type}`);
    }
  }
  lines.push("");

  lines.push("repositories:");
  if (context.repositories.length === 0) {
    lines.push("  []");
  } else {
    for (const repo of context.repositories) {
      lines.push(`  - owner: ${repo.owner}`);
      lines.push(`    name: ${repo.name}`);
      lines.push(`    clone_url: ${repo.clone_url}`);
    }
  }
  lines.push("");

  lines.push("detected_environment:");
  lines.push(
    `  packageManager: ${context.detected_environment.packageManager === null ? "null" : yamlQuote(context.detected_environment.packageManager)}`
  );
  lines.push(
    `  lockfile: ${context.detected_environment.lockfile === null ? "null" : yamlQuote(context.detected_environment.lockfile)}`
  );
  lines.push(
    `  testCommand: ${context.detected_environment.testCommand === null ? "null" : yamlQuote(context.detected_environment.testCommand)}`
  );
  lines.push(
    `  buildCommand: ${context.detected_environment.buildCommand === null ? "null" : yamlQuote(context.detected_environment.buildCommand)}`
  );
  lines.push(
    `  lintCommand: ${context.detected_environment.lintCommand === null ? "null" : yamlQuote(context.detected_environment.lintCommand)}`
  );
  lines.push(
    `  ciPlatform: ${context.detected_environment.ciPlatform === null ? "null" : yamlQuote(context.detected_environment.ciPlatform)}`
  );
  lines.push(`  monorepo: ${context.detected_environment.monorepo}`);
  lines.push("  existingSkills:");
  if (context.detected_environment.existingSkills.length === 0) {
    lines.push("    []");
  } else {
    for (const skill of context.detected_environment.existingSkills) {
      lines.push(`    - ${yamlQuote(skill)}`);
    }
  }
  lines.push("");

  lines.push("runtime:");
  lines.push(`  agent: ${yamlQuote(context.runtime.agent)}`);
  lines.push(`  agent_command: ${yamlQuote(context.runtime.agent_command)}`);

  return lines.join("\n") + "\n";
}

export async function writeContextYaml(
  outputDir: string,
  context: ContextYaml
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const contextPath = `${outputDir}/.gh-symphony/context.yaml`;
  await mkdir(dirname(contextPath), { recursive: true });
  const temporaryPath = `${contextPath}.tmp`;
  const yamlContent = generateContextYamlString(context);
  await writeFile(temporaryPath, yamlContent, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(temporaryPath, contextPath);
}

export function buildContextYaml(params: BuildContextYamlParams): ContextYaml {
  const columns = params.statusField.options.map((option) => {
    const roleMapping = inferStateRole(option.name);
    return {
      id: option.id,
      name: option.name,
      color: option.color,
      inferred_role: roleMapping.role as "active" | "wait" | "terminal" | null,
      confidence: roleMapping.confidence,
    };
  });

  const textFields: ContextYaml["text_fields"] =
    params.projectDetail.textFields.map((field) => ({
      id: field.id,
      name: field.name,
      data_type: field.dataType,
    }));

  const repositories = params.projectDetail.linkedRepositories.map((repo) => ({
    owner: repo.owner,
    name: repo.name,
    clone_url: repo.cloneUrl,
  }));

  return {
    schema_version: 1,
    collected_at: new Date().toISOString(),
    project: {
      id: params.projectDetail.id,
      title: params.projectDetail.title,
      url: params.projectDetail.url,
    },
    status_field: {
      id: params.statusField.id,
      name: params.statusField.name,
      columns,
    },
    text_fields: textFields,
    repositories,
    detected_environment: params.detectedEnvironment,
    runtime: params.runtime,
  };
}
