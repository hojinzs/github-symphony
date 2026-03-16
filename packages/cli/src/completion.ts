const TOP_LEVEL_COMMANDS = [
  "init",
  "start",
  "stop",
  "status",
  "run",
  "recover",
  "logs",
  "project",
  "repo",
  "config",
  "completion",
  "help",
  "version",
] as const;

const GLOBAL_OPTIONS = [
  "--config",
  "--config-dir",
  "--verbose",
  "-v",
  "--json",
  "--no-color",
  "--help",
  "-h",
  "--version",
  "-V",
] as const;

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  completion: ["bash", "zsh", "fish"],
  start: ["--project-id", "--project", "--daemon", "-d", ...GLOBAL_OPTIONS],
  stop: ["--project-id", "--project", "--force", ...GLOBAL_OPTIONS],
  status: ["--project-id", "--project", "--watch", "-w", ...GLOBAL_OPTIONS],
  run: ["--project-id", "--project", "--watch", "-w", ...GLOBAL_OPTIONS],
  recover: ["--project-id", "--project", "--dry-run", ...GLOBAL_OPTIONS],
  logs: [
    "--project-id",
    "--project",
    "--follow",
    "-f",
    "--issue",
    "--run",
    "--level",
    ...GLOBAL_OPTIONS,
  ],
  project: ["add", "list", "remove", "start", "stop", "switch", "status"],
  "project:add": [
    "--non-interactive",
    "--project",
    "--workspace-dir",
    "--assigned-only",
    ...GLOBAL_OPTIONS,
  ],
  "project:list": [...GLOBAL_OPTIONS],
  "project:remove": [...GLOBAL_OPTIONS],
  "project:start": [
    "--project-id",
    "--project",
    "--daemon",
    "-d",
    ...GLOBAL_OPTIONS,
  ],
  "project:stop": ["--project-id", "--project", "--force", ...GLOBAL_OPTIONS],
  "project:switch": [...GLOBAL_OPTIONS],
  "project:status": [
    "--project-id",
    "--project",
    "--watch",
    "-w",
    ...GLOBAL_OPTIONS,
  ],
  repo: ["list", "add", "remove"],
  "repo:list": [...GLOBAL_OPTIONS],
  "repo:add": [...GLOBAL_OPTIONS],
  "repo:remove": [...GLOBAL_OPTIONS],
  config: ["show", "set", "edit"],
  "config:show": [...GLOBAL_OPTIONS],
  "config:set": [...GLOBAL_OPTIONS],
  "config:edit": [...GLOBAL_OPTIONS],
};

function quoteWords(values: readonly string[]): string {
  return values.join(" ");
}

function renderBashCasePatterns(): string {
  return Object.entries(COMMAND_OPTIONS)
    .map(([key, values]) => {
      const [command, subcommand] = key.split(":");
      if (!subcommand) {
        if (command === "completion") {
          return `    completion)\n      COMPREPLY=( $(compgen -W "${quoteWords(values)}" -- "$cur") )\n      return\n      ;;`;
        }
        if (
          command === "project" ||
          command === "repo" ||
          command === "config"
        ) {
          return `    ${command})\n      if (( COMP_CWORD == 2 )); then\n        COMPREPLY=( $(compgen -W "${quoteWords(values)}" -- "$cur") )\n      fi\n      return\n      ;;`;
        }
        return `    ${command})\n      COMPREPLY=( $(compgen -W "${quoteWords(values)}" -- "$cur") )\n      return\n      ;;`;
      }

      return `    ${command}:${subcommand})\n      COMPREPLY=( $(compgen -W "${quoteWords(values)}" -- "$cur") )\n      return\n      ;;`;
    })
    .join("\n");
}

function renderFishLines(): string {
  const lines = GLOBAL_OPTIONS.map((option) =>
    option.startsWith("--")
      ? `complete -c gh-symphony -f -l ${option.slice(2)}`
      : `complete -c gh-symphony -f -s ${option.slice(1)}`
  );

  for (const command of TOP_LEVEL_COMMANDS) {
    lines.push(
      `complete -c gh-symphony -f -n '__fish_use_subcommand' -a '${command}'`
    );
  }

  for (const subcommand of COMMAND_OPTIONS.project ?? []) {
    lines.push(
      `complete -c gh-symphony -f -n '__fish_seen_subcommand_from project' -a '${subcommand}'`
    );
  }

  for (const subcommand of COMMAND_OPTIONS.repo ?? []) {
    lines.push(
      `complete -c gh-symphony -f -n '__fish_seen_subcommand_from repo' -a '${subcommand}'`
    );
  }

  for (const subcommand of COMMAND_OPTIONS.config ?? []) {
    lines.push(
      `complete -c gh-symphony -f -n '__fish_seen_subcommand_from config' -a '${subcommand}'`
    );
  }

  for (const shell of COMMAND_OPTIONS.completion ?? []) {
    lines.push(
      `complete -c gh-symphony -f -n '__fish_seen_subcommand_from completion' -a '${shell}'`
    );
  }

  return lines.join("\n");
}

export function renderCompletionScript(shell: "bash" | "zsh" | "fish"): string {
  if (shell === "fish") {
    return `${renderFishLines()}\n`;
  }

  const bashFunction = `# shellcheck shell=bash
_gh_symphony_completion() {
  local cur prev path
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev=""
  if (( COMP_CWORD > 0 )); then
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
  fi
  path="\${COMP_WORDS[1]}"

  if (( COMP_CWORD == 1 )); then
    COMPREPLY=( $(compgen -W "${quoteWords(TOP_LEVEL_COMMANDS)} ${quoteWords(GLOBAL_OPTIONS)}" -- "$cur") )
    return
  fi

  if [[ "\${path}" == "project" || "\${path}" == "repo" || "\${path}" == "config" ]]; then
    if (( COMP_CWORD >= 2 )); then
      path="\${path}:\${COMP_WORDS[2]}"
    fi
  fi

  case "\${path}" in
${renderBashCasePatterns()}
  esac
}
`;

  if (shell === "zsh") {
    return `autoload -U +X bashcompinit && bashcompinit
${bashFunction}compdef _gh_symphony_completion gh-symphony
`;
  }

  return `${bashFunction}complete -F _gh_symphony_completion gh-symphony
`;
}
