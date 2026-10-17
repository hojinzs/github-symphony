// Synthetic Collector JSON validates the evidence reader only. This is never
// evidence of Collector acceptance; only the Docker runner supplies that.
import { verifyReceipt } from "./assert-receipt.mjs";
import { verifyMutations } from "./receipt-mutations.mjs";
const evidence = {
  logs: [],
  metrics: [],
  manifests: {},
  events: {},
  workers: {},
  outageDiagnostics: [
    { event: "otlp-diagnostic", category: "transport", state: "failure" },
  ],
};
const attr = (key, stringValue) => ({ key, value: { stringValue } });
for (const [index, phase] of [
  "plain",
  "authenticated",
  "restart",
  "outage",
].entries()) {
  const runId = `run-${phase}`;
  evidence.manifests[phase] = {
    runId,
    projectId: "same-project",
    shutdown: { code: 0 },
  };
  evidence.events[phase] = [
    { event: "tracker.state", runId, confirmedState: "Done" },
  ];
  evidence.workers[phase] = "[stub-worker] status=completed";
  if (phase === "outage") continue;
  const resource = {
    attributes: [
      attr("symphony.project.id", "same-project"),
      attr("symphony.tracker.kind", "file"),
      attr(
        "service.instance.id",
        `00000000-0000-0000-0000-00000000000${index}`
      ),
    ],
  };
  evidence.logs.push({
    resourceLogs: [
      {
        resource,
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "123",
                attributes: [attr("symphony.run.id", runId)],
              },
            ],
          },
        ],
      },
    ],
  });
  evidence.metrics.push({
    resourceMetrics: [
      {
        resource,
        scopeMetrics: [
          {
            metrics: [
              {
                name: "symphony.runtime.total",
                gauge: { dataPoints: [{ asDouble: 1 }] },
              },
              {
                name: "symphony.tick.outcomes",
                sum: {
                  isMonotonic: true,
                  aggregationTemporality: 2,
                  dataPoints: [
                    {
                      timeUnixNano: "123",
                      startTimeUnixNano: "100",
                      asInt: "1",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}
verifyReceipt(evidence);
verifyMutations(evidence);
