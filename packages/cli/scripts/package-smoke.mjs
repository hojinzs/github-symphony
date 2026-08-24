import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "gh-symphony-pack-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`
    );
  }

  return result.stdout;
}

try {
  const packOutput = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", temporaryDirectory])
  );
  const packagedFiles = new Set(packOutput[0].files.map(({ path }) => path));

  for (const requiredFile of [
    "dist/mcp-server.js",
    "dist/git-credential-helper.js",
  ]) {
    if (!packagedFiles.has(requiredFile)) {
      throw new Error(`Published package is missing ${requiredFile}`);
    }
  }

  const packageRoot = process.cwd();
  const initializeRequest = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  })}\n`;

  for (const [server, expectedName] of [
    ["github", "github-symphony-graphql"],
    ["linear", "github-symphony-linear-graphql"],
  ]) {
    const output = run(
      process.execPath,
      [join(packageRoot, "dist/mcp-server.js"), "--server", server],
      { input: initializeRequest }
    );
    const responses = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const initializeResponses = responses.filter(({ id }) => id === 1);

    if (
      initializeResponses.length !== 1 ||
      initializeResponses[0].result?.serverInfo?.name !== expectedName
    ) {
      throw new Error(`${server} MCP package smoke test returned ${output}`);
    }
  }

  const credentialOutput = run(
    process.execPath,
    [join(packageRoot, "dist/git-credential-helper.js")],
    {
      input: "protocol=https\nhost=github.com\n\n",
      env: { ...process.env, GITHUB_GRAPHQL_TOKEN: "ghs_package_smoke" },
    }
  );

  if (!credentialOutput.includes("password=ghs_package_smoke")) {
    throw new Error("Packaged Git credential helper did not return its token");
  }

  process.stdout.write("Packaged runtime entrypoint smoke tests passed.\n");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
