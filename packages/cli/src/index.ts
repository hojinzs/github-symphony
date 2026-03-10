#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolveConfigDir } from "./config.js";

export type GlobalOptions = {
  configDir: string;
  verbose: boolean;
  json: boolean;
  noColor: boolean;
};

export function parseGlobalOptions(argv: string[]): {
  options: GlobalOptions;
  command: string;
  args: string[];
} {
  const globalFlags: GlobalOptions = {
    configDir: resolveConfigDir(),
    verbose: false,
    json: false,
    noColor: false,
  };

  const remaining: string[] = [];
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--config" || arg === "--config-dir") {
      globalFlags.configDir = resolveConfigDir(argv[i + 1]);
      i += 2;
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      globalFlags.verbose = true;
      i += 1;
      continue;
    }
    if (arg === "--json") {
      globalFlags.json = true;
      i += 1;
      continue;
    }
    if (arg === "--no-color") {
      globalFlags.noColor = true;
      i += 1;
      continue;
    }

    remaining.push(arg!);
    i += 1;
  }

  const [command = "help", ...args] = remaining;
  return { options: globalFlags, command, args };
}

export type CommandHandler = (
  args: string[],
  options: GlobalOptions
) => Promise<void>;

const COMMANDS: Record<string, () => Promise<{ default: CommandHandler }>> = {
  init: () => import("./commands/init.js"),
  start: () => import("./commands/start.js"),
  stop: () => import("./commands/stop.js"),
  status: () => import("./commands/status.js"),
  run: () => import("./commands/run.js"),
  recover: () => import("./commands/recover.js"),
  logs: () => import("./commands/logs.js"),
  project: () => import("./commands/project.js"),
  repo: () => import("./commands/repo.js"),
  config: () => import("./commands/config-cmd.js"),
  help: () => import("./commands/help.js"),
  version: () => import("./commands/version.js"),
};

export async function runCli(argv: string[]): Promise<void> {
  const { options, command, args } = parseGlobalOptions(argv);

  if (options.noColor) {
    process.env.NO_COLOR = "1";
  }

  if (command === "--help" || command === "-h") {
    const helpModule = await COMMANDS.help!();
    await helpModule.default(args, options);
    return;
  }

  if (command === "--version" || command === "-V") {
    const versionModule = await COMMANDS.version!();
    await versionModule.default(args, options);
    return;
  }

  const loader = COMMANDS[command];
  if (!loader) {
    process.stderr.write(
      `Unknown command: ${command}\nRun 'gh-symphony help' for usage.\n`
    );
    process.exitCode = 2;
    return;
  }

  const module = await loader();
  await module.default(args, options);
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
