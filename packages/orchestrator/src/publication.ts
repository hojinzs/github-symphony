/** Best-effort publication never awaits a callback or exposes its error payload.
 * Also contain rejected promises from accidentally async implementations.
 */
export function offerBestEffort(operation: () => unknown): void {
  try {
    const result = operation();
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Publication failures must not change persistence or coordination health.
  }
}

export function freezeEvent<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeEvent(child);
    Object.freeze(value);
  }
  return value;
}
