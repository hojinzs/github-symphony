import { closeSync, openSync, unlinkSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { afterAll, beforeAll, test } from "vitest";

const lockPath = process.env.VITEST_SERIALIZATION_PROBE_LOCK;
let lock: number | undefined;

beforeAll(async () => {
  if (!lockPath) throw new Error("VITEST_SERIALIZATION_PROBE_LOCK is required");
  lock = openSync(lockPath, "wx");
  await setTimeout(1_000);
});

afterAll(() => {
  if (lock !== undefined) closeSync(lock);
  if (lockPath && lock !== undefined) unlinkSync(lockPath);
});

test("holds the shared serialization probe lock", () => {});
