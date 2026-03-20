import { readFile, readdir } from "node:fs/promises";

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isFileMissing(error)) {
      return null;
    }

    throw error;
  }
}

export async function safeReadDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (isFileMissing(error)) {
      return [];
    }

    throw error;
  }
}

export function isFileMissing(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
