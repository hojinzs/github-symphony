import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadAgentConfig } from "./agent-config.js";
import { runAgentRuntime } from "./agent-runtime.js";

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      "data-dir": { type: "string" },
      "native-service": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.config) throw new Error("Native agent entry requires --config");
  const config = await loadAgentConfig(resolve(values.config));
  if (
    values["data-dir"] &&
    resolve(values["data-dir"]) !== config.dataDirectory
  )
    throw new Error(
      "Native service data directory does not match local config"
    );
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error("Unsupported native agent platform");
  if (process.platform === "linux" && values["native-service"] !== "linux")
    throw new Error("Linux agent requires explicit native-service isolation");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await runAgentRuntime(config, {
      signal: controller.signal,
      nativeService: process.platform,
      report: (state, code) =>
        process.stdout.write(JSON.stringify({ state, code }) + "\n"),
    });
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
main().catch(() => {
  // Native logs never echo parser input, credentials or remote error bodies.
  process.stderr.write(
    "Agent startup failed. Check private host config, enrollment and the shared owner lock; use agent service status or foreground agent run for diagnosis.\n"
  );
  process.exitCode = 1;
});
