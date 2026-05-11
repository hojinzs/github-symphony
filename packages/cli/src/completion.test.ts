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
    expect(output).toContain("repo config completion");
    expect(output).toContain("setup)");
    expect(output).toContain("repo:init");
    expect(output).toContain("repo:explain");
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
    expect(output).toContain("__fish_seen_subcommand_from repo");
    expect(output).toContain("__fish_seen_subcommand_from completion");
  });

  it("suggests workflow subcommands when completing the second token", () => {
    const suggestions = runBashCompletion(["gh-symphony", "workflow", ""], 2);
    expect(suggestions).toEqual(
      expect.arrayContaining(["init", "validate", "preview"])
    );
  });

  it("suggests repo subcommands when completing the second token", () => {
    const suggestions = runBashCompletion(["gh-symphony", "repo", ""], 2);
    expect(suggestions).toEqual(
      expect.arrayContaining([
        "init",
        "start",
        "status",
        "stop",
        "run",
        "recover",
        "logs",
        "explain",
      ])
    );
  });

  it("skips leading global options before resolving subcommand completion", () => {
    const suggestions = runBashCompletion(
      ["gh-symphony", "--json", "repo", ""],
      3
    );
    expect(suggestions).toEqual(
      expect.arrayContaining(["init", "start", "status", "run", "logs"])
    );
  });

  it("does not suggest removed repo sync flags", () => {
    const suggestions = runBashCompletion(
      ["gh-symphony", "repo", "sync", ""],
      3
    );
    expect(suggestions).not.toEqual(expect.arrayContaining(["--dry-run"]));
    expect(suggestions).not.toEqual(expect.arrayContaining(["--prune"]));
    expect(suggestions).toEqual([]);
  });

  it("suggests doctor smoke flags", () => {
    const suggestions = runBashCompletion(["gh-symphony", "doctor", ""], 2);
    expect(suggestions).toEqual(
      expect.arrayContaining(["--smoke", "--issue", "--fix", "--json"])
    );
  });
});
