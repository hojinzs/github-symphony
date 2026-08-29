import { describe, expect, it } from "vitest";
import {
  buildCodexDynamicToolsParams,
  buildCodexInitializeParams,
} from "./codex-initialize.js";

describe("buildCodexInitializeParams", () => {
  it("advertises the experimental API when dynamic tools are configured", () => {
    expect(buildCodexInitializeParams([{ name: "github_graphql" }])).toEqual({
      clientInfo: { name: "github-symphony", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
  });

  it("keeps the initialize capabilities empty without dynamic tools", () => {
    expect(buildCodexInitializeParams([])).toEqual({
      clientInfo: { name: "github-symphony", version: "0.1.0" },
      capabilities: {},
    });
  });

  it("includes dynamic tools in thread/start only when configured", () => {
    const dynamicTools = [{ name: "github_graphql" }];

    expect(buildCodexDynamicToolsParams(dynamicTools)).toEqual({
      dynamicTools,
    });
  });

  it("omits dynamicTools from thread/start without dynamic tools", () => {
    expect(buildCodexDynamicToolsParams([])).toEqual({});
  });
});
