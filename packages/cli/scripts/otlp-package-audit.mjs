import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performanceGates } from "./otlp-performance-gates.mjs";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir, platform, release, arch } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

// Run from packages/cli after build. Baseline is a separately built pre-SDK
// tarball, never a workspace-linked package. Reports are written outside source.
assert.ok(
  process.argv[2] && process.argv[3] && process.argv[4] && process.argv[5],
  "Usage: node scripts/otlp-package-audit.mjs <baseline.tgz> <external-report.json> <baseline-source-dir> <baseline-sha>"
);
const baselineTarball = resolve(process.argv[2]);
const reportPath = resolve(process.argv[3]);
const root = await realpath(await mkdtemp(join(tmpdir(), "otlp-i-audit-")));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("SYMPHONY_") &&
      !key.startsWith("OTEL_") &&
      key !== "NODE_PATH" &&
      key !== "NODE_OPTIONS" &&
      key !== "WORKING_DIRECTORY"
  )
);
env.NO_COLOR = "1";
env.GH_SYMPHONY_HTTP_TOKEN = "audit-http-token";
env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:1";
const reached = (name) => console.log(`reached: ${name}`);
function run(command, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env, cwd: root, ...options });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      command === "npm" ? 120000 : 20000
    );
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code, signal, stdout, stderr });
    });
  });
}
async function checked(command, args, options) {
  const result = await run(command, args, options);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout;
}
async function bytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await bytes(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}
const percentile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
async function install(tarball, name) {
  const directory = join(root, name);
  await mkdir(directory);
  await writeFile(join(directory, "package.json"), '{"private":true}');
  await checked(
    "npm",
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { cwd: directory }
  );
  const dist = join(directory, "node_modules/@gh-symphony/cli/dist");
  return {
    directory,
    dist,
    entry: join(dist, "index.js"),
    tarballBytes: (await stat(tarball)).size,
    installedBytes: await bytes(join(directory, "node_modules")),
    esmBytes: (
      await Promise.all(
        (await readdir(dist))
          .filter((n) => n.endsWith(".js"))
          .map(async (n) => (await stat(join(dist, n))).size)
      )
    ).reduce((a, b) => a + b, 0),
    dependencyCount:
      Object.keys(
        JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"))
          .packages
      ).length - 1,
  };
}
const server = createServer((request, response) => {
  requests++;
  request.resume();
  response.writeHead(200);
  response.end();
});
let requests = 0;
await new Promise((resolveListen) =>
  server.listen(0, "127.0.0.1", resolveListen)
);
const endpoint = `http://127.0.0.1:${server.address().port}`;
const project = join(root, "project");
await mkdir(join(project, "hooks"), { recursive: true });
await writeFile(join(project, "hooks/after_create.sh"), "#!/bin/sh\nexit 0\n", {
  mode: 0o755,
});
await writeFile(join(root, "issues.json"), "[]");
await writeFile(join(project, ".env"), "AUDIT_AUTH=Bearer audit-secret\n", {
  mode: 0o600,
});
await checked("git", ["init", project]);
async function workflow(policy = "enabled: false") {
  await writeFile(
    join(project, "WORKFLOW.md"),
    `---\ntracker:\n  kind: file\n  provider:\n    project_slug: audit/repo\n    path: ${join(root, "issues.json")}\npolling:\n  interval_ms: 100\nhooks:\n  after_create: hooks/after_create.sh\nrepository:\n  slug: audit/repo\n  clone_url: file://${project}\nworkspace:\n  root: ${join(project, "work")}\nobservability:\n  otlp:\n    ${policy}\n    endpoint: ${endpoint}\n    headers:\n      Authorization: $AUDIT_AUTH\n---\nAudit.\n`
  );
}
const observer = join(root, "observer.mjs");
await writeFile(
  observer,
  'process.on("exit",()=>process.stderr.write("\\nAUDIT_RSS="+process.memoryUsage().rss+"\\n"));'
);
const loader = join(root, "loader.mjs");
await writeFile(
  loader,
  `import {appendFileSync} from "node:fs"; export async function load(url,context,next){const result=await next(url,context);appendFileSync(process.env.AUDIT_MODULES,url+"\\n");if(url.includes("@opentelemetry")||String(result.source??"").includes("@opentelemetry+"))throw Error("FORBIDDEN_SDK_EVALUATION");return result;}`
);
let report;
try {
  const pack = JSON.parse(
    await checked("npm", ["pack", "--json", "--pack-destination", root], {
      cwd: process.cwd(),
    })
  )[0];
  const baseline = await install(baselineTarball, "baseline");
  const candidate = await install(join(root, pack.filename), "candidate");
  await workflow();
  const measurements = {};
  // Alternate the two builds, same Node/OS/config/disk state, fresh process each.
  for (let index = 0; index < 30; index++) {
    for (const [name, build] of Object.entries({ baseline, candidate })) {
      const started = performance.now();
      const result = await run(process.execPath, [
        "--import",
        pathToFileURL(observer).href,
        build.entry,
        "--config",
        join(root, `config-${name}`),
        "project",
        "start",
        "--once",
        "--project-dir",
        project,
      ]);
      assert.equal(result.code, 0, result.stderr + result.stdout);
      const rss = Number(result.stderr.match(/AUDIT_RSS=(\d+)/)?.[1]);
      assert.ok(rss > 0);
      const sample = (measurements[name] ??= { startupMs: [], rssBytes: [] });
      sample.startupMs.push(performance.now() - started);
      sample.rssBytes.push(rss);
    }
  }
  reached("30 fresh-process disabled startup samples");
  const modules = join(root, "modules.txt");
  await checked(
    process.execPath,
    [
      "--experimental-loader",
      pathToFileURL(loader).href,
      candidate.entry,
      "--config",
      join(root, "config-candidate"),
      "project",
      "start",
      "--once",
      "--project-dir",
      project,
    ],
    { env: { ...env, AUDIT_MODULES: modules } }
  );
  assert.equal(requests, 0, "Disabled startup connected to receiver");
  for (const [policy, veto] of [
    ["", false],
    ["enabled: false", false],
    ["enabled: true", true],
  ]) {
    await workflow(policy);
    await checked(
      process.execPath,
      [
        "--experimental-loader",
        pathToFileURL(loader).href,
        candidate.entry,
        "--config",
        join(root, "config-candidate"),
        "project",
        "start",
        "--once",
        "--project-dir",
        project,
      ],
      {
        env: {
          ...env,
          AUDIT_MODULES: modules,
          ...(veto ? { OTEL_SDK_DISABLED: "true" } : {}),
        },
      }
    );
    assert.equal(requests, 0);
  }
  reached("disabled project SDK evaluation boundary");
  for (const policy of ["enabled: false", "enabled: true"]) {
    await workflow(policy);
    const before = requests;
    const doctor = await run(process.execPath, [
      candidate.entry,
      "--config",
      join(root, "config-candidate"),
      "--json",
      "doctor",
      ...(policy === "enabled: false" ? ["--otlp-probe"] : []),
      "--project-dir",
      project,
    ]);
    assert.ok([0, 1].includes(doctor.code), doctor.stderr);
    const otlp = JSON.parse(doctor.stdout).checks.find(
      (check) => check.id === "otlp"
    );
    assert.equal(otlp?.status, "pass", doctor.stdout);
    assert.equal(
      otlp.details.configuration.enabled,
      policy === "enabled: true"
    );
    assert.equal(requests, before);
    assert.equal(
      (doctor.stdout + doctor.stderr).includes("audit-secret"),
      false
    );
  }
  reached("disabled and validation-only doctor no connection");
  await workflow("enabled: true");
  const probe = await run(process.execPath, [
    candidate.entry,
    "--config",
    join(root, "config-candidate"),
    "--json",
    "doctor",
    "--otlp-probe",
    "--project-dir",
    project,
  ]);
  assert.ok([0, 1].includes(probe.code), probe.stderr);
  assert.ok(requests >= 2, probe.stdout + probe.stderr);
  assert.equal((probe.stdout + probe.stderr).includes("audit-secret"), false);
  reached("explicit doctor probes both signals");
  const files = await readdir(candidate.dist);
  const findExport = async (name) => {
    for (const file of files.filter(
      (n) => n.startsWith("chunk-") && n.endsWith(".js")
    )) {
      const source = await readFile(join(candidate.dist, file), "utf8");
      if (
        source.includes(`function ${name}(`) ||
        source.includes(`class ${name} `)
      ) {
        const module = await import(
          pathToFileURL(join(candidate.dist, file)).href
        );
        if (module[name]) return module[name];
      }
    }
    throw Error(`Missing bundled export ${name}`);
  };
  const resolveOtlpConfiguration = await findExport("resolveOtlpConfiguration");
  const { createProjectPipeline } = await import(
    pathToFileURL(
      join(
        candidate.dist,
        files.find((n) => n.startsWith("pipeline-"))
      )
    ).href
  );
  const config = resolveOtlpConfiguration(
    {
      enabled: true,
      endpoint,
      resourceAttributes: {},
      referenceNames: [],
      authReferenceNames: [],
    },
    {}
  );
  const offer = {};
  for (const mode of ["healthy", "slow", "down"]) {
    let transportCalls = 0;
    const request = async (_destination, _body, signal) => {
      transportCalls++;
      if (mode === "down") throw Error("offline");
      if (mode === "slow")
        await new Promise((resolveWait, reject) => {
          const timer = setTimeout(resolveWait, 100);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(Error("aborted"));
            },
            { once: true }
          );
        });
      return { status: 200, retryAfter: null, body: new Uint8Array() };
    };
    const pipeline = createProjectPipeline(
      {
        version: "audit",
        projectId: "p",
        projectSlug: "audit/repo",
        trackerKind: "file",
      },
      config,
      {
        logs: { request, diagnostic: () => {} },
        metrics: { request, diagnostic: () => {} },
      }
    );
    const times = [];
    for (let index = 0; index < 1000; index++) {
      const at = new Date().toISOString();
      const start = performance.now();
      pipeline.offerEvent(
        { at, event: "run-failed", runId: "r", error: "safe" },
        { observedAt: at, runId: "r" }
      );
      pipeline.observeTick({ durationSeconds: 0.001, outcome: "success" });
      times.push(performance.now() - start);
      if (index % 100 === 0)
        await new Promise((resolveYield) => setImmediate(resolveYield));
    }
    offer[mode] = { samples: times.length, p95Ms: percentile(times, 0.95) };
    await pipeline.shutdown(Date.now() + 5000);
    assert.ok(transportCalls > 0, `${mode} receiver was never exercised`);
  }
  reached("healthy slow down synchronous offer measurement");
  const summarize = (build, values) => ({
    tarballBytes: build.tarballBytes,
    installedBytes: build.installedBytes,
    esmBytes: build.esmBytes,
    dependencyCount: build.dependencyCount,
    startupMedianMs: percentile(values.startupMs, 0.5),
    startupP95Ms: percentile(values.startupMs, 0.95),
    rssMedianBytes: percentile(values.rssBytes, 0.5),
  });
  const base = summarize(baseline, measurements.baseline),
    current = summarize(candidate, measurements.candidate);
  const gates = performanceGates(base, current, offer);
  report = {
    baselineTarball,
    baselineCommit: process.argv[5],
    baselineTarballSha256: createHash("sha256")
      .update(await readFile(baselineTarball))
      .digest("hex"),
    lockfileBytes: {
      baseline: (await stat(join(resolve(process.argv[4]), "pnpm-lock.yaml")))
        .size,
      candidate: (await stat(resolve("../../pnpm-lock.yaml"))).size,
    },
    node: process.version,
    os: `${platform()} ${release()} ${arch()}`,
    conditions:
      "fresh processes, alternating 30 samples, same empty file-tracker project, warm filesystem, npm --omit=dev --ignore-scripts",
    baseline: base,
    candidate: current,
    measurements,
    offer,
    gates,
    disabledLoadedModules: (await readFile(modules, "utf8")).trim().split("\n"),
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify(
      { baseline: base, candidate: current, offer, gates },
      null,
      2
    )
  );
  assert.ok(
    Object.values(gates).every(Boolean),
    "Performance gate failed; production activation must remain off"
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(root, { recursive: true, force: true });
}
