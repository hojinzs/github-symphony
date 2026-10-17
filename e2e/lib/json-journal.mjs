import { readFile } from "node:fs/promises";

// Fixture writes can be observed between truncate and completion. Retry on the
// next poll when the journal is missing or incomplete.
export async function readJournal(path) {
  return readFile(path, "utf8")
    .then(JSON.parse)
    .catch(() => ({}));
}
