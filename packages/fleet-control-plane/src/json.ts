/** Canonical JSON preserves array order while ignoring object insertion order. */
export function json(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(json).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${json(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
