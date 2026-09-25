/**
 * @fileoverview Shared plumbing for the crosstalk tools.
 *
 * Tool definitions use plain JSON Schema (no Zod) so the plugin has no runtime
 * dependency beyond `@opencode/plugin`, and every executor narrows its input
 * through `src/tools/args.ts`.
 */

import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import type { CrosstalkOptions } from "../config.ts"
import type { Mesh } from "../core/mesh.ts"
import { ArgError } from "./args.ts"

export { ArgError }

export type CrosstalkToolInfo = Parameters<ToolEditor["add"]>[0]
export type ToolInputSchema = CrosstalkToolInfo["input"]
export type { Info, ToolContext }

export interface ToolDeps {
  mesh: Mesh
  options: CrosstalkOptions
}

/**
 * Tool input schemas accept a JSON Schema literal, or an Effect / Standard
 * Schema codec. This plugin only ever writes JSON Schema, so the single cast
 * lives here instead of in every tool.
 */
export function jsonSchema(value: Record<string, unknown>): ToolInputSchema {
  return value as unknown as ToolInputSchema
}

/**
 * Wrap executor bodies: the result becomes tool content, and a bad argument
 * comes back as readable output the model can correct itself from. Any other
 * failure is a real bug and is left to propagate.
 */
export async function run(fn: () => Promise<string> | string): Promise<{ content: string }> {
  try {
    return { content: await fn() }
  } catch (error) {
    if (error instanceof ArgError) return { content: `crosstalk: ${error.message}` }
    throw error
  }
}

/**
 * Call `context.progress` every `intervalMs` while a long call is blocked, so
 * the TUI shows liveness instead of a frozen tool. `intervalMs === 0` disables
 * it, which is what the tests use.
 */
export function startHeartbeat(
  context: ToolContext,
  intervalMs: number,
  status: () => Record<string, unknown>,
): () => void {
  if (intervalMs <= 0) return () => {}
  const timer = setInterval(() => {
    void context.progress(status()).catch(() => {})
  }, intervalMs)
  // Never hold the process open for a heartbeat.
  timer.unref?.()
  const stop = () => clearInterval(timer)
  context.signal.addEventListener("abort", stop, { once: true })
  return stop
}

/** Clamp a requested wait to the configured ceiling. */
export function clampWait(ms: number, options: CrosstalkOptions): number {
  return Math.min(Math.max(0, ms), options.maxWaitMs)
}
