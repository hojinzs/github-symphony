import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";
import { setNoColor } from "./ansi.js";
import { resolveConfigDir } from "./config.js";
import { renderCompletionScript } from "./completion.js";
import { renderHelp } from "./commands/help.js";
import { createRemovedCommandHandler } from "./commands/removed-command.js";

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
  | "workflow"
  | "setup"
  | "doctor"
  | "upgrade"
  | "repo"
  | "config"
  | "version";

type CliOptionValues = Partial<
  GlobalOptions & {
    assignedOnly?: boolean;
    config?: string;
    daemon?: boolean;
    dryRun?: boolean;
    file?: string;
    fix?: boolean;
    follow?: boolean;
    force?: boolean;
    http?: string | boolean;
    issue?: string;
    level?: string;
    logLevel?: string;
    nonInteractive?: boolean;
    once?: boolean;
    output?: string;
    project?: string;
    projectId?: string;
    prune?: boolean;
    run?: string;
    runtime?: string;
    skipContext?: boolean;
    skipSkills?: boolean;
    version?: boolean;
    web?: string | boolean;
    repoDir?: string;
    workflowFile?: string;
    workflow?: string;
    workspaceDir?: string;
    watch?: boolean;
    sample?: string;
    smoke?: boolean;
    attempt?: string;
  }
>;

const COMMANDS: Record<LoaderKey, () => Promise<{ default: CommandHandler }>> =
  {
    workflow: () => import("./commands/workflow.js"),
    setup: () => import("./commands/setup.js"),
    doctor: () => import("./commands/doctor.js"),
    upgrade: () => import("./commands/upgrade.js"),
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
  setNoColor(options.noColor);

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

async function invokeRemovedCommand(
  message: string,
  values: CliOptionValues
): Promise<void> {
  await createRemovedCommandHandler(message)([], resolveGlobalOptions(values));
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
  setNoColor(options.noColor);

  return options;
}

function renderRootHelp(command: Command): string {
  const values = command.optsWithGlobals<CliOptionValues>();
  const noColor = Boolean(values.noColor);
  return renderHelp({ color: !noColor });
}

function registerRemovedCommand(
  program: Command,
  commandSpec: string,
  message: string,
  markInvoked: () => void
): void {
  const handler = createRemovedCommandHandler(message);
  addGlobalOptions(
    program
      .command(commandSpec, { hidden: true })
      .allowUnknownOption(true)
      .allowExcessArguments(true)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    await handler([], resolveGlobalOptions(values));
  });
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
  program.helpInformation = () => renderRootHelp(program);

  registerRemovedCommand(
    program,
    "init",
    "Use 'gh-symphony workflow init'.",
    markInvoked
  );

  const workflow = addGlobalOptions(
    program.command("workflow").description("Manage WORKFLOW.md authoring")
  );

  workflow.action(async function (this: Command) {
    markInvoked();
    await invokeHandler(
      "workflow",
      [],
      this.optsWithGlobals<CliOptionValues>()
    );
  });

  addGlobalOptions(
    workflow
      .command("init")
      .description("Generate WORKFLOW.md and workflow support files")
      .option("--non-interactive", "Run without prompts")
      .option("--project <id>", "GitHub Project ID or URL")
      .option("--output <path>", "Write WORKFLOW.md to a custom path")
      .option(
        "--runtime <kind>",
        "Runtime preset: codex-app-server or claude-print"
      )
      .option("--skip-skills", "Skip runtime skill generation")
      .option("--skip-context", "Skip .gh-symphony/context.yaml generation")
      .option("--dry-run", "Preview generated files without writing them")
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = ["init"];
    pushOption(args, "--non-interactive", values.nonInteractive);
    pushOption(args, "--project", values.project);
    pushOption(args, "--output", values.output);
    pushOption(args, "--runtime", values.runtime);
    pushOption(args, "--skip-skills", values.skipSkills);
    pushOption(args, "--skip-context", values.skipContext);
    pushOption(args, "--dry-run", values.dryRun);
    await invokeHandler("workflow", args, values);
  });

  addGlobalOptions(
    workflow
      .command("validate")
      .description("Parse and strictly validate a WORKFLOW.md file")
      .option("--file <path>", "Validate a custom WORKFLOW.md path")
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = ["validate"];
    pushOption(args, "--file", values.file);
    await invokeHandler("workflow", args, values);
  });

  addGlobalOptions(
    workflow
      .command("preview")
      .description("Render the final worker prompt from a sample or live issue")
      .option("--file <path>", "Read a custom WORKFLOW.md path")
      .option("--issue <owner/repo#number>", "Load a live GitHub Project issue")
      .option("--project-id <projectId>", "Managed project identifier")
      .addOption(new Option("--project <projectId>").hideHelp())
      .option("--sample <json>", "Read sample issue JSON from a file")
      .option("--attempt <n>", "Render as retry attempt n")
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = ["preview"];
    pushOption(args, "--file", values.file);
    pushOption(args, "--issue", values.issue);
    pushOption(args, "--project-id", resolveProjectId(values));
    pushOption(args, "--sample", values.sample);
    pushOption(args, "--attempt", values.attempt);
    await invokeHandler("workflow", args, values);
  });

  addGlobalOptions(
    program
      .command("setup")
      .description("Run the one-command first-run setup flow")
      .option("--non-interactive", "Run without prompts")
      .option("--project <id>", "GitHub Project ID or URL")
      .option("--workspace-dir <path>", "Workspace directory")
      .option("--assigned-only", "Limit processing to assigned issues")
      .option("--output <path>", "Write WORKFLOW.md to a custom path")
      .option("--skip-skills", "Skip runtime skill generation")
      .option("--skip-context", "Skip .gh-symphony/context.yaml generation")
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = [];
    pushOption(args, "--non-interactive", values.nonInteractive);
    pushOption(args, "--project", values.project);
    pushOption(args, "--workspace-dir", values.workspaceDir);
    pushOption(args, "--assigned-only", values.assignedOnly);
    pushOption(args, "--output", values.output);
    pushOption(args, "--skip-skills", values.skipSkills);
    pushOption(args, "--skip-context", values.skipContext);
    await invokeHandler("setup", args, values);
  });

  addGlobalOptions(
    program
      .command("doctor")
      .description("Run diagnostics and optional first-run remediation")
      .option("--project-id <projectId>", "Project identifier")
      .option(
        "--fix",
        "Apply safe remediation steps and print manual follow-ups"
      )
      .option(
        "--smoke",
        "Run a safe live issue readiness check without dispatching work"
      )
      .option("--issue <owner/repo#number>", "Live issue to validate")
      .addOption(new Option("--project <projectId>").hideHelp())
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = [];
    pushOption(args, "--project-id", resolveProjectId(values));
    pushOption(args, "--fix", values.fix);
    pushOption(args, "--smoke", values.smoke);
    pushOption(args, "--issue", values.issue);
    await invokeHandler("doctor", args, values);
  });

  addGlobalOptions(
    program
      .command("upgrade")
      .description("Upgrade the CLI to the latest published version")
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    await invokeHandler("upgrade", [], this.optsWithGlobals<CliOptionValues>());
  });

  registerRemovedCommand(
    program,
    "start",
    "Use 'gh-symphony repo start' from the target repository.",
    markInvoked
  );
  registerRemovedCommand(
    program,
    "stop",
    "Use 'gh-symphony repo stop'.",
    markInvoked
  );
  registerRemovedCommand(
    program,
    "status",
    "Use 'gh-symphony repo status'.",
    markInvoked
  );
  registerRemovedCommand(
    program,
    "run",
    "Use 'gh-symphony repo run <issue>'.",
    markInvoked
  );
  registerRemovedCommand(
    program,
    "recover",
    "Use 'gh-symphony repo recover'.",
    markInvoked
  );
  registerRemovedCommand(
    program,
    "logs",
    "Use 'gh-symphony repo logs'.",
    markInvoked
  );

  addGlobalOptions(
    program
      .command("project")
      .description("Removed project namespace")
      .argument("[args...]", "Removed project command arguments")
      .allowUnknownOption(true)
      .allowExcessArguments(true)
  ).action(async function (this: Command) {
    markInvoked();
    await createRemovedCommandHandler(
      "The 'project' command was removed. The orchestrator is now per-repository. Run 'gh-symphony repo init' in the target repository."
    )([], resolveGlobalOptions(this.optsWithGlobals<CliOptionValues>()));
  });

  const repo = addGlobalOptions(
    program
      .command("repo")
      .description("Manage the current repository runtime")
  );

  repo.action(async function (this: Command) {
    markInvoked();
    await invokeHandler("repo", [], this.optsWithGlobals<CliOptionValues>());
  });

  addGlobalOptions(repo.command("list").description("Removed")).action(
    async function (this: Command) {
      markInvoked();
      await invokeRemovedCommand(
        "Removed. Repository identity is shown by 'repo status'.",
        this.optsWithGlobals<CliOptionValues>()
      );
    }
  );

  addGlobalOptions(
    repo
      .command("add")
      .description("Removed")
      .argument("[owner/name]", "Repository spec")
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    await invokeRemovedCommand(
      "Removed. The orchestrator binds to the cwd repository via 'repo init'.",
      this.optsWithGlobals<CliOptionValues>()
    );
  });

  addGlobalOptions(
    repo
      .command("remove")
      .description("Removed")
      .argument("[owner/name]", "Repository spec")
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    await invokeRemovedCommand(
      "Removed. The orchestrator binds to the cwd repository via 'repo init'.",
      this.optsWithGlobals<CliOptionValues>()
    );
  });

  addGlobalOptions(
    repo.command("sync").description("Removed").allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    await invokeRemovedCommand(
      "Removed. Single-repo model has no linked-repo set to sync.",
      this.optsWithGlobals<CliOptionValues>()
    );
  });

  addGlobalOptions(
    repo
      .command("init")
      .description("Initialize gh-symphony for the current repository")
      .option("--repo-dir <path>", "Repository directory")
      .option("--workflow-file <path>", "Use a custom WORKFLOW.md path")
      .allowExcessArguments(false)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = ["init"];
    pushOption(args, "--repo-dir", values.repoDir);
    pushOption(args, "--workflow-file", values.workflowFile);
    await invokeHandler("repo", args, values);
  });

  addGlobalOptions(
    repo
      .command("start")
      .description("Start the orchestrator for the current repository")
      .option("-d, --daemon", "Start in daemon mode")
      .option("--once", "Run a single orchestration tick and exit")
      .option(
        "--http [port]",
        "Expose dashboard and refresh endpoints over HTTP"
      )
      .option(
        "--web [port]",
        "Expose the control plane web dashboard and API over HTTP"
      )
      .option("--log-level <level>", "Orchestrator lifecycle log level")
      .allowUnknownOption(true)
      .allowExcessArguments(true)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = ["start", ...this.args];
    pushOption(args, "--daemon", values.daemon);
    pushOption(args, "--once", values.once);
    pushOption(args, "--http", values.http);
    pushOption(args, "--web", values.web);
    pushOption(args, "--log-level", values.logLevel);
    await invokeHandler("repo", args, values);
  });

  addGlobalOptions(
    repo
      .command("status")
      .description("Show current repository orchestrator status")
      .option("-w, --watch", "Watch status continuously")
      .allowUnknownOption(true)
      .allowExcessArguments(true)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = ["status", ...this.args];
    pushOption(args, "--watch", values.watch);
    await invokeHandler("repo", args, values);
  });

  addGlobalOptions(
    repo
      .command("stop")
      .description("Stop the current repository background orchestrator")
      .option("--force", "Force stop with SIGKILL")
      .allowUnknownOption(true)
      .allowExcessArguments(true)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = ["stop", ...this.args];
    pushOption(args, "--force", values.force);
    await invokeHandler("repo", args, values);
  });

  addGlobalOptions(
    repo
      .command("run")
      .description("Dispatch a single issue from the current repository")
      .argument("[args...]", "Issue identifier and passthrough options")
      .option("--log-level <level>", "Orchestrator lifecycle log level")
      .option("-w, --watch", "Watch status after dispatch")
      .allowUnknownOption(true)
      .allowExcessArguments(true)
  ).action(async function (this: Command, passthrough: string[]) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = ["run", ...passthrough];
    pushOption(args, "--log-level", values.logLevel);
    pushOption(args, "--watch", values.watch);
    await invokeHandler("repo", args, values);
  });

  addGlobalOptions(
    repo
      .command("recover")
      .description("Recover stalled runs for the current repository")
      .option("--dry-run", "Show recoverable runs without recovering")
      .allowUnknownOption(true)
      .allowExcessArguments(true)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = ["recover", ...this.args];
    pushOption(args, "--dry-run", values.dryRun);
    await invokeHandler("repo", args, values);
  });

  addGlobalOptions(
    repo
      .command("logs")
      .description("View current repository orchestrator logs")
      .option("-f, --follow", "Follow new log lines")
      .option("--issue <issue>", "Filter by issue identifier")
      .option("--run <runId>", "Read events for a specific run")
      .option("--level <level>", "Filter by log level")
      .allowUnknownOption(true)
      .allowExcessArguments(true)
  ).action(async function (this: Command) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = ["logs", ...this.args];
    pushOption(args, "--follow", values.follow);
    pushOption(args, "--issue", values.issue);
    pushOption(args, "--run", values.run);
    pushOption(args, "--level", values.level);
    await invokeHandler("repo", args, values);
  });

  addGlobalOptions(
    repo
      .command("explain")
      .description("Explain why a repository issue is not dispatching")
      .argument("[args...]", "Issue identifier and passthrough options")
      .option("--workflow <path>", "Path to the WORKFLOW.md file to evaluate")
      .allowUnknownOption(true)
      .allowExcessArguments(true)
  ).action(async function (this: Command, passthrough: string[]) {
    markInvoked();
    const values = this.optsWithGlobals<CliOptionValues>();
    const args: string[] = ["explain", ...passthrough];
    pushOption(args, "--workflow", values.workflow);
    await invokeHandler("repo", args, values);
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
