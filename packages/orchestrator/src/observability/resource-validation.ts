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
    throw new Error("OTLP resource permits at most 16 custom attributes");
  for (const [key, value] of Object.entries(custom)) {
    if (
      (Object.hasOwn(reserved, key) &&
        reserved[key as keyof typeof reserved] !== value) ||
      /(?:^|\.)(?:issue|run|session|turn)(?:\.|$)/i.test(key) ||
      !["string", "number", "boolean"].includes(typeof value) ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      throw new Error("OTLP custom resource attribute is invalid or reserved");
  }
  return { ...custom, ...reserved };
}
