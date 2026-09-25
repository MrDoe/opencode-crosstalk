/**
 * @fileoverview Plugin option parsing.
 *
 * Options come from `opencode.jsonc` and are untrusted, so every field is
 * validated and clamped. Bad values degrade to a documented default and emit a
 * warning instead of failing plugin setup — a typo should not take an agent's
 * coordination tools away mid-session.
 */

import type { Scope } from "./types.ts"

export interface CrosstalkOptions {
  /** Tool namespace. Defaults to `crosstalk`. */
  namespace: string
  /** Permission action guarding every tool. Defaults to `crosstalk`. */
  permission: string
  /** Expose the tools through Code Mode instead of directly. */
  codemode: boolean
  /** Which peers are visible: same project, same directory, or whole server. */
  scope: Scope
  /** A peer with no event for this long is reported as stale. */
  staleAfterMs: number
  /** A peer with no event for this long is dropped from the registry. */
  evictAfterMs: number
  /** Maximum retained messages per mailbox; oldest read messages go first. */
  maxMessages: number
  /** Messages older than this are pruned. */
  messageTtlMs: number
  /** Default lease duration for `crosstalk_claim`. */
  claimTtlMs: number
  /** Upper bound for any blocking tool call. */
  maxWaitMs: number
  /** Poll interval for the barrier waits. */
  pollMs: number
  /** Progress heartbeat interval while blocked; `0` disables heartbeats. */
  heartbeatMs: number
  /** Persist peers and claims through `ctx.storage`. */
  persist: boolean
  /** Storage key prefix. */
  storageKey: string
  /** Append a short briefing to the agent's system prompt. */
  announce: boolean
}

export const DEFAULTS: CrosstalkOptions = {
  namespace: "crosstalk",
  permission: "crosstalk",
  codemode: false,
  scope: "project",
  staleAfterMs: 600_000,
  evictAfterMs: 3_600_000,
  maxMessages: 100,
  messageTtlMs: 86_400_000,
  claimTtlMs: 300_000,
  maxWaitMs: 120_000,
  pollMs: 1_000,
  heartbeatMs: 10_000,
  persist: true,
  storageKey: "crosstalk",
  announce: true,
}

const SCOPES: readonly Scope[] = ["project", "location", "server"]

export interface ParsedOptions {
  options: CrosstalkOptions
  warnings: string[]
}

/** Read a finite number, clamped to `[min, max]`. */
function numberOption(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  warnings: string[],
): number {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`option "${key}" must be a finite number; using ${fallback}`)
    return fallback
  }
  if (value < min) {
    warnings.push(`option "${key}" (${value}) is below ${min}; clamped`)
    return min
  }
  if (value > max) {
    warnings.push(`option "${key}" (${value}) is above ${max}; clamped`)
    return max
  }
  return value
}

function booleanOption(raw: Record<string, unknown>, key: string, fallback: boolean, warnings: string[]): boolean {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value !== "boolean") {
    warnings.push(`option "${key}" must be a boolean; using ${fallback}`)
    return fallback
  }
  return value
}

function stringOption(
  raw: Record<string, unknown>,
  key: string,
  fallback: string,
  pattern: RegExp,
  warnings: string[],
): string {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value !== "string" || value.length === 0) {
    warnings.push(`option "${key}" must be a non-empty string; using ${fallback}`)
    return fallback
  }
  if (!pattern.test(value)) {
    warnings.push(`option "${key}" (${JSON.stringify(value)}) has unsupported characters; using ${fallback}`)
    return fallback
  }
  return value
}

/**
 * Validate raw plugin options. Unknown keys are reported once so typos are
 * visible without being fatal.
 */
export function parseOptions(raw: unknown): ParsedOptions {
  const warnings: string[] = []
  if (raw === undefined || raw === null) return { options: { ...DEFAULTS }, warnings }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { options: { ...DEFAULTS }, warnings: ["plugin options must be an object; using defaults"] }
  }

  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULTS)) warnings.push(`unknown option "${key}" ignored`)
  }

  const scopeInput = input.scope
  let scope: Scope = DEFAULTS.scope
  if (scopeInput !== undefined) {
    if (typeof scopeInput === "string" && (SCOPES as readonly string[]).includes(scopeInput)) {
      scope = scopeInput as Scope
    } else {
      warnings.push(`option "scope" must be one of ${SCOPES.join(", ")}; using ${DEFAULTS.scope}`)
    }
  }

  const staleAfterMs = numberOption(input, "staleAfterMs", DEFAULTS.staleAfterMs, 1_000, 86_400_000, warnings)
  const evictRaw = numberOption(input, "evictAfterMs", DEFAULTS.evictAfterMs, 1_000, 604_800_000, warnings)

  return {
    warnings,
    options: {
      namespace: stringOption(input, "namespace", DEFAULTS.namespace, /^[A-Za-z0-9_-]+$/, warnings),
      permission: stringOption(input, "permission", DEFAULTS.permission, /^[A-Za-z0-9_*-]+$/, warnings),
      codemode: booleanOption(input, "codemode", DEFAULTS.codemode, warnings),
      scope,
      staleAfterMs,
      // Eviction can never be more eager than the stale threshold.
      evictAfterMs: Math.max(evictRaw, staleAfterMs),
      maxMessages: numberOption(input, "maxMessages", DEFAULTS.maxMessages, 1, 10_000, warnings),
      messageTtlMs: numberOption(input, "messageTtlMs", DEFAULTS.messageTtlMs, 1_000, 2_592_000_000, warnings),
      claimTtlMs: numberOption(input, "claimTtlMs", DEFAULTS.claimTtlMs, 1_000, 86_400_000, warnings),
      maxWaitMs: numberOption(input, "maxWaitMs", DEFAULTS.maxWaitMs, 1_000, 600_000, warnings),
      pollMs: numberOption(input, "pollMs", DEFAULTS.pollMs, 50, 30_000, warnings),
      heartbeatMs: numberOption(input, "heartbeatMs", DEFAULTS.heartbeatMs, 0, 600_000, warnings),
      persist: booleanOption(input, "persist", DEFAULTS.persist, warnings),
      storageKey: stringOption(input, "storageKey", DEFAULTS.storageKey, /^[A-Za-z0-9_./-]+$/, warnings),
      announce: booleanOption(input, "announce", DEFAULTS.announce, warnings),
    },
  }
}
