import type { OtlpHeaders, WorkflowOtlpPolicy } from "./otlp.js";
import { resolveEnvironmentValue, WorkflowValidationError } from "./parser.js";
import { redactObservabilitySecretsWithStats } from "../observability/redaction.js";

type Signal = "logs" | "metrics";
export type ResolvedOtlpTransport = {
  endpoint: string;
  protocol: "http/protobuf";
  headers: Record<string, string>;
};
export type OtlpSafeDescriptor = {
  enabled: boolean;
  disabledReason: "workflow" | "sdk-disabled" | null;
  signals: Partial<
    Record<
      Signal,
      {
        endpoint: string;
        protocol: "http/protobuf";
        headerNames: string[];
      }
    >
  >;
  resourceAttributes: Record<string, string | number | boolean>;
  authReferenceNames: string[];
  unsupportedEnvironmentNames: string[];
  discardedEnvironmentResources?: { key: string; reason: string }[];
};
/** Contains secrets: owner-local memory only, never persist or expose this object. */
export type ResolvedOtlpConfiguration = {
  enabled: boolean;
  logs: ResolvedOtlpTransport | null;
  metrics: ResolvedOtlpTransport | null;
  resourceAttributes: Record<string, string | number | boolean>;
  diagnostics: OtlpSafeDescriptor;
};

/** One resource identity policy shared by ambient filtering and owner validation. */
export const OTLP_RESERVED_RESOURCE_KEYS = [
  "service.name",
  "service.version",
  "service.instance.id",
  "symphony.project.id",
  "symphony.project.slug",
  "symphony.tracker.kind",
] as const;

export function otlpResourceAttributeRejection(
  key: string,
  value: unknown,
  reserved?: Record<string, string>
): string | null {
  if (
    (OTLP_RESERVED_RESOURCE_KEYS as readonly string[]).includes(key) &&
    (!reserved || key === "service.instance.id" || reserved[key] !== value)
  )
    return "reserved identity";
  if (/(?:^|\.)(?:issue|run|session|turn)(?:\.|$)/i.test(key))
    return "forbidden identity segment";
  if (
    !["string", "number", "boolean"].includes(typeof value) ||
    (typeof value === "number" && !Number.isFinite(value))
  )
    return "invalid scalar";
  return null;
}

function fail(path: string, reason: string): never {
  throw new WorkflowValidationError(
    "workflow_validation_error",
    path,
    `OTLP configuration field "${path}" ${reason}.`
  );
}

function parseList(value: string, path: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value.trim()) fail(path, "must not be empty");
  for (const entry of value.split(",")) {
    const equals = entry.indexOf("=");
    if (equals <= 0) fail(path, "contains a malformed key=value entry");
    const key = entry.slice(0, equals).trim();
    if (!key || Object.hasOwn(result, key))
      fail(path, "contains a duplicate or empty key");
    try {
      result[key] = decodeURIComponent(entry.slice(equals + 1).trim());
    } catch {
      fail(path, "contains invalid percent encoding");
    }
  }
  return result;
}

function validateHeaders(headers: Record<string, string>, path: string) {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      ["host", "content-length", "content-type"].includes(lower) ||
      names.has(lower) ||
      /[\r\n]/.test(value)
    ) {
      fail(path, "contains invalid, reserved or duplicate headers");
    }
    names.add(lower);
  }
  return headers;
}

function resolveHeaders(
  raw: OtlpHeaders,
  env: NodeJS.ProcessEnv,
  path: string,
  yaml: boolean
) {
  if (typeof raw === "string") {
    return validateHeaders(
      parseList(yaml ? resolveEnvironmentValue(raw, env, path) : raw, path),
      path
    );
  }
  return validateHeaders(
    Object.fromEntries(
      Object.entries(raw).map(([name, value]) => [
        name,
        resolveEnvironmentValue(value, env, path),
      ])
    ),
    path
  );
}

function endpoint(
  value: string,
  path: string,
  signal: Signal,
  base: boolean
): string {
  if (!value.trim() || /[\r\n]/.test(value))
    fail(path, "requires a non-empty HTTP URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(path, "requires a valid HTTP URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    value.includes("?") ||
    value.includes("#")
  ) {
    fail(path, "requires HTTP/HTTPS without credentials, query or fragment");
  }
  if (base) url.pathname = url.pathname.replace(/\/$/, "") + `/v1/${signal}`;
  return url.href;
}

/**
 * SDK-free owner-only resolution. Caller supplies the immutable effective
 * environment (project .env overlaid by process env). Shared parsing never calls
 * this helper. No network, timers, providers or SDK imports are involved.
 */
export function resolveOtlpConfiguration(
  raw: WorkflowOtlpPolicy | null | undefined,
  effectiveEnv: NodeJS.ProcessEnv
): ResolvedOtlpConfiguration {
  // Empty ambient transport settings are unset; YAML remains unmodified/strict.
  const transportEnv = Object.fromEntries(
    Object.entries(effectiveEnv).map(([key, value]) => [
      key,
      key.startsWith("OTEL_EXPORTER_OTLP_") && !value?.trim()
        ? undefined
        : value,
    ])
  );
  const enabled =
    raw?.enabled === true &&
    effectiveEnv.OTEL_SDK_DISABLED?.trim().toLowerCase() !== "true";
  const diagnostics: OtlpSafeDescriptor = {
    enabled,
    disabledReason: enabled ? null : raw?.enabled ? "sdk-disabled" : "workflow",
    signals: {},
    discardedEnvironmentResources: [],
    resourceAttributes: {},
    authReferenceNames: [...(raw?.authReferenceNames ?? [])],
    unsupportedEnvironmentNames: Object.keys(effectiveEnv)
      .filter((name) =>
        /^(OTEL_(?:LOGS_EXPORTER|METRICS_EXPORTER|TRACES_EXPORTER)|OTEL_EXPORTER_OTLP_(?:TRACES_.*|(?:LOGS_|METRICS_)?(?:COMPRESSION|CLIENT_KEY|CLIENT_CERTIFICATE|CERTIFICATE))|OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE)$/.test(
          name
        )
      )
      .sort(),
  };
  const result: ResolvedOtlpConfiguration = {
    enabled,
    logs: null,
    metrics: null,
    resourceAttributes: {},
    diagnostics,
  };
  if (!enabled || !raw) return result;

  for (const signal of ["logs", "metrics"] as const) {
    const prefix = `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_`;
    const yaml = raw[signal];
    const path = `observability.otlp.${signal}`;
    const signalEndpoint = yaml?.endpoint;
    const generalEndpoint = raw.endpoint;
    const selectedEndpoint =
      signalEndpoint ??
      generalEndpoint ??
      transportEnv[prefix + "ENDPOINT"] ??
      transportEnv.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (selectedEndpoint === undefined)
      fail(`${path}.endpoint`, "is required when enabled");
    const endpointIsYaml =
      signalEndpoint !== undefined || generalEndpoint !== undefined;
    const isBase =
      signalEndpoint === undefined &&
      (generalEndpoint !== undefined ||
        transportEnv[prefix + "ENDPOINT"] === undefined);
    const resolvedEndpoint = endpoint(
      endpointIsYaml
        ? resolveEnvironmentValue(
            selectedEndpoint,
            effectiveEnv,
            `${path}.endpoint`
          )
        : selectedEndpoint,
      `${path}.endpoint`,
      signal,
      isBase
    );
    const protocol =
      yaml?.protocol ??
      raw.protocol ??
      transportEnv[prefix + "PROTOCOL"] ??
      transportEnv.OTEL_EXPORTER_OTLP_PROTOCOL ??
      "http/protobuf";
    if (protocol !== "http/protobuf")
      fail(`${path}.protocol`, "supports only http/protobuf");
    const yamlHeaders = yaml?.headers ?? raw.headers;
    const headers =
      yamlHeaders !== undefined
        ? resolveHeaders(yamlHeaders, effectiveEnv, `${path}.headers`, true)
        : transportEnv[prefix + "HEADERS"] !== undefined
          ? resolveHeaders(
              transportEnv[prefix + "HEADERS"]!,
              effectiveEnv,
              `${path}.headers`,
              false
            )
          : transportEnv.OTEL_EXPORTER_OTLP_HEADERS !== undefined
            ? resolveHeaders(
                transportEnv.OTEL_EXPORTER_OTLP_HEADERS,
                effectiveEnv,
                `${path}.headers`,
                false
              )
            : {};
    result[signal] = { endpoint: resolvedEndpoint, protocol, headers };
    diagnostics.signals[signal] = {
      endpoint: resolvedEndpoint,
      protocol,
      headerNames: Object.keys(headers).sort(),
    };
  }
  const resources: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw.resourceAttributes)) {
    resources[key] =
      typeof value === "string"
        ? resolveEnvironmentValue(
            value,
            effectiveEnv,
            "observability.otlp.resource_attributes"
          )
        : value;
  }
  for (const [key, value] of Object.entries(resources)) {
    const redacted = redactObservabilitySecretsWithStats({ [key]: value });
    if (redacted.redactions.length)
      fail(
        "observability.otlp.resource_attributes",
        `must not contain secrets (attribute ${JSON.stringify(key)})`
      );
  }
  const discard = (key: string, reason: string) =>
    diagnostics.discardedEnvironmentResources!.push({ key, reason });
  let ambient: Record<string, string> = {};
  if (effectiveEnv.OTEL_RESOURCE_ATTRIBUTES !== undefined) {
    try {
      ambient = parseList(
        effectiveEnv.OTEL_RESOURCE_ATTRIBUTES,
        "OTEL_RESOURCE_ATTRIBUTES"
      );
    } catch {
      discard(
        "OTEL_RESOURCE_ATTRIBUTES",
        effectiveEnv.OTEL_RESOURCE_ATTRIBUTES.trim()
          ? "malformed value"
          : "empty value (unset)"
      );
    }
  }
  if (effectiveEnv.OTEL_SERVICE_NAME !== undefined) {
    if (effectiveEnv.OTEL_SERVICE_NAME.trim())
      ambient["service.name"] = effectiveEnv.OTEL_SERVICE_NAME;
    else discard("OTEL_SERVICE_NAME", "empty value (unset)");
  }
  let customCount = Object.keys(resources).filter(
    (key) => !(OTLP_RESERVED_RESOURCE_KEYS as readonly string[]).includes(key)
  ).length;
  for (const [key, value] of Object.entries(ambient)) {
    const reason =
      otlpResourceAttributeRejection(key, value) ??
      (redactObservabilitySecretsWithStats({ [key]: value }).redactions.length
        ? "secret-bearing attribute"
        : null);
    if (reason) discard(key, reason);
    else if (Object.hasOwn(resources, key))
      discard(key, "overridden by workflow");
    else if (customCount >= 16) discard(key, "custom attribute limit (16)");
    else {
      resources[key] = value;
      customCount++;
    }
  }
  result.resourceAttributes = resources;
  diagnostics.resourceAttributes = { ...resources };
  return result;
}
