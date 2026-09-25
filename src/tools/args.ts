/**
 * @fileoverview Minimal runtime reader for tool input.
 *
 * Tool `execute` receives `any` (the JSON Schema shape is not a TypeScript
 * type), so every tool narrows and validates its own arguments here instead of
 * trusting the model. A rejected argument returns a message the model can act
 * on rather than a thrown stack trace.
 */

export class ArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArgError"
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

export function readString(input: unknown, key: string, options: { required: true; max?: number }): string
export function readString(
  input: unknown,
  key: string,
  options?: { required?: false; max?: number; fallback?: string },
): string | undefined
export function readString(
  input: unknown,
  key: string,
  options: { required?: boolean; max?: number; fallback?: string } = {},
): string | undefined {
  const raw = record(input)[key]
  if (raw === undefined || raw === null) {
    if (options.required) throw new ArgError(`"${key}" is required`)
    return options.fallback
  }
  if (typeof raw !== "string") throw new ArgError(`"${key}" must be a string`)
  const value = raw.trim()
  if (value === "") {
    if (options.required) throw new ArgError(`"${key}" must not be empty`)
    return options.fallback
  }
  if (options.max !== undefined && value.length > options.max) {
    throw new ArgError(`"${key}" is ${value.length} characters; the limit is ${options.max}`)
  }
  return value
}

export function readNumber(input: unknown, key: string, options: { required: true; min?: number; max?: number }): number
export function readNumber(
  input: unknown,
  key: string,
  options?: { required?: false; min?: number; max?: number; fallback?: number },
): number | undefined
export function readNumber(
  input: unknown,
  key: string,
  options: { required?: boolean; min?: number; max?: number; fallback?: number } = {},
): number | undefined {
  const raw = record(input)[key]
  if (raw === undefined || raw === null) {
    if (options.required) throw new ArgError(`"${key}" is required`)
    return options.fallback
  }
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN
  if (!Number.isFinite(value)) throw new ArgError(`"${key}" must be a number`)
  if (options.min !== undefined && value < options.min) throw new ArgError(`"${key}" must be >= ${options.min}`)
  if (options.max !== undefined && value > options.max) throw new ArgError(`"${key}" must be <= ${options.max}`)
  return value
}

export function readBoolean(input: unknown, key: string, fallback?: boolean): boolean | undefined {
  const raw = record(input)[key]
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === "boolean") return raw
  if (raw === "true") return true
  if (raw === "false") return false
  throw new ArgError(`"${key}" must be true or false`)
}

export function readEnum<T extends string>(
  input: unknown,
  key: string,
  allowed: readonly T[],
  fallback?: T,
): T | undefined {
  const raw = record(input)[key]
  if (raw === undefined || raw === null) return fallback
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw new ArgError(`"${key}" must be one of: ${allowed.join(", ")}`)
  }
  return raw as T
}

export function readStringArray(
  input: unknown,
  key: string,
  options: { required: true; max?: number; maxLength?: number },
): string[]
export function readStringArray(
  input: unknown,
  key: string,
  options?: { required?: false; max?: number; maxLength?: number; fallback?: string[] },
): string[] | undefined
export function readStringArray(
  input: unknown,
  key: string,
  options: { required?: boolean; max?: number; maxLength?: number; fallback?: string[] } = {},
): string[] | undefined {
  const raw = record(input)[key]
  if (raw === undefined || raw === null) {
    if (options.required) throw new ArgError(`"${key}" is required`)
    return options.fallback
  }
  const values = Array.isArray(raw) ? raw : [raw]
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== "string") throw new ArgError(`"${key}" must be a list of strings`)
    const trimmed = value.trim()
    if (trimmed === "") continue
    if (options.maxLength !== undefined && trimmed.length > options.maxLength) {
      throw new ArgError(`"${key}" entries must be at most ${options.maxLength} characters`)
    }
    out.push(trimmed)
  }
  if (options.required && out.length === 0) throw new ArgError(`"${key}" must list at least one value`)
  if (options.max !== undefined && out.length > options.max) {
    throw new ArgError(`"${key}" accepts at most ${options.max} entries`)
  }
  return out
}
