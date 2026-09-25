/**
 * @fileoverview Resource leases.
 *
 * Two agents editing the same file is the coordination failure that actually
 * bites in a shared repository, so a claim is a hard, exclusive, expiring
 * lease rather than a convention. Keys are normalized paths (or any named
 * resource string) so `"./src/a.ts"`, `"src//a.ts"` and `"src/a.ts/"` all
 * collide, and relative paths resolve against the holder's directory so two
 * worktrees of the same project do not shadow each other.
 */

import type { Claim, ClaimConflict, ClaimOutcome } from "../types.ts"

export interface ClaimOptions {
  now(): number
  defaultTtlMs: number
}

export interface ClaimRequest {
  holder: string
  resources: readonly string[]
  ttlMs?: number
  note?: string
  /** Steal leases held by others. */
  force?: boolean
  /** Default true: one conflict aborts the whole request. */
  atomic?: boolean
  baseDir?: string
}

export interface ListFilter {
  holder?: string
  /** Only claims whose key matches this resource. */
  resource?: string
  includeExpired?: boolean
  baseDir?: string
}

/**
 * Normalize a resource string into a comparison key.
 *
 * Windows-looking paths (drive letter or backslashes) are case-folded because
 * that filesystem is; POSIX paths keep their case.
 */
export function normalizeResource(raw: string, baseDir?: string): string {
  const original = raw.trim()
  if (original === "") return ""
  const windows = original.includes("\\") || /^[a-zA-Z]:/.test(original)
  const slashed = original.replaceAll("\\", "/")
  // A base directory can make a relative resource absolute, so `absolute` has
  // to be decided from the combined path, not from the raw input.
  const source = slashed.startsWith("/")
    ? slashed
    : baseDir
      ? `${baseDir.replaceAll("\\", "/").replace(/\/+$/, "")}/${slashed}`
      : slashed
  const absolute = source.startsWith("/")

  const out: string[] = []
  for (const segment of source.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      const last = out.at(-1)
      if (last !== undefined && last !== "..") out.pop()
      else if (!absolute) out.push("..")
      continue
    }
    out.push(segment)
  }

  const joined = out.join("/")
  const result = absolute ? `/${joined}` : joined
  return windows ? result.toLowerCase() : result
}

export class ClaimTable {
  readonly #claims = new Map<string, Claim>()
  readonly #now: () => number
  readonly #defaultTtlMs: number

  constructor(options: ClaimOptions) {
    this.#now = options.now
    this.#defaultTtlMs = Math.max(1, options.defaultTtlMs)
  }

  get size(): number {
    return this.#claims.size
  }

  normalize(raw: string, baseDir?: string): string {
    return normalizeResource(raw, baseDir)
  }

  /**
   * Take leases.
   *
   * Two phases on purpose: the whole request is planned against current state
   * before anything is written, so an atomic request that hits one conflict
   * leaves the table exactly as it found it — including keys it had already
   * staged earlier in the same call.
   */
  claim(request: ClaimRequest): ClaimOutcome {
    const atomic = request.atomic !== false
    const ttl = this.#resolveTtl(request.ttlMs)
    const now = this.#now()

    type Step =
      | { action: "take"; key: string; raw: string; previous: Claim | undefined }
      | { action: "renew"; key: string; previous: Claim }
      | { action: "skip" }

    const outcome: ClaimOutcome = {
      claimed: [],
      renewed: [],
      released: [],
      stolen: [],
      conflicts: [],
      rolledBack: false,
    }
    const plan: Step[] = []
    const seen = new Set<string>()

    for (const raw of request.resources) {
      const key = this.normalize(raw, request.baseDir)
      if (key === "" || seen.has(key)) continue
      seen.add(key)

      const existing = this.#claims.get(key)
      const live = existing !== undefined && existing.expires > now
      const mine = live && existing.holder === request.holder

      if (live && !mine && !request.force) {
        outcome.conflicts.push(this.#conflict(key, raw, existing))
        if (atomic) {
          outcome.rolledBack = true
          return outcome
        }
        plan.push({ action: "skip" })
        continue
      }

      if (live && !mine) outcome.stolen.push(key)

      if (mine && existing) {
        plan.push({ action: "renew", key, previous: existing })
        continue
      }

      // Not live, or ours to take: a lapsed lease is not a conflict, because
      // the previous holder let it expire.
      plan.push({ action: "take", key, raw, previous: existing })
    }

    for (const step of plan) {
      if (step.action === "skip") continue
      if (step.action === "renew") {
        step.previous.expires = now + ttl
        step.previous.note = request.note ?? step.previous.note
        outcome.renewed.push(step.key)
        continue
      }
      const acquired = step.previous?.holder === request.holder ? (step.previous.acquired ?? now) : now
      this.#claims.set(step.key, {
        key: step.key,
        raw: step.raw,
        holder: request.holder,
        note: request.note,
        acquired,
        expires: now + ttl,
      })
      outcome.claimed.push(step.key)
    }

    return outcome
  }

  /** Extend leases the caller already holds. Unknown or foreign keys are reported. */
  renew(request: ClaimRequest): ClaimOutcome {
    const now = this.#now()
    const ttl = this.#resolveTtl(request.ttlMs)
    const outcome: ClaimOutcome = { claimed: [], renewed: [], released: [], stolen: [], conflicts: [], rolledBack: false }
    const atomic = request.atomic !== false

    for (const raw of request.resources) {
      const key = this.normalize(raw, request.baseDir)
      if (key === "") continue
      const existing = this.#claims.get(key)
      if (!existing || existing.expires <= now) {
        outcome.conflicts.push({ key, raw, holder: existing?.holder ?? "", expires: existing?.expires ?? 0 })
        if (atomic) {
          outcome.rolledBack = true
          return outcome
        }
        continue
      }
      if (existing.holder !== request.holder) {
        outcome.conflicts.push(this.#conflict(key, raw, existing))
        if (atomic) {
          outcome.rolledBack = true
          return outcome
        }
        continue
      }
      existing.expires = now + ttl
      existing.note = request.note ?? existing.note
      outcome.renewed.push(key)
    }

    return outcome
  }

  /** Release leases. Only the holder may release, unless `force` is set. */
  release(request: ClaimRequest): ClaimOutcome {
    const now = this.#now()
    const outcome: ClaimOutcome = { claimed: [], renewed: [], released: [], stolen: [], conflicts: [], rolledBack: false }

    for (const raw of request.resources) {
      const key = this.normalize(raw, request.baseDir)
      if (key === "") continue
      const existing = this.#claims.get(key)
      if (!existing || existing.expires <= now) {
        this.#claims.delete(key)
        continue
      }
      if (existing.holder !== request.holder && !request.force) {
        outcome.conflicts.push(this.#conflict(key, raw, existing))
        continue
      }
      if (existing.holder !== request.holder) outcome.stolen.push(key)
      this.#claims.delete(key)
      outcome.released.push(key)
    }

    return outcome
  }

  list(filter: ListFilter = {}): Claim[] {
    const now = this.#now()
    const resourceKey = filter.resource === undefined ? undefined : this.normalize(filter.resource, filter.baseDir)
    const claims: Claim[] = []
    for (const claim of this.#claims.values()) {
      if (claim.expires <= now && !filter.includeExpired) continue
      if (filter.holder !== undefined && claim.holder !== filter.holder) continue
      if (resourceKey !== undefined && claim.key !== resourceKey) continue
      claims.push(claim)
    }
    claims.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return claims
  }

  /** Keys currently held by a session. */
  heldBy(holder: string): string[] {
    return this.list({ holder }).map((claim) => claim.key)
  }

  /** True when nothing live holds the resource. */
  isFree(raw: string, baseDir?: string): boolean {
    const key = this.normalize(raw, baseDir)
    if (key === "") return true
    const existing = this.#claims.get(key)
    return !existing || existing.expires <= this.#now()
  }

  /** Delete expired leases. Returns how many were removed. */
  prune(): number {
    const now = this.#now()
    let removed = 0
    for (const [key, claim] of this.#claims) {
      if (claim.expires <= now) {
        this.#claims.delete(key)
        removed += 1
      }
    }
    return removed
  }

  /** Every live claim, for snapshotting. */
  entries(): Claim[] {
    return this.list({ includeExpired: false })
  }

  /**
   * Re-insert a claim verbatim, used when restoring a snapshot where the key
   * has already been normalized. Callers must check `isFree` first.
   */
  adopt(claim: Claim): void {
    this.#claims.set(claim.key, { ...claim })
  }

  #resolveTtl(ttlMs: number | undefined): number {
    return Math.max(1, ttlMs ?? this.#defaultTtlMs)
  }

  #conflict(key: string, raw: string, claim: Claim): ClaimConflict {
    return { key, raw, holder: claim.holder, note: claim.note, expires: claim.expires }
  }
}
