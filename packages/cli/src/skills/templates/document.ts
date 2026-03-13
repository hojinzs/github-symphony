type SkillDocumentOptions = {
  name: string;
  description: string;
  bodyLines: string[];
};

export function renderSkillDocument(options: SkillDocumentOptions): string {
  const { name, description, bodyLines } = options;

  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "license: MIT",
    "metadata:",
    "  author: gh-symphony",
    '  version: "1.0"',
    '  generatedBy: "gh-symphony"',
    "---",
    "",
    ...bodyLines,
  ].join("\n");
}
