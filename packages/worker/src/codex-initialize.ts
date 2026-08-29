export function buildCodexInitializeParams(dynamicTools: readonly unknown[]): {
  clientInfo: { name: string; version: string };
  capabilities: { experimentalApi?: true };
} {
  return {
    clientInfo: { name: "github-symphony", version: "0.1.0" },
    capabilities: dynamicTools.length > 0 ? { experimentalApi: true } : {},
  };
}
