#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Server } from "node:http";
import { assertValidDashboardProjectId, DashboardFsReader } from "./store.js";
import { startDashboardServer } from "./server.js";

export { DashboardFsReader, statusForIssue } from "./store.js";
export {
  createDashboardRequestHandler,
  resolveDashboardResponse,
  startDashboardServer,
} from "./server.js";

export async function runCli(
  argv: string[],
  dependencies: {
    stdout?: Pick<NodeJS.WriteStream, "write">;
    stderr?: Pick<NodeJS.WriteStream, "write">;
  } = {}
): Promise<void> {
  const parsed = parseArgs(argv);
  if (!parsed.projectId) {
    throw new Error("Dashboard CLI requires --project-id.");
  }
  assertValidDashboardProjectId(parsed.projectId);

  const runtimeRoot = resolve(parsed.runtimeRoot ?? ".runtime");
  const reader = new DashboardFsReader(runtimeRoot, parsed.projectId);
  const server = startDashboardServer({
    host: parsed.host ?? "127.0.0.1",
    port: parsed.port ?? 0,
    reader,
  });
  const stdout = dependencies.stdout ?? process.stdout;

  await waitForServerReady(server, stdout);
}

async function waitForServerReady(
  server: Server,
  stdout: Pick<NodeJS.WriteStream, "write">
): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    const handleListening = () => {
      cleanup();

      const address = server.address();
      if (address && typeof address === "object") {
        const host =
          address.address === "::" || address.address === "0.0.0.0"
            ? "localhost"
            : address.address;
        const urlHost =
          host !== "localhost" && host.includes(":") ? `[${host}]` : host;
        stdout.write(
          `Dashboard server listening on http://${urlHost}:${address.port}\n`
        );
      }

      resolveReady();
    };

    const handleError = (error: Error) => {
      cleanup();
      rejectReady(error);
    };

    const cleanup = () => {
      server.off("listening", handleListening);
      server.off("error", handleError);
    };

    server.once("listening", handleListening);
    server.once("error", handleError);
  });
}

function parseArgs(args: string[]): {
  runtimeRoot?: string;
  projectId?: string;
  host?: string;
  port?: number;
} {
  const parsed: {
    runtimeRoot?: string;
    projectId?: string;
    host?: string;
    port?: number;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];

    if (!argument?.startsWith("--")) {
      continue;
    }

    switch (argument) {
      case "--runtime-root":
        parsed.runtimeRoot = readOptionValue(argument, value);
        index += 1;
        break;
      case "--project":
      case "--project-id":
        parsed.projectId = readOptionValue(argument, value);
        index += 1;
        break;
      case "--host":
        parsed.host = readOptionValue(argument, value);
        index += 1;
        break;
      case "--port":
        parsed.port = parseInteger(readNumericOptionValue(argument, value));
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  return parsed;
}

function readOptionValue(argument: string, value: string | undefined): string {
  if (!value || value.startsWith("-")) {
    throw new Error(`Option '${argument}' argument missing`);
  }

  return value;
}

function readNumericOptionValue(
  argument: string,
  value: string | undefined
): string {
  if (!value || value.startsWith("-")) {
    throw new Error(`Option '${argument}' argument missing`);
  }

  return value;
}

function parseInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Expected an integer value but received "${value}".`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(
      `Expected a port number between 0 and 65535 but received "${value}".`
    );
  }

  return parsed;
}

async function main(): Promise<void> {
  await runCli(process.argv.slice(2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Unknown error"}\n`
    );
    process.exitCode = 1;
  });
}
