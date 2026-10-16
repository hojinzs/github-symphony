import assert from "node:assert/strict";
import { loadEvidence, verifyReceipt } from "./assert-receipt.mjs";

// Every probe changes a copied evidence artifact and must reach its named check.
export function verifyMutations(original) {
  const mutations = [];
  for (const phase of ["plain", "authenticated", "restart", "outage"]) {
    mutations.push([
      `${phase} durable completion`,
      (e) => {
        e.workers[phase] = "";
      },
    ]);
    if (phase === "outage") continue;
    mutations.push([
      `${phase} received logs`,
      (e) => {
        for (const line of e.logs)
          for (const resource of line.resourceLogs ?? [])
            for (const scope of resource.scopeLogs ?? [])
              scope.logRecords = scope.logRecords?.filter(
                (r) =>
                  !r.attributes?.some(
                    (a) =>
                      a.key === "symphony.run.id" &&
                      a.value.stringValue === e.manifests[phase].runId
                  )
              );
      },
    ]);
    mutations.push([
      `${phase} resource identity`,
      (e) => {
        for (const line of e.logs)
          for (const r of line.resourceLogs ?? [])
            if (
              r.scopeLogs?.some((s) =>
                s.logRecords?.some((record) =>
                  record.attributes?.some(
                    (a) =>
                      a.key === "symphony.run.id" &&
                      a.value.stringValue === e.manifests[phase].runId
                  )
                )
              )
            )
              r.resource.attributes = r.resource.attributes.filter(
                (a) => a.key !== "symphony.project.id"
              );
      },
    ]);
    if (phase !== "plain")
      mutations.push([
        `${phase} process incarnation`,
        (e) => {
          const resources = e.logs.flatMap((line) => line.resourceLogs ?? []);
          const firstId = resources
            .find((r) =>
              r.scopeLogs?.some((s) =>
                s.logRecords?.some((record) =>
                  record.attributes?.some(
                    (a) =>
                      a.key === "symphony.run.id" &&
                      a.value.stringValue === e.manifests.plain.runId
                  )
                )
              )
            )
            .resource.attributes.find((a) => a.key === "service.instance.id")
            .value.stringValue;
          for (const r of resources)
            if (
              r.scopeLogs?.some((s) =>
                s.logRecords?.some((record) =>
                  record.attributes?.some(
                    (a) =>
                      a.key === "symphony.run.id" &&
                      a.value.stringValue === e.manifests[phase].runId
                  )
                )
              )
            )
              r.resource.attributes.find(
                (a) => a.key === "service.instance.id"
              ).value.stringValue = firstId;
        },
      ]);
  }

  // Instrument-specific mutations apply to every resource, so first-phase
  // checks prove gauge/counter semantics independently of receipt presence.
  mutations.push([
    "plain history gauge",
    (e) => {
      for (const l of e.metrics)
        for (const r of l.resourceMetrics ?? [])
          for (const s of r.scopeMetrics ?? [])
            for (const m of s.metrics ?? [])
              if (m.name === "symphony.runtime.total") {
                m.sum = m.gauge;
                delete m.gauge;
              }
    },
  ]);
  mutations.push([
    "plain cumulative counter",
    (e) => {
      for (const l of e.metrics)
        for (const r of l.resourceMetrics ?? [])
          for (const s of r.scopeMetrics ?? [])
            for (const m of s.metrics ?? [])
              if (m.name === "symphony.tick.outcomes")
                m.sum.isMonotonic = false;
    },
  ]);
  mutations.push([
    "stable project across restarts",
    (e) => {
      e.manifests.outage.projectId = "foreign";
    },
  ]);
  mutations.push([
    "outage has no Collector receipt",
    (e) => {
      const resource = structuredClone(
        e.logs.flatMap((l) => l.resourceLogs ?? [])[0]
      );
      const record = resource.scopeLogs
        .flatMap((s) => s.logRecords ?? [])
        .find((r) => r.attributes?.some((a) => a.key === "symphony.run.id"));
      record.attributes.find(
        (a) => a.key === "symphony.run.id"
      ).value.stringValue = e.manifests.outage.runId;
      e.logs.push({ resourceLogs: [resource] });
    },
  ]);
  for (const [marker, mutate] of mutations) {
    const copy = structuredClone(original);
    mutate(copy);
    assert.throws(
      () => verifyReceipt(copy),
      (error) =>
        error.code === "ERR_ASSERTION" && error.message.includes(marker),
      `mutation must fail at ${marker}`
    );
    console.log(`mutation rejected: ${marker}`);
  }
}
if (process.argv[2]) verifyMutations(await loadEvidence(process.argv[2]));
