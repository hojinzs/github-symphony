export const DEFAULT_SESSION_MAX_TURNS = 20;

export type MaxTurnsResolution = {
  maxTurns: number;
  exhaustedBeforeStart: boolean;
};

export function resolveMaxTurns(
  value: string | number | null | undefined
): MaxTurnsResolution {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    return {
      maxTurns: DEFAULT_SESSION_MAX_TURNS,
      exhaustedBeforeStart: false,
    };
  }

  const normalized = Math.trunc(parsed);
  if (normalized <= 0) {
    return {
      maxTurns: 0,
      exhaustedBeforeStart: true,
    };
  }

  return {
    maxTurns: normalized,
    exhaustedBeforeStart: false,
  };
}
