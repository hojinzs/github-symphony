import type { EventAppendContext } from "./event-export.js";
import type { ProjectMetricProjection } from "./metric-projection.js";
import type { OrchestratorEvent } from "./structured-events.js";

/** Synchronous offers only enqueue bounded work; transport runs off this stack.
 * Optional callbacks default to no-op. Owners contain failures independently
 * of persistence and coordination. No runtime SDK is part of this contract.
 */
export type ObservabilityPublication = {
  offerEvent?: (
    event: Readonly<OrchestratorEvent>,
    context: Readonly<EventAppendContext>
  ) => void;
  offerSnapshot?: (snapshot: CommittedMetricSnapshot) => void;
  observeTick?: (measurement: TickMeasurement) => void;
};

export type CommittedMetricSnapshot = Readonly<{
  projectId: string;
  /** Process-instance identity scopes the strictly increasing commit sequence. */
  instanceId: string;
  sequence: number;
  projection: ProjectMetricProjection;
}>;

export type TickMeasurement = Readonly<{
  durationSeconds: number;
  outcome: "success" | "failure";
}>;
