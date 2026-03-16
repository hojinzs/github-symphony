import { describe, expect, it } from "vitest";
import { renderCompletionScript } from "./completion.js";

describe("completion renderer", () => {
  it("renders bash completion with top-level commands", () => {
    const output = renderCompletionScript("bash");
    expect(output).toContain("complete -F _gh_symphony_completion gh-symphony");
    expect(output).toContain("project repo config completion");
    expect(output).toContain("project:add");
  });

  it("renders zsh completion wrapper", () => {
    const output = renderCompletionScript("zsh");
    expect(output).toContain("bashcompinit");
    expect(output).toContain("compdef _gh_symphony_completion gh-symphony");
  });

  it("renders fish completion commands", () => {
    const output = renderCompletionScript("fish");
    expect(output).toContain("complete -c gh-symphony -f -l config");
    expect(output).toContain("complete -c gh-symphony -f -s v");
    expect(output).toContain("__fish_seen_subcommand_from project");
    expect(output).toContain("__fish_seen_subcommand_from completion");
  });
});
