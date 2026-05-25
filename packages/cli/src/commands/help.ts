import { bold, cyan, yellow } from "../ansi.js";
import type { GlobalOptions } from "../index.js";

export type HelpEntry = {
  name: string;
  description: string | string[];
};

export type HelpSection = {
  title: string;
  entries: HelpEntry[];
};

export const DESCRIPTION_COLUMN = 30;
export const COMMAND_COLUMN_WIDTH = DESCRIPTION_COLUMN - 2;

export const HELP_SECTIONS: HelpSection[] = [
  {
    title: "Setup",
    entries: [
      {
        name: "setup",
        description: "Run the one-command first-run setup flow",
      },
      {
        name: "workflow init",
        description: "Generate WORKFLOW.md and workflow support files",
      },
      {
        name: "workflow validate",
        description: "Strictly validate WORKFLOW.md",
      },
      {
        name: "workflow preview",
        description: "Render the worker prompt from a sample or live issue",
      },
      {
        name: "doctor",
        description: "Run diagnostics and optional remediation",
      },
      {
        name: "config show",
        description: "Show current configuration",
      },
      {
        name: "config set",
        description: "Set a configuration value",
      },
      {
        name: "config edit",
        description: "Open config in $EDITOR",
      },
    ],
  },
  {
    title: "Orchestration (current repository)",
    entries: [
      {
        name: "repo init",
        description: "Initialize gh-symphony for the current repository",
      },
      {
        name: "repo start",
        description: "Start the orchestrator (foreground)",
      },
      {
        name: "repo start --daemon",
        description: "Start the orchestrator in the background",
      },
      {
        name: "repo start --assigned-only",
        description: "Process only issues assigned to the authenticated user",
      },
      {
        name: "repo stop",
        description: "Stop the background orchestrator",
      },
      {
        name: "repo status",
        description: "Show orchestrator status",
      },
      {
        name: "repo run <issue>",
        description: "Dispatch a single issue",
      },
      {
        name: "repo recover",
        description: "Recover stalled runs",
      },
      {
        name: "repo logs",
        description: "View orchestrator logs",
      },
      {
        name: "repo explain <issue>",
        description: "Explain why an issue is not dispatching",
      },
    ],
  },
  {
    title: "Maintenance",
    entries: [
      {
        name: "upgrade",
        description: "Upgrade the CLI to the latest published version",
      },
      {
        name: "completion <shell>",
        description: "Print shell completion (bash/zsh/fish)",
      },
      {
        name: "version",
        description: "Show version",
      },
      {
        name: "help [command]",
        description: "Show help for a command",
      },
    ],
  },
  {
    title: "Global Options",
    entries: [
      {
        name: "--config <dir>",
        description: [
          "Config directory override (advanced; default uses initialized",
          "cwd runtime, then ~/.gh-symphony)",
        ],
      },
      {
        name: "--verbose, -v",
        description: "Verbose output",
      },
      {
        name: "--json",
        description: "JSON output",
      },
      {
        name: "--no-color",
        description: "Disable color output",
      },
      {
        name: "--help, -h",
        description: "Show help",
      },
      {
        name: "--version, -V",
        description: "Show version",
      },
    ],
  },
];

function sectionTitle(title: string, color: boolean): string {
  const label = `${title}:`;
  return color ? yellow(bold(label)) : label;
}

function entryName(name: string, color: boolean): string {
  return color ? cyan(name) : name;
}

function renderEntry(entry: HelpEntry, color: boolean): string[] {
  const descriptions = Array.isArray(entry.description)
    ? entry.description
    : [entry.description];
  const lines = [
    `  ${entryName(entry.name, color)}${" ".repeat(
      Math.max(COMMAND_COLUMN_WIDTH - entry.name.length, 1)
    )}${descriptions[0]}`,
  ];

  for (const line of descriptions.slice(1)) {
    lines.push(`${" ".repeat(DESCRIPTION_COLUMN)}${line}`);
  }

  return lines;
}

export function renderHelp(options: { color: boolean }): string {
  const lines = ["gh-symphony — AI Coding Agent Orchestrator", ""];

  for (const [index, section] of HELP_SECTIONS.entries()) {
    if (index > 0) {
      lines.push("");
    }
    lines.push(sectionTitle(section.title, options.color));
    for (const entry of section.entries) {
      lines.push(...renderEntry(entry, options.color));
    }
  }

  return `${lines.join("\n")}\n`;
}

const handler = async (
  _args: string[],
  options: GlobalOptions
): Promise<void> => {
  process.stdout.write(renderHelp({ color: !options.noColor }));
};

export default handler;
