import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// The shared bare-clone cache falls back to the operator's real ~/.gh-symphony
// directory. A test that populates a workspace without pinning its own config
// directory would leave a cache entry keyed by the fixture's owner/name behind,
// which later runs then reuse with a dead origin. Sandbox the default here so
// no test file can reach the developer's home directory.
const sandbox = mkdtempSync(join(tmpdir(), "orchestrator-config-"));
process.env.GH_SYMPHONY_CONFIG_DIR ??= sandbox;

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
