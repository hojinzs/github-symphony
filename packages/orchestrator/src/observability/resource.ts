import { randomUUID } from "node:crypto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { resolveProjectResourceAttributes } from "./resource-validation.js";

export type ProjectResourceIdentity = {
  version: string;
  /** Shared across the two providers belonging to one project startup. */
  instanceId?: string;
  projectId: string;
  projectSlug: string;
  trackerKind: string;
  attributes?: Record<string, string | number | boolean>;
};

/** Explicit resource ownership shared by injected signal providers. */
export function createProjectResource(identity: ProjectResourceIdentity) {
  return resourceFromAttributes(
    resolveProjectResourceAttributes({
      ...identity,
      instanceId: identity.instanceId ?? randomUUID(),
    })
  );
}
