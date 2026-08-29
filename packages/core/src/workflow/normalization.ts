const RFC_3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})t(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:z|([+-])(\d{2}):(\d{2}))$/i;

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
  const calendarDate = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (
    calendarDate.getUTCFullYear() !== Number(year) ||
    calendarDate.getUTCMonth() !== Number(month) - 1 ||
    calendarDate.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 60 ||
    (offsetHour !== undefined &&
      (Number(offsetHour) > 23 || Number(offsetMinute) > 59))
  ) {
    return null;
  }

  const normalized = value.replace("t", "T").replace("z", "Z");
  const timestamp = new Date(
    Number(second) === 60
      ? normalized.replace(/:60(?=(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$)/i, ":59")
      : normalized
  );
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }

  return new Date(
    Number(second) === 60 ? timestamp.getTime() + 1_000 : timestamp.getTime()
  ).toISOString();
}
