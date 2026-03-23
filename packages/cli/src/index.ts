#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";
import { resolveConfigDir } from "./config.js";
import { renderCompletionScript } from "./completion.js";

export type GlobalOptions = {
  configDir: string;
  verbose: boolean;
  json: boolean;
  noColor: boolean;
};

export type CommandHandler = (
  args: string[],
  options: GlobalOptions
) => Promise<void>;

type LoaderKey =
  | "init"
  | "start"
  | "stop"
  | "status"
  | "run"
  | "recover"
  | "logs"
  | "project"
  | "repo"
  | "config"
  | "version";

type CliOptionValues = Partial<
  GlobalOptions & {
    assignedOnly?: boolean;
    config?: string;
    daemon?: boolean;
    dryRun?: boolean;
    follow?: boolean;
    force?: boolean;
    http?: string | boolean;
    issue?: string;
    level?: string;
    logLevel?: string;
    nonInteractive?: boolean;
    project?: string;
    projectId?: string;
    run?: string;
    version?: boolean;
    workspaceDir?: string;
    watch?: boolean;
  }
>;

const COMMANDS: Record<LoaderKey, () => Promise<{ default: CommandHandler }>> =
  {
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
    version: () => import("./commands/version.js"),
  };

function addGlobalOptions(command: Command): Command {
  return command
    .option("--config <dir>", "Config directory")
    .addOption(new Option("--config-dir <dir>").hideHelp())
    .option("-v, --verbose", "Enable verbose output")
    .option("--json", "Output in JSON format")
    .option("--no-color", "Disable color output");
}

function resolveGlobalOptions(values: CliOptionValues): GlobalOptions {
  const configInput =
    typeof values.config === "string"
      ? values.config
      : typeof values.configDir === "string"
        ? values.configDir
        : undefined;
  const options: GlobalOptions = {
    configDir: resolveConfigDir(configInput),
    verbose: Boolean(values.verbose),
    json: Boolean(values.json),
    noColor: Boolean(values.noColor),
  };

  if (options.noColor) {
    process.env.NO_COLOR = "1";
  }

  return options;
}

function resolveProjectId(values: CliOptionValues): string | undefined {
  return values.projectId ?? values.project;
}

function pushOption(
  args: string[],
  flag: string,
  value?: string | boolean
): void {
  if (typeof value === "string" && value.length > 0) {
    args.push(flag, value);
    return;
  }
  if (value === true) {
    args.push(flag);
  }
}

async function invokeHandler(
  key: LoaderKey,
  args: string[],
  values: CliOptionValues
): Promise<void> {
  const module = await COMMANDS[key]();
  await module.default(args, resolveGlobalOptions(values));
}

function shellArgument(value: string): "bash" | "zsh" | "fish" {
  if (value === "bash" || value === "zsh" || value === "fish") {
    return value;
  }
  throw new InvalidArgumentError("Shell must be one of: bash, zsh, fish");
}

function hasVersionFlag(argv: string[]): boolean {
  return argv.some((arg) => arg === "--version" || arg === "-V");
}

function resolveVersionOptions(argv: string[]): GlobalOptions {
  const options: GlobalOptions = {
    configDir: resolveConfigDir(),
    verbose: argv.some((arg) => arg === "--verbose" || arg === "-v"),
    json: argv.includes("--json"),
    noColor: argv.includes("--no-color"),
  };

  if (options.noColor) {
    process.env.NO_COLOR = "1";
  }

  return options;
}

function createProgram(): { program: Command; wasInvoked: () => boolean } {
  let actionInvoked = false;
  const markInvoked = () => {
    actionInvoked = true;
  };

  const program = addGlobalOptions(
    new Command()
      .name("gh-symphony")
      .description("AI Coding Agent Orchestrator")
      .exitOverride()
      .helpOption("-h, --help", "Show help")
      .addHelpCommand("help [command]", "Show help for command")
      .showHelpAfterError("(run with --help for usage)")
      .option("-V, --version", "Show version")
  );

  addGlobalOptions(
    program
      .command("init")
      .description("Interactive project setup wizard")
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    await invokeHandler("init", [], this.optsWithGlobals<CliOptionValues>());
  });

  addGlobalOptions(
    program
      .command("start")
      .description("Start the orchestrator")
      .option("-d, --daemon", "Start in daemon mode")
      .option("--http [port]", "Expose dashboard and refresh endpoints over HTTP")
      .option("--log-level <level>", "Orchestrator lifecycle log level")
      .option("--project-id <projectId>", "Project identifier")
      .addOption(new Option("--project <projectId>").hideHelp())
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = [];
    pushOption(args, "--project-id", resolveProjectId(values));
    pushOption(args, "--daemon", values.daemon);
    pushOption(args, "--http", values.http);
    pushOption(args, "--log-level", values.logLevel);
    await invokeHandler("start", args, values);
  });

  addGlobalOptions(
    program
      .command("stop")
      .description("Stop the background orchestrator")
      .option("--force", "Force stop with SIGKILL")
      .option("--project-id <projectId>", "Project identifier")
      .addOption(new Option("--project <projectId>").hideHelp())
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = [];
    pushOption(args, "--project-id", resolveProjectId(values));
    pushOption(args, "--force", values.force);
    await invokeHandler("stop", args, values);
  });

  addGlobalOptions(
    program
      .command("status")
      .description("Show orchestrator status")
      .option("-w, --watch", "Watch status continuously")
      .option("--project-id <projectId>", "Project identifier")
      .addOption(new Option("--project <projectId>").hideHelp())
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = [];
    pushOption(args, "--project-id", resolveProjectId(values));
    pushOption(args, "--watch", values.watch);
    await invokeHandler("status", args, values);
  });

  addGlobalOptions(
    program
      .command("run")
      .description("Dispatch a single issue")
      .argument("<issue>", "Issue identifier")
      .option("--log-level <level>", "Orchestrator lifecycle log level")
      .option("-w, --watch", "Watch status after dispatch")
      .option("--project-id <projectId>", "Project identifier")
      .addOption(new Option("--project <projectId>").hideHelp())
      .allowExcessArguments(false)
  ).action(async function (this: Command, issue: string) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = [issue];
    pushOption(args, "--project-id", resolveProjectId(values));
    pushOption(args, "--log-level", values.logLevel);
    pushOption(args, "--watch", values.watch);
    await invokeHandler("run", args, values);
  });

  addGlobalOptions(
    program
      .command("recover")
      .description("Recover stalled runs")
      .option("--dry-run", "Show recoverable runs without recovering")
      .option("--project-id <projectId>", "Project identifier")
      .addOption(new Option("--project <projectId>").hideHelp())
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = [];
    pushOption(args, "--project-id", resolveProjectId(values));
    pushOption(args, "--dry-run", values.dryRun);
    await invokeHandler("recover", args, values);
  });

  addGlobalOptions(
    program
      .command("logs")
      .description("View orchestrator logs")
      .option("-f, --follow", "Follow new log lines")
      .option("--issue <issue>", "Filter by issue identifier")
      .option("--run <runId>", "Read events for a specific run")
      .option("--level <level>", "Filter by log level")
      .option("--project-id <projectId>", "Project identifier")
      .addOption(new Option("--project <projectId>").hideHelp())
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = [];
    pushOption(args, "--project-id", resolveProjectId(values));
    pushOption(args, "--follow", values.follow);
    pushOption(args, "--issue", values.issue);
    pushOption(args, "--run", values.run);
    pushOption(args, "--level", values.level);
    await invokeHandler("logs", args, values);
  });

  const project = addGlobalOptions(
    program.command("project").description("Manage configured projects")
  );

  project.action(async function (this: Command) {
    markInvoked();
    await invokeHandler("project", [], this.optsWithGlobals<CliOptionValues>());
  });

  addGlobalOptions(
    project
      .command("add")
      .description("Add a new project")
      .option("--non-interactive", "Run without prompts")
      .option("--project <id>", "GitHub Project ID")
      .option("--workspace-dir <path>", "Workspace directory")
      .option("--assigned-only", "Limit processing to assigned issues")
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = [];
    pushOption(args, "--non-interactive", values.nonInteractive);
    pushOption(args, "--project", values.project);
    pushOption(args, "--workspace-dir", values.workspaceDir);
    pushOption(args, "--assigned-only", values.assignedOnly);
    await invokeHandler("project", ["add", ...args], values);
  });

  addGlobalOptions(
    project.command("list").description("List configured projects")
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    await invokeHandler("project", ["list"], values);
  });

  addGlobalOptions(
    project
      .command("remove")
      .description("Remove a project")
      .argument("<projectId>", "Project identifier")
      .allowExcessArguments(false)
  ).action(async function (this: Command, projectId: string) {
    markInvoked();
    await invokeHandler(
      "project",
      ["remove", projectId],
      this.optsWithGlobals<CliOptionValues>()
    );
  });

  addGlobalOptions(
    project
      .command("start")
      .description("Start a specific project")
      .option("-d, --daemon", "Start in daemon mode")
      .option("--http [port]", "Expose dashboard and refresh endpoints over HTTP")
      .option("--log-level <level>", "Orchestrator lifecycle log level")
      .option("--project-id <projectId>", "Project identifier")
      .addOption(new Option("--project <projectId>").hideHelp())
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args = ["start"];
    pushOption(args, "--project-id", resolveProjectId(values));
    pushOption(args, "--daemon", values.daemon);
    pushOption(args, "--http", values.http);
    pushOption(args, "--log-level", values.logLevel);
    await invokeHandler("project", args, values);
  });

  addGlobalOptions(
    project
      .command("stop")
      .description("Stop a specific project")
      .option("--force", "Force stop with SIGKILL")
      .option("--project-id <projectId>", "Project identifier")
      .addOption(new Option("--project <projectId>").hideHelp())
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args = ["stop"];
    pushOption(args, "--project-id", resolveProjectId(values));
    pushOption(args, "--force", values.force);
    await invokeHandler("project", args, values);
  });

  addGlobalOptions(
    project.command("switch").description("Switch the active project")
  ).action(async function (this: Command) {
    markInvoked();
    await invokeHandler(
      "project",
      ["switch"],
      this.optsWithGlobals<CliOptionValues>()
    );
  });

  addGlobalOptions(
    project
      .command("status")
      .description("Show status for a specific project")
      .option("-w, --watch", "Watch status continuously")
      .option("--project-id <projectId>", "Project identifier")
      .addOption(new Option("--project <projectId>").hideHelp())
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args = ["status"];
    pushOption(args, "--project-id", resolveProjectId(values));
    pushOption(args, "--watch", values.watch);
    await invokeHandler("project", args, values);
  });

  const repo = addGlobalOptions(
    program
      .command("repo")
      .description("Manage repositories in the active project")
  );

  repo.action(async function (this: Command) {
    markInvoked();
    await invokeHandler("repo", [], this.optsWithGlobals<CliOptionValues>());
  });

  addGlobalOptions(
    repo.command("list").description("List repositories")
  ).action(async function (this: Command) {
    markInvoked();
    await invokeHandler(
      "repo",
      ["list"],
      this.optsWithGlobals<CliOptionValues>()
    );
  });

  addGlobalOptions(
    repo
      .command("add")
      .description("Add a repository")
      .argument("<owner/name>", "Repository spec")
      .allowExcessArguments(false)
  ).action(async function (this: Command, repoSpec: string) {
    markInvoked();
    await invokeHandler(
      "repo",
      ["add", repoSpec],
      this.optsWithGlobals<CliOptionValues>()
    );
  });

  addGlobalOptions(
    repo
      .command("remove")
      .description("Remove a repository")
      .argument("<owner/name>", "Repository spec")
      .allowExcessArguments(false)
  ).action(async function (this: Command, repoSpec: string) {
    markInvoked();
    await invokeHandler(
      "repo",
      ["remove", repoSpec],
      this.optsWithGlobals<CliOptionValues>()
    );
  });

  const config = addGlobalOptions(
    program.command("config").description("Manage CLI configuration")
  );

  config.action(async function (this: Command) {
    markInvoked();
    await invokeHandler("config", [], this.optsWithGlobals<CliOptionValues>());
  });

  addGlobalOptions(
    config.command("show").description("Show configuration")
  ).action(async function (this: Command) {
    markInvoked();
    await invokeHandler(
      "config",
      ["show"],
      this.optsWithGlobals<CliOptionValues>()
    );
  });

  addGlobalOptions(
    config
      .command("set")
      .description("Set a configuration value")
      .argument("<key>", "Configuration key")
      .argument("<value>", "Configuration value")
      .allowExcessArguments(false)
  ).action(async function (this: Command, key: string, value: string) {
    markInvoked();
    await invokeHandler(
      "config",
      ["set", key, value],
      this.optsWithGlobals<CliOptionValues>()
    );
  });

  addGlobalOptions(
    config.command("edit").description("Open config in $EDITOR")
  ).action(async function (this: Command) {
    markInvoked();
    await invokeHandler(
      "config",
      ["edit"],
      this.optsWithGlobals<CliOptionValues>()
    );
  });

  addGlobalOptions(
    program
      .command("completion")
      .description("Print shell completion script")
      .argument("<shell>", "Shell name", shellArgument)
      .allowExcessArguments(false)
  ).action(async function (this: Command, shell: "bash" | "zsh" | "fish") {
    markInvoked();
    process.stdout.write(renderCompletionScript(shell));
  });

  program
    .command("version")
    .description("Show version")
    .allowExcessArguments(false)
    .action(async function (this: Command) {
      markInvoked();
      await invokeHandler(
        "version",
        [],
        this.optsWithGlobals<CliOptionValues>()
      );
    });

  return { program, wasInvoked: () => actionInvoked };
}

export async function runCli(argv: string[]): Promise<void> {
  const { program, wasInvoked } = createProgram();

  if (hasVersionFlag(argv)) {
    const versionModule = await COMMANDS.version();
    await versionModule.default([], resolveVersionOptions(argv));
    return;
  }

  try {
    await program.parseAsync(["node", "gh-symphony", ...argv], {
      from: "node",
    });

    if (!wasInvoked()) {
      program.outputHelp();
    }
  } catch (error) {
    if (
      error instanceof CommanderError &&
      error.code === "commander.helpDisplayed"
    ) {
      return;
    }

    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }

    throw error;
  }
}

async function main(): Promise<void> {
  await runCli(process.argv.slice(2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Unknown error"}\n`
    );
    process.exitCode = 1;
  });
}
