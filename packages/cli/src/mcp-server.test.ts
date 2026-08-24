import { describe, expect, it } from "vitest";
import { parseBuiltInMcpServer } from "./mcp-server.js";

describe("parseBuiltInMcpServer", () => {
  it.each([
    [["--server", "github"], "github"],
    [["--server", "linear"], "linear"],
    [["--server=github"], "github"],
    [["--server=linear"], "linear"],
  ] as const)("selects %s", (args, expected) => {
    expect(parseBuiltInMcpServer([...args])).toBe(expected);
  });

  it("rejects missing and unsupported server selections", () => {
    expect(() => parseBuiltInMcpServer([])).toThrow(
      "Expected --server <github|linear>"
    );
    expect(() => parseBuiltInMcpServer(["--server", "other"])).toThrow(
      "received other"
    );
  });
});
