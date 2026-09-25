/**
 * @fileoverview Durable mesh state through the plugin storage domain.
 *
 * `ctx.storage` is a plugin-scoped JSON key/value store with prefix scan, which
 * is enough to keep peers and leases across a plugin reload. Messages are
 * deliberately not persisted: a mailbox is a live coordination channel, and
 * replaying stale mail after a restart is worse than an empty inbox.
 */

import type { MeshSnapshot } from "./types.ts"
import { SNAPSHOT_VERSION } from "./core/mesh.ts"

export interface StorageScanPage {
  entries: ReadonlyArray<{ key: string; value: unknown }>
  next?: string
}

/** Structural subset of `ctx.storage`. */
export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; limit?: number; after?: string }): Promise<StorageScanPage>
}

export interface MeshStoreOptions {
  /** Key prefix; per-project keys are appended. */
  key: string
  version?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export class MeshStore {
  readonly #storage: StorageLike
  readonly #key: string
  readonly #version: number

  constructor(storage: StorageLike, options: MeshStoreOptions) {
    this.#storage = storage
    this.#key = options.key
    this.#version = options.version ?? SNAPSHOT_VERSION
  }

  keyFor(projectID: string | undefined): string {
    return `${this.#key}/${projectID ?? "global"}`
  }

  async save(snapshot: MeshSnapshot, projectID?: string): Promise<void> {
    await this.#storage.set(this.keyFor(projectID), snapshot)
  }

  /**
   * Read a snapshot, tolerating anything unusable. A missing, malformed,
   * foreign-version, or JSON-unserializable payload yields `undefined` rather
   * than an error: a broken cache must never stop a plugin from loading.
   */
  async load(projectID?: string): Promise<MeshSnapshot | undefined> {
    let raw: unknown
    try {
      raw = await this.#storage.get(this.keyFor(projectID))
    } catch {
      return undefined
    }
    if (!isRecord(raw)) return undefined
    if (raw.version !== this.#version) return undefined
    if (!Array.isArray(raw.peers) || !Array.isArray(raw.claims)) return undefined
    if (typeof raw.savedAt !== "number") return undefined
    return {
      version: this.#version,
      savedAt: raw.savedAt,
      peers: raw.peers.filter(isRecord) as unknown as MeshSnapshot["peers"],
      claims: raw.claims.filter(isRecord) as unknown as MeshSnapshot["claims"],
    }
  }

  async remove(projectID?: string): Promise<void> {
    try {
      await this.#storage.remove(this.keyFor(projectID))
    } catch {
      // Removing a key that was never written is not a failure worth raising.
    }
  }

  /** Every stored project key, for diagnostics and cleanup. */
  async listProjectKeys(): Promise<string[]> {
    try {
      const page = await this.#storage.scan({ prefix: `${this.#key}/` })
      return page.entries
        .map((entry) => entry.key.slice(this.#key.length + 1))
        .filter((id): id is string => id.length > 0)
    } catch {
      return []
    }
  }
}
