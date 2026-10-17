import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Keep the repo-level evidence verifier in pnpm test through this package's Vitest suite.
it("rejects corrupted OT-14 Collector evidence at each named assertion", () => {
  const output = execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../../e2e/otlp/receipt-self-test.mjs", import.meta.url)
      ),
    ],
    { encoding: "utf8" }
  );
  expect(output).toContain(
    "mutation rejected: outage has no Collector receipt"
  );
  expect(output.match(/mutation rejected:/g)).toHaveLength(17);
});
