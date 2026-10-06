/** Small, dependency-free JSON boundary validators. No coercion or defaulting. */
export class ProtocolValidationError extends Error {
  readonly code = "invalid_input";
  constructor(
    readonly path: string,
    message: string
  ) {
    // Never include rejected values: enrollment tokens and log text may be secret.
    super(`${path}: ${message}`);
    this.name = "ProtocolValidationError";
  }
}
export interface Schema<T> {
  parse(input: unknown, path?: string): T;
}
export function schema<T>(
  parse: (input: unknown, path: string) => T
): Schema<T> {
  return Object.freeze({
    parse: (input: unknown, path = "$") => parse(input, path),
  });
}
export function fail(path: string, message: string): never {
  throw new ProtocolValidationError(path, message);
}
export const text = schema<string>((value, path) => {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    fail(path, "expected nonempty string without NUL");
  return value;
});
export const boolean = schema<boolean>((value, path) => {
  if (typeof value !== "boolean") fail(path, "expected boolean");
  return value;
});
export function literal<const T extends string | number | boolean>(
  expected: T
): Schema<T> {
  return schema((value, path) => {
    if (value !== expected) fail(path, "unexpected literal");
    return expected;
  });
}
export function enumeration<const T extends readonly string[]>(
  values: T
): Schema<T[number]> {
  return schema((value, path) => {
    if (typeof value !== "string" || !values.includes(value))
      fail(path, "unknown enum value");
    return value as T[number];
  });
}
export function integer(
  min: number,
  max = Number.MAX_SAFE_INTEGER
): Schema<number> {
  return schema((value, path) => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    )
      fail(path, "integer outside allowed range");
    return value;
  });
}
export function optional<T>(inner: Schema<T>): Schema<T | undefined> {
  return schema((value, path) =>
    value === undefined ? undefined : inner.parse(value, path)
  );
}
export function array<T>(inner: Schema<T>, max: number): Schema<T[]> {
  return schema((value, path) => {
    if (!Array.isArray(value) || value.length > max)
      fail(path, "array exceeds allowed size or is missing");
    // Array.from also visits holes, which are not legal JSON values.
    return Array.from(value, (item, i) => inner.parse(item, `${path}[${i}]`));
  });
}
type Output<S> = S extends Schema<infer T> ? T : never;
export function object<S extends Record<string, Schema<unknown>>>(
  shape: S
): Schema<{ [K in keyof S]: Output<S[K]> }> {
  return schema((value, path) => {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      fail(path, "expected JSON object");
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record))
      if (!Object.hasOwn(shape, key)) fail(path, "unexpected field");
    const output: Record<string, unknown> = {};
    for (const [key, validator] of Object.entries(shape)) {
      const parsed = validator.parse(
        Object.hasOwn(record, key) ? record[key] : undefined,
        `${path}.${key}`
      );
      if (parsed !== undefined) output[key] = parsed;
    }
    return output as { [K in keyof S]: Output<S[K]> };
  });
}
export function union<T>(...variants: Schema<T>[]): Schema<T> {
  return schema((value, path) => {
    for (const variant of variants) {
      try {
        return variant.parse(value, path);
      } catch (error) {
        if (!(error instanceof ProtocolValidationError)) throw error;
      }
    }
    return fail(path, "no matching variant");
  });
}
export function refine<T>(
  inner: Schema<T>,
  valid: (value: T) => boolean,
  message: string
): Schema<T> {
  return schema((value, path) => {
    const parsed = inner.parse(value, path);
    if (!valid(parsed)) fail(path, message);
    return parsed;
  });
}
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
