import type { GlobalOptions } from "../index.js";

const HELP_TEXT = `
gh-symphony — AI Coding Agent Orchestrator

Usage: gh-symphony <command> [options]

Setup:
  init            Interactive workspace setup wizard
  config show     Show current configuration
  config set      Set a configuration value
  config edit     Open config in $EDITOR

Orchestration:
  start           Start the orchestrator (foreground)
  start --daemon  Start the orchestrator (background)
  stop            Stop the background orchestrator
  status          Show orchestrator status
  run <issue>     Dispatch a single issue
  recover         Recover stalled runs
  logs            View orchestrator logs

Workspace Management:
  project list    List all workspaces
  project switch  Switch active workspace
  project status  Show workspace details
  repo list       List configured repositories
  repo add        Add a repository
  repo remove     Remove a repository

Global Options:
  --config <dir>  Config directory (default: ~/.gh-symphony)
  --verbose       Enable verbose output
  --json          Output in JSON format
  --no-color      Disable color output
  --help, -h      Show this help message
  --version, -V   Show version

Examples:
  gh-symphony init                    # Set up a new workspace
  gh-symphony start                   # Start orchestrator
  gh-symphony start --daemon          # Start in background
  gh-symphony run org/repo#123        # Dispatch a specific issue
  gh-symphony status --watch          # Watch status in real-time
`.trimStart();

const handler = async (
  _args: string[],
  _options: GlobalOptions
): Promise<void> => {
  process.stdout.write(HELP_TEXT);
};

export default handler;
