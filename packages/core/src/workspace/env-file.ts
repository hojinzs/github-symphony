import { existsSync, readFileSync } from "node:fs";

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }

  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .reduce<Record<string, string>>((result, line) => {
      const separatorIndex = line.indexOf("=");
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();

      if (key) {
        result[key] = value;
      }

      return result;
    }, {});
}
