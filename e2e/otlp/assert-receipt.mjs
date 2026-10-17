import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const attrs = (values = []) =>
  Object.fromEntries(
    values.map(({ key, value }) => [
      key,
      value.stringValue ?? value.intValue ?? value.boolValue,
    ])
  );
export function verifyReceipt({
  logs,
  metrics,
  manifests,
  events,
  workers,
  outageDiagnostics,
}) {
  const check = (name, predicate) => {
    console.log(`reached: ${name}`);
    assert.ok(predicate, name);
  };
  const logResources = logs.flatMap((line) => line.resourceLogs ?? []);
  const metricResources = metrics.flatMap((line) => line.resourceMetrics ?? []);
  const incarnations = new Set();
  for (const phase of ["plain", "authenticated", "restart", "outage"]) {
    const manifest = manifests[phase];
    check(
      `${phase} durable completion`,
      manifest?.shutdown?.code === 0 &&
        workers[phase]?.includes("[stub-worker] status=completed") &&
        events[phase]?.some(
          (event) =>
            event.event === "tracker.state" &&
            event.runId === manifest.runId &&
            event.confirmedState === "Done"
        )
    );
    if (phase === "outage") continue;
    const received = logResources.filter((resource) =>
      resource.scopeLogs?.some((scope) =>
        scope.logRecords?.some(
          (record) =>
            attrs(record.attributes)["symphony.run.id"] === manifest.runId &&
            BigInt(record.timeUnixNano ?? 0) > 0n
        )
      )
    );
    check(`${phase} received logs`, received.length > 0);
    const identities = received.map((resource) =>
      attrs(resource.resource?.attributes)
    );
    check(
      `${phase} resource identity`,
      identities.every(
        (identity) =>
          identity["symphony.project.id"] === manifest.projectId &&
          identity["symphony.tracker.kind"] === "file" &&
          /^[0-9a-f-]{36}$/.test(identity["service.instance.id"])
      )
    );
    const ids = new Set(
      identities.map((identity) => identity["service.instance.id"])
    );
    check(
      `${phase} process incarnation`,
      ids.size === 1 && !incarnations.has([...ids][0])
    );
    incarnations.add([...ids][0]);
    const receivedMetrics = metricResources
      .filter((resource) =>
        ids.has(attrs(resource.resource?.attributes)["service.instance.id"])
      )
      .flatMap(
        (resource) =>
          resource.scopeMetrics?.flatMap((scope) => scope.metrics ?? []) ?? []
      );
    const gauges = receivedMetrics.filter(
      (metric) => metric.name === "symphony.runtime.total"
    );
    check(
      `${phase} history gauge`,
      gauges.length > 0 &&
        gauges.every(
          (metric) => metric.gauge?.dataPoints?.length > 0 && !metric.sum
        )
    );
    const counters = receivedMetrics.filter(
      (metric) => metric.name === "symphony.tick.outcomes"
    );
    check(
      `${phase} cumulative counter`,
      counters.length > 0 &&
        counters.every(
          (metric) =>
            metric.sum?.isMonotonic === true &&
            metric.sum.aggregationTemporality === 2 &&
            metric.sum.dataPoints?.some(
              (point) =>
                BigInt(point.timeUnixNano ?? 0) >=
                  BigInt(point.startTimeUnixNano ?? 0) &&
                Number(point.asInt ?? point.asDouble) > 0
            )
        )
    );
  }
  check(
    "stable project across restarts",
    new Set(Object.values(manifests).map((manifest) => manifest.projectId))
      .size === 1
  );
  check(
    "outage export attempted",
    outageDiagnostics.some(
      (record) =>
        record.event === "otlp-diagnostic" &&
        record.category === "transport" &&
        record.state === "failure"
    )
  );
  const outageId = manifests.outage.runId;
  check(
    "outage has no Collector receipt",
    !logResources.some((resource) =>
      resource.scopeLogs?.some((scope) =>
        scope.logRecords?.some(
          (record) => attrs(record.attributes)["symphony.run.id"] === outageId
        )
      )
    )
  );
}
export async function loadEvidence(root) {
  const jsonLines = async (path) =>
    (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const evidence = {
    logs: await jsonLines(join(root, "logs.jsonl")),
    metrics: await jsonLines(join(root, "metrics.jsonl")),
    manifests: {},
    events: {},
    workers: {},
    outageDiagnostics: (await readFile(join(root, "outage/cli.log"), "utf8"))
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      }),
  };
  for (const phase of ["plain", "authenticated", "restart", "outage"]) {
    evidence.manifests[phase] = JSON.parse(
      await readFile(join(root, phase, "manifest.json"), "utf8")
    );
    evidence.events[phase] = await jsonLines(
      join(root, phase, "run/events.ndjson")
    );
    evidence.workers[phase] = await readFile(
      join(root, phase, "run/worker.log"),
      "utf8"
    );
  }
  return evidence;
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyReceipt(await loadEvidence(process.argv[2]));
  console.log("OT-14 attributable Collector receipt assertions passed");
}
