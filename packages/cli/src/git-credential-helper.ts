import { runGitCredentialHelper } from "@gh-symphony/runtime-codex";
import { writeSync } from "node:fs";

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  runGitCredentialHelper().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    writeSync(2, `${message}\n`);
    process.exit(1);
  });
}
