import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readJournal } from "./json-journal.mjs";

test("polling tolerates missing and truncated journals then observes recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "c11-journal-"));
  const path = join(directory, "journal.json");
  try {
    assert.deepEqual(await readJournal(path), {});
    await writeFile(path, '{"commandId":"partial');
    assert.deepEqual(await readJournal(path), {});
    await writeFile(path, '{"state":"executing"}');
    assert.deepEqual(await readJournal(path), { state: "executing" });
    await writeFile(path, "");
    assert.deepEqual(await readJournal(path), {});
    await writeFile(path, '{"state":"succeeded"}');
    assert.deepEqual(await readJournal(path), { state: "succeeded" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
