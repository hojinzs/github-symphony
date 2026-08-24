import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Derives the stable cache identifier for a standalone project folder. */
export function standaloneProjectId(projectDirInput: string): string {
  const projectDir = resolve(projectDirInput);
  return `${slugify(basename(projectDir)) || "project"}-${createHash("sha256").update(projectDir).digest("hex").slice(0, 8)}`;
}
