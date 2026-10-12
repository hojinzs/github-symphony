import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "./index.js";

const { doctor } = vi.hoisted(() => ({ doctor: vi.fn(async () => {}) }));
vi.mock("./commands/doctor.js", () => ({ default: doctor }));

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

it("accepts and forwards the public doctor OTLP probe flag", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await runCli(["doctor", "--otlp-probe", "--json"]);
  expect(doctor).toHaveBeenCalledWith(
    ["--otlp-probe"],
    expect.objectContaining({ json: true })
  );
});
