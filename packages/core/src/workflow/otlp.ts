import { WorkflowValidationError } from "./parser.js";

export type OtlpHeaders = string | Record<string, string>;
export type OtlpTransportPolicy = {
  endpoint?: string;
  protocol?: "http/protobuf";
  headers?: OtlpHeaders;
};
export type WorkflowOtlpPolicy = OtlpTransportPolicy & {
  enabled: boolean;
  logs?: OtlpTransportPolicy;
  metrics?: OtlpTransportPolicy;
  resourceAttributes: Record<string, string | boolean | number>;
  /** Names only; safe to inspect even when exporter credentials are absent. */
  referenceNames: string[];
  authReferenceNames: string[];
};

function invalid(path: string, reason: string): never {
  throw new WorkflowValidationError(
    "workflow_validation_error",
    path,
    `Workflow front matter field "${path}" ${reason}.`
  );
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "must be a mapping");
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], path: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${path}.${key}`, "is unsupported");
  }
}

/** Whole-value references only. Never looks up an environment value. */
export function otlpReferenceName(value: string, path: string): string | null {
  const match = value.match(
    /^(?:env:([A-Za-z_][A-Za-z0-9_]*)|\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\})$/
  );
  if (match) return match[1] ?? match[2] ?? match[3]!;
  if (value.startsWith("env:") || value.includes("$")) {
    invalid(path, "must use a valid whole-value environment reference");
  }
  return null;
}

export function parseOtlpPolicy(
  observability: unknown
): WorkflowOtlpPolicy | null {
  if (observability === undefined) return null;
  const outer = object(observability, "observability");
  keys(outer, ["otlp"], "observability");
  if (outer.otlp === undefined) return null;
  const path = "observability.otlp";
  const raw = object(outer.otlp, path);
  keys(
    raw,
    [
      "enabled",
      "endpoint",
      "protocol",
      "headers",
      "logs",
      "metrics",
      "resource_attributes",
    ],
    path
  );
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    invalid(`${path}.enabled`, "must be a boolean");
  }
  const refs = new Set<string>();
  const auth = new Set<string>();
  function string(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim())
      invalid(field, "must be a non-empty string");
    const name = otlpReferenceName(value, field);
    if (name) refs.add(name);
    return value;
  }
  function headers(value: unknown, field: string): OtlpHeaders {
    if (typeof value === "string") {
      const ref = otlpReferenceName(string(value, field), field);
      if (!ref) invalid(field, "must be an environment reference");
      auth.add(ref);
      return value;
    }
    const result: Record<string, string> = {};
    const seen = new Set<string>();
    for (const [name, entry] of Object.entries(object(value, field))) {
      const lower = name.toLowerCase();
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        ["host", "content-length", "content-type"].includes(lower) ||
        seen.has(lower)
      ) {
        invalid(
          field,
          "contains an invalid, duplicate or reserved header name"
        );
      }
      seen.add(lower);
      const text = string(entry, field);
      const ref = otlpReferenceName(text, field);
      if (!ref) invalid(field, "requires secret references for header values");
      auth.add(ref);
      result[name] = text;
    }
    return result;
  }
  function transport(
    raw: Record<string, unknown>,
    field: string
  ): OtlpTransportPolicy {
    const result: OtlpTransportPolicy = {};
    if (raw.endpoint !== undefined)
      result.endpoint = string(raw.endpoint, `${field}.endpoint`);
    if (raw.protocol !== undefined) {
      if (raw.protocol !== "http/protobuf")
        invalid(`${field}.protocol`, "supports only http/protobuf");
      result.protocol = raw.protocol;
    }
    if (raw.headers !== undefined)
      result.headers = headers(raw.headers, `${field}.headers`);
    return result;
  }
  const result: WorkflowOtlpPolicy = {
    ...transport(raw, path),
    enabled: raw.enabled === true,
    resourceAttributes: {},
    referenceNames: [],
    authReferenceNames: [],
  };
  for (const signal of ["logs", "metrics"] as const) {
    if (raw[signal] === undefined) continue;
    const node = object(raw[signal], `${path}.${signal}`);
    keys(node, ["endpoint", "protocol", "headers"], `${path}.${signal}`);
    result[signal] = transport(node, `${path}.${signal}`);
  }
  if (raw.resource_attributes !== undefined) {
    for (const [key, value] of Object.entries(
      object(raw.resource_attributes, `${path}.resource_attributes`)
    )) {
      const field = `${path}.resource_attributes.${key}`;
      if (typeof value === "string")
        result.resourceAttributes[key] = string(value, field);
      else if (
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      )
        result.resourceAttributes[key] = value;
      else invalid(field, "must be a string, boolean or finite number");
    }
  }
  result.referenceNames = [...refs].sort();
  result.authReferenceNames = [...auth].sort();
  return result;
}
