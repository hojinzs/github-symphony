import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderCompletionScript } from "./completion.js";

function runBashCompletion(words: string[], cword: number): string[] {
  const script = renderCompletionScript("bash");
  const wordsLiteral = words.map((word) => JSON.stringify(word)).join(" ");
  const result = spawnSync(
    "bash",
    [
      "-lc",
      `${script}
COMP_WORDS=(${wordsLiteral})
COMP_CWORD=${cword}
COMPREPLY=()
_gh_symphony_completion
printf '%s\n' "\${COMPREPLY[@]}"
`,
    ],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || "bash completion execution failed");
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe("completion renderer", () => {
  it("renders bash completion with top-level commands", () => {
    const output = renderCompletionScript("bash");
    expect(output).toContain("complete -F _gh_symphony_completion gh-symphony");
    expect(output).toContain("workflow setup doctor upgrade");
    expect(output).not.toContain("upgrade start stop status");
    expect(output).toContain("workflow:init");
    expect(output).toContain("project config completion");
    expect(output).toContain("setup)");
    expect(output).toContain("project:start");
    expect(output).not.toContain("repo:init");
  });

  it("renders zsh completion wrapper", () => {
    const output = renderCompletionScript("zsh");
    expect(output).toContain("autoload -Uz compinit && compinit");
    expect(output).toContain("bashcompinit");
    expect(output).toContain("complete -F _gh_symphony_completion gh-symphony");
  });

  it("renders fish completion commands", () => {
    const output = renderCompletionScript("fish");
    expect(output).toContain("complete -c gh-symphony -f -l config");
    expect(output).toContain("complete -c gh-symphony -f -s v");
    expect(output).toContain("__fish_seen_subcommand_from workflow");
    expect(output).toContain("__fish_seen_subcommand_from project");
    expect(output).toContain("__fish_seen_subcommand_from completion");
  });

  it("suggests workflow subcommands when completing the second token", () => {
    const suggestions = runBashCompletion(["gh-symphony", "workflow", ""], 2);
    expect(suggestions).toEqual(
      expect.arrayContaining(["init", "validate", "preview"])
    );
  });

  it("suggests project subcommands when completing the second token", () => {
    const suggestions = runBashCompletion(["gh-symphony", "project", ""], 2);
    expect(suggestions).toEqual(
      expect.arrayContaining(["list", "start", "status", "stop"])
    );
  });

  it("skips leading global options before resolving subcommand completion", () => {
    const suggestions = runBashCompletion(
      ["gh-symphony", "--json", "project", ""],
      3
    );
    expect(suggestions).toEqual(
      expect.arrayContaining(["list", "start", "status", "stop"])
    );
  });

  it("suggests standalone project start flags", () => {
    const suggestions = runBashCompletion(
      ["gh-symphony", "project", "start", ""],
      3
    );
    expect(suggestions).toEqual(
      expect.arrayContaining(["--project-dir", "--daemon", "--once"])
    );
  });

  it("suggests doctor smoke flags", () => {
    const suggestions = runBashCompletion(["gh-symphony", "doctor", ""], 2);
    expect(suggestions).toEqual(
      expect.arrayContaining(["--smoke", "--issue", "--fix", "--json"])
    );
  });
});

it("reaches agent setup, enroll and nested service/project completion", () => {
  for (const verb of ["setup", "enroll"]) {
    expect(runBashCompletion(["gh-symphony", "agent", verb, ""], 3)).toEqual(
      expect.arrayContaining(["--server", "--token-stdin", "--agent-config"])
    );
  }
  for (const [group, verb] of [
    ["service", "restart"],
    ["project", "remove"],
  ]) {
    expect(
      runBashCompletion(["gh-symphony", "agent", group!, ""], 3)
    ).toContain(verb);
    expect(
      runBashCompletion(["gh-symphony", "agent", group!, verb!, ""], 4)
    ).toContain("--agent-config");
  }
});

it("renders fish agent subcommands and scoped nested flags", () => {
  const output = renderCompletionScript("fish");
  expect(output).not.toContain("__fish_seen_subcommand_from project' -a");
  expect(output).toContain(
    "__fish_seen_subcommand_from agent; and not __fish_seen_subcommand_from setup enroll run service project"
  );
  expect(output).toContain("-a 'setup'");
  expect(output).toContain(
    "__fish_seen_subcommand_from agent; and __fish_seen_subcommand_from service; and not __fish_seen_subcommand_from install start stop restart status uninstall"
  );
  expect(output).toContain(
    "__fish_seen_subcommand_from agent; and __fish_seen_subcommand_from project; and __fish_seen_subcommand_from remove' -l agent-config"
  );
  expect(output).toContain(
    "__fish_seen_subcommand_from agent; and __fish_seen_subcommand_from enroll' -l token-stdin"
  );
});
