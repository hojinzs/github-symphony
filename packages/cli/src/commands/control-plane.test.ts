import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "../index.js";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});
it("advertises the fleet foreground command in root and namespace help", async () => {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  await runCli(["--help"]);
  expect(output).toContain("control-plane run");
  output = "";
  await runCli(["help", "control-plane"]);
  expect(output).toContain("run");
  expect(output).toContain("fleet");
  output = "";
  await runCli(["control-plane", "run", "--help"]);
  expect(output).toContain("--config <file>");
});
it("requires the fleet file and forwards it to fleet validation", async () => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await runCli(["control-plane", "run"]);
  expect(process.exitCode).toBe(1);
  process.exitCode = undefined;
  await expect(
    runCli(["control-plane", "run", "--config", "/nonexistent/fleet-test.yaml"])
  ).rejects.toThrow(/Fleet config .*fleet-test.yaml/);
  expect(process.env.GH_SYMPHONY_CONFIG_DIR).not.toBe(
    "/nonexistent/fleet-test.yaml"
  );
});
