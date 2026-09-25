/**
 * @fileoverview Event stream plumbing.
 *
 * `ctx.event.subscribe()` is the only way a plugin learns what sessions exist
 * (the plugin context has no `session.list`). The consumer must survive
 * individual malformed events and must stop when the plugin unloads, so the
 * pump takes a plain `AsyncIterable` and an `AbortSignal` rather than the
 * context directly — which also makes it trivially testable.
 */

import type { CrosstalkEvent } from "./core/registry.ts"

/** Structural subset of `ctx.event.subscribe()`. */
export interface EventStream {
  subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown>
}

export interface PumpOptions {
  onEvent(event: CrosstalkEvent): void
  onError?(error: unknown, event: unknown): void
}

/** Narrow an unknown stream item to something the registry can read. */
export function asCrosstalkEvent(value: unknown): CrosstalkEvent | undefined {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as { type?: unknown; data?: unknown; created?: unknown; location?: unknown }
  if (typeof candidate.type !== "string") return undefined
  const data =
    candidate.data && typeof candidate.data === "object" && !Array.isArray(candidate.data)
      ? (candidate.data as Record<string, unknown>)
      : undefined
  return {
    type: candidate.type,
    ...(typeof candidate.created === "number" ? { created: candidate.created } : {}),
    ...(data ? { data } : {}),
    ...(candidate.location && typeof candidate.location === "object"
      ? { location: candidate.location as { directory?: string } }
      : {}),
  }
}

/**
 * Consume the event stream until it ends or `signal` aborts. Never rejects: a
 * thrown handler is reported through `onError` and the pump keeps going, so one
 * bad event cannot silently kill presence tracking.
 */
export async function pumpEvents(
  stream: EventStream,
  signal: AbortSignal,
  options: PumpOptions,
): Promise<void> {
  try {
    for await (const raw of stream.subscribe({ signal })) {
      if (signal.aborted) return
      const event = asCrosstalkEvent(raw)
      if (!event) continue
      try {
        options.onEvent(event)
      } catch (error) {
        options.onError?.(error, raw)
      }
    }
  } catch (error) {
    if (!signal.aborted) options.onError?.(error, undefined)
  }
}
