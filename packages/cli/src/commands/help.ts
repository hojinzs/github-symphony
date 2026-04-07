import type { GlobalOptions } from "../index.js";

const HELP_TEXT = `
gh-symphony — AI Coding Agent Orchestrator

Usage: gh-symphony <command> [options]

Setup:
  setup           Run the one-command setup flow
  workflow init   Generate WORKFLOW.md and workflow support files
  workflow validate
                  Parse and strictly validate WORKFLOW.md
  workflow preview
                  Render the final worker prompt from a sample issue
  doctor          Run diagnostics and optional first-run remediation
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

Project Management:
  project add      Add a new project (interactive wizard)
  project list     List all configured projects
  project remove   Remove a project

Project / Repo:
  project list    List projects
  project switch  Switch active project
  project status  Show orchestrator status for a project
  repo list       List configured repositories
  repo add        Add a repository
  repo remove     Remove a repository
  repo sync       Sync repositories from the linked GitHub Project

Global Options:
  --config <dir>  Config directory (default: ~/.gh-symphony)
  --verbose       Enable verbose output
  --json          Output in JSON format
  --no-color      Disable color output
  --help, -h      Show this help message
  --version, -V   Show version

Examples:
  gh-symphony setup                   # Generate workflow files and register the project
  gh-symphony workflow init           # Generate WORKFLOW.md for the current repo
  gh-symphony workflow validate       # Strictly validate WORKFLOW.md authoring changes
  gh-symphony workflow preview --attempt 2
  gh-symphony project add              # Add a project (interactive)
  gh-symphony doctor                   # Validate local setup and prerequisites
  gh-symphony doctor --fix             # Apply safe remediation and print manual follow-ups
  gh-symphony project add --non-interactive --project <id> --workspace-dir <path>
  gh-symphony project list             # List all projects
  gh-symphony project remove <id>      # Remove a project
  gh-symphony repo sync --dry-run      # Preview linked repository drift
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
