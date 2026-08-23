import { runGitCredentialHelper } from "@gh-symphony/runtime-codex";

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  runGitCredentialHelper().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
