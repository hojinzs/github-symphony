import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalOptions } from "../index.js";

const handler = async (
  _args: string[],
  options: GlobalOptions
): Promise<void> => {
  let version = "0.0.0";

  try {
    const pkgPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "package.json"
    );
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
      version?: string;
    };
    version = pkg.version ?? version;
  } catch {
    // Fall back to default
  }

  if (options.json) {
    process.stdout.write(JSON.stringify({ version }) + "\n");
  } else {
    process.stdout.write(`gh-symphony v${version}\n`);
  }
};

export default handler;
