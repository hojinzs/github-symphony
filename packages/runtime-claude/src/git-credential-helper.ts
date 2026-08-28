import {
  resolveGitHubGraphQLToken,
  type GitHubGraphQLToolConfig,
} from "@gh-symphony/tool-github-graphql";

async function main(): Promise<void> {
  const request = Object.fromEntries(
    (await readStdin())
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const separator = line.indexOf("=");
        return separator === -1 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
      })
  );
  if (request.host?.toLowerCase() !== "github.com") return;
  const token = await resolveGitHubGraphQLToken({
    tokenBrokerUrl: process.env.GITHUB_TOKEN_BROKER_URL,
    tokenBrokerSecret: process.env.GITHUB_TOKEN_BROKER_SECRET,
    tokenCachePath: process.env.GITHUB_TOKEN_CACHE_PATH,
  } satisfies Pick<GitHubGraphQLToolConfig, "tokenBrokerUrl" | "tokenBrokerSecret" | "tokenCachePath">);
  process.stdout.write(`protocol=${request.protocol ?? "https"}\nhost=${request.host}\nusername=x-access-token\npassword=${token}\n\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
