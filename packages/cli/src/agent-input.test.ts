import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { readEnrollmentToken } from "./agent-input.js";

it("reads one bounded stdin token without echo and rejects empty or multiline input", async () => {
  for (const [input, valid] of [
    ["fixture-secret\n", true],
    ["", false],
    ["a\nb\n", false],
    ["x".repeat(4097), false],
  ] as const) {
    const stream = new PassThrough();
    const output = new PassThrough();
    let echoed = "";
    output.on("data", (chunk) => {
      echoed += String(chunk);
    });
    const promise = readEnrollmentToken(true, stream, output);
    stream.end(input);
    if (valid) expect(await promise).toBe("fixture-secret");
    else await expect(promise).rejects.toThrow(/token|input/i);
    expect(echoed).toBe("");
  }
});
it("hides interactive token entry and restores raw mode on success and cancellation", async () => {
  for (const cancel of [false, true]) {
    const stream = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(raw: boolean) {
        this.isRaw = raw;
        return this;
      },
    });
    const output = new PassThrough();
    let echoed = "";
    output.on("data", (chunk) => {
      echoed += String(chunk);
    });
    const promise = readEnrollmentToken(false, stream, output);
    stream.write(cancel ? "fixture-secret\u0003" : "fixture-secreX\u007ft\r");
    if (cancel) await expect(promise).rejects.toThrow(/cancel/i);
    else expect(await promise).toBe("fixture-secret");
    expect(echoed).not.toContain("fixture");
    expect(stream.isRaw).toBe(false);
    expect(stream.listenerCount("data")).toBe(0);
    expect(stream.isPaused()).toBe(true);
  }
  await expect(
    readEnrollmentToken(false, new PassThrough(), new PassThrough())
  ).rejects.toThrow("--token-stdin");
});
