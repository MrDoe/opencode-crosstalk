/**
 * @fileoverview Injectable time source and an abortable sleep.
 *
 * Every time-dependent code path in `src/core` takes a `now()` function so TTL
 * and long-poll behaviour is deterministic under test instead of timer-bound.
 */

export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

/** Sleep that resolves early (without throwing) when `signal` aborts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted || ms <= 0) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
