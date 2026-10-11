import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const temporaryDirectory = realpathSync(
  mkdtempSync(join(tmpdir(), "gh-symphony-pack-"))
);

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
    "dist/management-local.js",
    "dist/management-local.d.ts",
    "dist/mcp-server.js",
    "dist/git-credential-helper.js",
  ]) {
    if (!packagedFiles.has(requiredFile)) {
      throw new Error(`Published package is missing ${requiredFile}`);
    }
  }

  // Execute only the installed tarball: workspace hoisting must not mask missing
  // production dependencies or omitted lazy chunks.
  writeFileSync(join(temporaryDirectory, "package.json"), '{"private":true}');
  run(
    "npm",
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(temporaryDirectory, packOutput[0].filename),
    ],
    { cwd: temporaryDirectory }
  );
  const packageRoot = join(temporaryDirectory, "node_modules/@gh-symphony/cli");
  const dist = join(packageRoot, "dist");
  const sdkChunks = readdirSync(dist).filter(
    (name) =>
      name.endsWith(".js") &&
      readFileSync(join(dist, name), "utf8").includes("@opentelemetry+sdk-")
  );
  if (sdkChunks.length === 0)
    throw new Error("No packaged lazy SDK chunks found");
  for (const chunk of sdkChunks) {
    run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "await import(process.argv[1])",
        pathToFileURL(join(dist, chunk)).href,
      ],
      { cwd: temporaryDirectory }
    );
  }
  // The loader records actual evaluation, rather than merely searching imports.
  const loader = join(temporaryDirectory, "sdk-boundary-loader.mjs");
  writeFileSync(
    loader,
    `
    export async function load(url, context, next) {
      const result = await next(url, context);
      const source = String(result.source ?? "");
      if (url.includes("@opentelemetry") || source.includes("@opentelemetry+")) {
        throw new Error("FORBIDDEN_SDK_EVALUATION");
      }
      return result;
    }
  `
  );
  const isolatedEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          !name.startsWith("SYMPHONY_") && name !== "WORKING_DIRECTORY"
      )
    ),
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
  };
  run(
    process.execPath,
    [
      "--experimental-loader",
      pathToFileURL(loader).href,
      join(dist, "index.js"),
      "--version",
    ],
    { cwd: temporaryDirectory, env: isolatedEnv }
  );
  const worker = spawnSync(
    process.execPath,
    [
      "--experimental-loader",
      pathToFileURL(loader).href,
      join(dist, "worker-entry.js"),
    ],
    {
      cwd: temporaryDirectory,
      env: isolatedEnv,
      encoding: "utf8",
      timeout: 10000,
    }
  );
  if (
    worker.error ||
    worker.signal ||
    worker.status !== 0 ||
    worker.stderr.includes("FORBIDDEN_SDK_EVALUATION")
  ) {
    throw new Error(
      `Packaged worker boundary failed: ${worker.error ?? worker.stderr}`
    );
  }
  process.stdout.write(
    `Clean packed install: ${packOutput[0].size} tarball bytes; ${sdkChunks.length} SDK chunks resolved; disabled CLI and worker SDK boundary passed.\n`
  );
  run(process.execPath, [
    "--input-type=module",
    "-e",
    'import {pathToFileURL} from "node:url"; const module = await import(pathToFileURL(process.argv[1]).href); if(typeof module.AgentRegistry !== "function" || typeof module.createLocalManagementAdapter !== "function") throw new Error("Local management module exports unavailable");',
    join(packageRoot, "dist/management-local.js"),
  ]);
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
