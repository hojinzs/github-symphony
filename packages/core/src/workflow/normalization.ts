const RFC_3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** Returns canonical, non-empty labels while preserving their first occurrence. */
export function normalizeLabels(list: readonly unknown[]): string[] {
  const labels = new Set<string>();

  for (const value of list) {
    if (typeof value !== "string") {
      continue;
    }

    const label = value.trim().toLowerCase();
    if (label) {
      labels.add(label);
    }
  }

  return [...labels];
}

/** Parses an RFC 3339 timestamp into its canonical ISO 8601 representation. */
export function parseTrackerTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(RFC_3339_TIMESTAMP);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] =
    match;
  const calendarDate = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day))
  );
  if (
    calendarDate.getUTCFullYear() !== Number(year) ||
    calendarDate.getUTCMonth() !== Number(month) - 1 ||
    calendarDate.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (offsetHour !== undefined &&
      (Number(offsetHour) > 23 || Number(offsetMinute) > 59))
  ) {
    return null;
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}
