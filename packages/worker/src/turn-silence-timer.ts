export type TurnSilenceTimer = {
  arm: () => void;
  cancel: () => void;
};

/**
 * Tracks the maximum interval without app-server output for an active turn.
 */
export function createTurnSilenceTimer(
  timeoutMs: number,
  onTimeout: () => void
): TurnSilenceTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = () => {
    cancel();
    timer = setTimeout(onTimeout, timeoutMs);
  };

  return { arm, cancel };
}
