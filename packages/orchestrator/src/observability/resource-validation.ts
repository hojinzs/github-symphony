import { otlpResourceAttributeRejection } from "@gh-symphony/core";
import { OtlpValidationError } from "../otlp-validation-error.js";
import type { ProjectResourceIdentity } from "./resource.js";

/** SDK-free validation also runs before accepting workflow reload/LKG. */
export function resolveProjectResourceAttributes(
  identity: ProjectResourceIdentity
) {
  const reserved = {
    "service.name": "gh-symphony",
    "service.version": identity.version,
    "service.instance.id": identity.instanceId ?? "",
    "symphony.project.id": identity.projectId,
    "symphony.project.slug": identity.projectSlug,
    "symphony.tracker.kind": identity.trackerKind,
  };
  const custom = identity.attributes ?? {};
  if (
    Object.keys(custom).filter((key) => !Object.hasOwn(reserved, key)).length >
    16
  )
    throw new OtlpValidationError("resource-limit");
  for (const [key, value] of Object.entries(custom)) {
    if (otlpResourceAttributeRejection(key, value, reserved) !== null)
      throw new OtlpValidationError("resource-attribute");
  }
  return { ...custom, ...reserved };
}
