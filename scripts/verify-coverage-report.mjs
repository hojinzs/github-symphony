import { readFile } from "node:fs/promises";

const report = JSON.parse(
  await readFile(
    new URL("../coverage/coverage-final.json", import.meta.url),
    "utf8"
  )
);
const frontendEntries = Object.entries(report).filter(([file]) =>
  file.includes("/packages/control-plane/client/src/")
);
const coveredFrontendStatements = frontendEntries.reduce(
  (count, [, coverage]) =>
    count + Object.values(coverage.s).filter((hits) => hits > 0).length,
  0
);

if (frontendEntries.length === 0 || coveredFrontendStatements === 0) {
  console.error("Aggregate coverage contains no covered frontend source.");
  process.exit(1);
}

console.log(
  `Aggregate coverage includes ${frontendEntries.length} frontend files with ${coveredFrontendStatements} covered statements.`
);
