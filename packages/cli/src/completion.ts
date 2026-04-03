const TOP_LEVEL_COMMANDS = [
  "workflow",
  "setup",
  "doctor",
  "upgrade",
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

const GLOBAL_OPTIONS_WITH_VALUES = ["--config", "--config-dir"] as const;

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  completion: ["bash", "zsh", "fish"],
  workflow: ["init", "validate", "preview"],
  "workflow:init": [
    "--non-interactive",
    "--project",
    "--output",
    "--skip-skills",
    "--skip-context",
    "--dry-run",
    ...GLOBAL_OPTIONS,
  ],
  "workflow:validate": ["--file", ...GLOBAL_OPTIONS],
  "workflow:preview": [
    "--file",
    "--sample",
    "--attempt",
    ...GLOBAL_OPTIONS,
  ],
  setup: [
    "--non-interactive",
    "--project",
    "--workspace-dir",
    "--assigned-only",
    "--output",
    "--skip-skills",
    "--skip-context",
    ...GLOBAL_OPTIONS,
  ],
  doctor: ["--project-id", "--project", ...GLOBAL_OPTIONS],
  upgrade: [...GLOBAL_OPTIONS],
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
          command === "workflow" ||
          command === "project" ||
          command === "repo" ||
          command === "config"
        ) {
          return `    ${command})\n      COMPREPLY=( $(compgen -W "${quoteWords(values)}" -- "$cur") )\n      return\n      ;;`;
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

  for (const subcommand of COMMAND_OPTIONS.workflow ?? []) {
    lines.push(
      `complete -c gh-symphony -f -n '__fish_seen_subcommand_from workflow' -a '${subcommand}'`
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
_gh_symphony_find_context() {
  GH_SYMPHONY_COMMAND=""
  GH_SYMPHONY_SUBCOMMAND=""

  local idx=1
  local token=""
  local expects_value=0

  while (( idx < COMP_CWORD )); do
    token="\${COMP_WORDS[idx]}"

    if (( expects_value )); then
      expects_value=0
      (( idx++ ))
      continue
    fi

    case "\${token}" in
      ${GLOBAL_OPTIONS_WITH_VALUES.map((option) => `${option}`).join("|")})
        expects_value=1
        ;;
      ${GLOBAL_OPTIONS_WITH_VALUES.map((option) => `${option}=*`).join("|")})
        ;;
      ${GLOBAL_OPTIONS.filter((option) => !GLOBAL_OPTIONS_WITH_VALUES.includes(option as "--config" | "--config-dir")).join("|")})
        ;;
      -*)
        ;;
      *)
        if [[ -z "\${GH_SYMPHONY_COMMAND}" ]]; then
          GH_SYMPHONY_COMMAND="\${token}"
        elif [[ -z "\${GH_SYMPHONY_SUBCOMMAND}" ]]; then
          GH_SYMPHONY_SUBCOMMAND="\${token}"
        fi
        ;;
    esac

    (( idx++ ))
  done
}

_gh_symphony_completion() {
  local cur prev path
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev=""
  if (( COMP_CWORD > 0 )); then
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
  fi

  _gh_symphony_find_context
  path="\${GH_SYMPHONY_COMMAND}"

  if [[ -z "\${path}" ]]; then
    COMPREPLY=( $(compgen -W "${quoteWords(TOP_LEVEL_COMMANDS)} ${quoteWords(GLOBAL_OPTIONS)}" -- "$cur") )
    return
  fi

  if [[ "\${path}" == "workflow" || "\${path}" == "project" || "\${path}" == "repo" || "\${path}" == "config" || "\${path}" == "completion" ]]; then
    if [[ -n "\${GH_SYMPHONY_SUBCOMMAND}" ]]; then
      path="\${path}:\${GH_SYMPHONY_SUBCOMMAND}"
    fi
  fi

  case "\${path}" in
${renderBashCasePatterns()}
  esac
}
`;

  if (shell === "zsh") {
    return `autoload -Uz compinit && compinit
autoload -U +X bashcompinit && bashcompinit
${bashFunction}complete -F _gh_symphony_completion gh-symphony
`;
  }

  return `${bashFunction}complete -F _gh_symphony_completion gh-symphony
`;
}
