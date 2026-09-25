/**
 * @fileoverview Presence registry: folds the OpenCode event stream into a live
 * view of which sessions exist, where they run, and whether they are busy.
 *
 * The plugin context deliberately exposes no `session.list()` / `session.active`
 * (its session domain is a narrow `Pick` of the client API), so discovery is
 * built from `ctx.event.subscribe()`. Every event carries `{ type, location,
 * data }`, which is exactly the information a peer listing needs.
 *
 * Liveness has two thresholds: past `staleAfterMs` a peer is still listed but
 * flagged, because an agent can spend minutes inside one model call without
 * emitting anything; past `evictAfterMs` it is dropped, because a server that
 * died will never send another event.
 */

import type { Peer, PeerStatus, PeerView, Scope } from "../types.ts"

/** Structural subset of an OpenCode server event that the registry reads. */
export interface CrosstalkEvent {
  readonly type: string
  readonly created?: number
  readonly location?: { readonly directory?: string; readonly workspaceID?: string }
  readonly data?: Readonly<Record<string, unknown>>
}

export interface RegistryOptions {
  now(): number
  staleAfterMs: number
  evictAfterMs: number
}

export interface ListFilter {
  selfID?: string
  scope?: Scope
  /** Falls back to the plugin location when the peer record has no project. */
  selfProjectID?: string
  selfDirectory?: string
  status?: "running" | "idle" | "all"
  includeSelf?: boolean
  limit?: number
}

const STATUS_RANK: Readonly<Record<PeerStatus, number>> = { running: 0, idle: 1, unknown: 2 }

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Best-effort extraction of a session directory from an event. */
function directoryOf(event: CrosstalkEvent): string | undefined {
  const data = event.data
  const nested = data?.location
  if (nested && typeof nested === "object") {
    const value = (nested as { directory?: unknown }).directory
    if (typeof value === "string" && value.length > 0) return value
  }
  return str(event.location?.directory)
}

function modelLabel(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return undefined
  const ref = value as { providerID?: unknown; id?: unknown; variant?: unknown }
  const id = str(ref.id)
  if (!id) return undefined
  const provider = str(ref.providerID)
  const variant = str(ref.variant)
  const base = provider ? `${provider}/${id}` : id
  return variant ? `${base}#${variant}` : base
}

export class Registry {
  readonly #peers = new Map<string, Peer>()
  readonly #now: () => number
  readonly #staleAfterMs: number
  readonly #evictAfterMs: number

  constructor(options: RegistryOptions) {
    this.#now = options.now
    this.#staleAfterMs = options.staleAfterMs
    this.#evictAfterMs = options.evictAfterMs
  }

  get size(): number {
    return this.#peers.size
  }

  get(sessionID: string): Peer | undefined {
    return this.#peers.get(sessionID)
  }

  /**
   * Create a placeholder record for a session the registry has not seen an
   * event for — a child session started before the plugin loaded, or the
   * calling session itself.
   */
  ensure(sessionID: string, defaults: { projectID?: string; directory?: string; agent?: string } = {}): Peer {
    const existing = this.#peers.get(sessionID)
    if (existing) return existing
    const now = this.#now()
    const peer: Peer = {
      sessionID,
      status: "unknown",
      created: now,
      lastSeen: now,
      projectID: defaults.projectID,
      directory: defaults.directory,
      agent: defaults.agent,
    }
    this.#peers.set(sessionID, peer)
    return peer
  }

  /** Merge a patch into a peer, creating it when unknown. */
  update(sessionID: string, patch: Partial<Peer>): Peer {
    const peer = this.ensure(sessionID)
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      if (key === "sessionID" || key === "lastSeen") continue
      // `declared` is a nested record; callers pass the whole object.
      ;(peer as unknown as Record<string, unknown>)[key] = value
    }
    return peer
  }

  delete(sessionID: string): boolean {
    return this.#peers.delete(sessionID)
  }

  /**
   * Fold one server event into the registry. Returns true when the event was
   * recognized and changed or refreshed a record. Unknown event types are
   * ignored so the reducer can be extended without breaking older hosts.
   */
  apply(event: CrosstalkEvent): boolean {
    const data = event.data
    if (!data) return false
    const sessionID = str(data.sessionID)
    if (!sessionID) return false

    if (event.type === "session.deleted") return this.delete(sessionID)

    const at = this.#timestamp(event)
    // `ensure` is what creates a record, so the event's own directory has to be
    // passed in here — a second `ensure` call would find the record already
    // present and ignore the defaults.
    const target = this.ensure(sessionID, { directory: directoryOf(event) })
    target.lastSeen = at

    switch (event.type) {
      case "session.created": {
        target.projectID = str(data.projectID) ?? target.projectID
        target.directory = directoryOf(event) ?? target.directory
        target.title = str(data.title) ?? target.title
        target.agent = str(data.agent) ?? target.agent
        target.parentID = str(data.parentID) ?? target.parentID
        target.model = modelLabel(data.model) ?? target.model
        target.created = typeof data.created === "number" ? data.created : (target.created ?? at)
        break
      }
      case "session.forked": {
        target.parentID = str(data.parentID) ?? target.parentID
        break
      }
      case "session.renamed": {
        target.title = str(data.title) ?? target.title
        break
      }
      case "session.moved": {
        target.projectID = str(data.projectID) ?? target.projectID
        const moved = data.location
        if (moved && typeof moved === "object") {
          const dir = (moved as { directory?: unknown }).directory
          if (typeof dir === "string" && dir.length > 0) target.directory = dir
        }
        break
      }
      case "session.execution.started": {
        target.status = "running"
        break
      }
      case "session.status": {
        const status = data.status
        if (status && typeof status === "object") {
          const kind = (status as { type?: unknown }).type
          if (kind === "busy" || kind === "retry") target.status = "running"
          else if (kind === "idle") target.status = "idle"
        }
        break
      }
      case "session.idle":
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        target.status = "idle"
        break
      }
      case "session.tool.called":
      case "session.step.started":
      case "session.shell.started": {
        target.status = "running"
        break
      }
      default:
        // Touched liveness above; no field to update.
        return true
    }
    return true
  }

  /** True when no event arrived within the stale threshold. */
  isStale(peer: Peer, now = this.#now()): boolean {
    return now - peer.lastSeen > this.#staleAfterMs
  }

  /** Drop peers with no activity within the eviction threshold. */
  prune(now = this.#now()): string[] {
    const removed: string[] = []
    for (const peer of this.#peers.values()) {
      if (now - peer.lastSeen > this.#evictAfterMs) {
        this.#peers.delete(peer.sessionID)
        removed.push(peer.sessionID)
      }
    }
    return removed
  }

  /** Peers visible under `filter`, running first, then most recently active. */
  list(filter: ListFilter = {}): Peer[] {
    const scope = filter.scope ?? "server"
    const self = filter.selfID ? this.#peers.get(filter.selfID) : undefined
    const selfProject = self?.projectID ?? filter.selfProjectID
    const selfDirectory = self?.directory ?? filter.selfDirectory
    const want = filter.status ?? "all"

    const visible: Peer[] = []
    for (const peer of this.#peers.values()) {
      const isSelf = filter.selfID !== undefined && peer.sessionID === filter.selfID
      if (isSelf && !filter.includeSelf) continue
      if (scope === "project" && selfProject !== undefined) {
        // Unknown-project peers stay visible: better to over-report than to hide
        // a session that is genuinely working the same repository.
        if (peer.projectID !== undefined && peer.projectID !== selfProject) continue
      }
      if (scope === "location" && selfDirectory !== undefined) {
        if (peer.directory !== undefined && peer.directory !== selfDirectory) continue
      }
      // Asking for yourself is asking for yourself: a status filter is about
      // peers, so it should not silently drop the caller.
      if (!isSelf && want !== "all" && peer.status !== want) continue
      visible.push(peer)
    }

    visible.sort((a, b) => {
      const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
      if (rank !== 0) return rank
      if (a.lastSeen !== b.lastSeen) return b.lastSeen - a.lastSeen
      return a.sessionID < b.sessionID ? -1 : a.sessionID > b.sessionID ? 1 : 0
    })

    if (filter.limit !== undefined && filter.limit >= 0 && visible.length > filter.limit) {
      return visible.slice(0, filter.limit)
    }
    return visible
  }

  /** Peer plus mesh-derived fields, as tools hand them to agents. */
  view(peer: Peer, extras: { isSelf: boolean; unread: number; claims: string[] }, now = this.#now()): PeerView {
    return {
      ...peer,
      isSelf: extras.isSelf,
      stale: this.isStale(peer, now),
      unread: extras.unread,
      claims: extras.claims,
    }
  }

  #timestamp(event: CrosstalkEvent): number {
    return typeof event.created === "number" ? event.created : this.#now()
  }
}
