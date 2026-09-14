import { readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function listTests(cwd) {
  const result = spawnSync("pnpm", ["exec", "vitest", "list", "--filesOnly"], {
    cwd,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^\[[^\]]+\] /, ""))
    .map((file) => relative(repositoryRoot, resolve(cwd, file)))
    .sort();
}

const packageRoot = resolve(repositoryRoot, "packages");
const packageDirectories = [];

for (const entry of await readdir(packageRoot)) {
  const directory = resolve(packageRoot, entry);
  if ((await stat(directory)).isDirectory()) packageDirectories.push(directory);
}

const packageTests = packageDirectories.flatMap(listTests).sort();
const aggregateTests = listTests(repositoryRoot);

const missing = packageTests.filter((file) => !aggregateTests.includes(file));
const extra = aggregateTests.filter((file) => !packageTests.includes(file));

if (missing.length || extra.length) {
  console.error("Aggregate coverage discovery differs from `pnpm test`:");
  for (const file of missing) console.error(`- missing: ${file}`);
  for (const file of extra) console.error(`- extra: ${file}`);
  process.exit(1);
}

console.log(
  `Coverage discovery matches the package gate (${aggregateTests.length} files).`
);
