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
    expect(output).toContain("workflow:init");
    expect(output).toContain("project repo config completion");
    expect(output).toContain("setup)");
    expect(output).toContain("project:add");
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
      expect.arrayContaining(["add", "list", "remove", "start", "stop", "status"])
    );
  });

  it("skips leading global options before resolving subcommand completion", () => {
    const suggestions = runBashCompletion(
      ["gh-symphony", "--json", "repo", ""],
      3
    );
    expect(suggestions).toEqual(
      expect.arrayContaining(["list", "add", "remove"])
    );
  });
});
