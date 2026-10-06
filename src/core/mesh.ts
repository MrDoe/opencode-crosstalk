/**
 * @fileoverview The mesh: presence, mailboxes, and leases behind one façade.
 *
 * `Mesh` owns no I/O beyond the injected clock and an optional `Deliverer`, so
 * every behaviour here is exercised directly in tests. `src/index.ts` supplies
 * the real deliverer (OpenCode's `session.synthetic`) and the real event
 * stream.
 */

import type {
  Claim,
  ClaimOutcome,
  CrosstalkMessage,
  Declared,
  Delivery,
  MeshSnapshot,
  MessageKind,
  Peer,
  PeerView,
  Scope,
} from "../types.ts"
import { delay, systemClock, type Clock } from "./clock.ts"
import { ClaimTable } from "./claims.ts"
import { Mailbox, type ListOptions, type WaitResult } from "./mailbox.ts"
import { Registry, type CrosstalkEvent, type ListFilter } from "./registry.ts"

export interface MeshOptions {
  scope: Scope
  staleAfterMs: number
  evictAfterMs: number
  maxMessages: number
  messageTtlMs: number
  claimTtlMs: number
  maxWaitMs: number
  pollMs: number
}

export interface Deliverer {
  deliver(message: CrosstalkMessage): Promise<{ delivered: boolean; reason?: string }>
}

export interface MeshDeps {
  options: MeshOptions
  clock?: Clock
  deliverer?: Deliverer
  /** Plugin location, used when a peer record carries no project or directory. */
  defaults?: { projectID?: string; directory?: string }
  idFactory?(seq: number): string
}

export interface SendInput {
  to?: string
  role?: string
  all?: boolean
  topic?: string
  text: string
  kind?: MessageKind
  delivery?: Delivery
  /** Set when the caller is answering another message. */
  replyTo?: string
}

export interface SendOutcome {
  recipients: Array<{ sessionID: string; delivered: boolean; reason?: string }>
  skipped: Array<{ target: string; reason: string }>
  messages: CrosstalkMessage[]
}

export interface InboxInput extends ListOptions {
  waitMs?: number
  markRead?: boolean
}

export interface InboxOutcome {
  messages: CrosstalkMessage[]
  reason: "immediate" | WaitResult["reason"]
  marked: number
  /** Unread remaining after this call. */
  unread: number
  /** Unread as it stood before this call acknowledged anything. */
  unreadBefore: number
}

export interface ClaimInput {
  action: "claim" | "release" | "renew" | "list"
  resources?: readonly string[]
  ttlMs?: number
  note?: string
  force?: boolean
  atomic?: boolean
  includeExpired?: boolean
}

export interface ClaimResult {
  outcome: ClaimOutcome
  held: Claim[]
  ttlMs: number
}

export interface PeerIdleResult {
  reason: "done" | "timeout" | "aborted" | "gone" | "outside"
  elapsedMs: number
  status?: Peer["status"]
}

export interface ClaimFreeResult {
  reason: "done" | "timeout" | "aborted"
  elapsedMs: number
  holder?: string
}

export interface DeclareResult {
  view: PeerView
  /**
   * The requested name is already used by another visible session; nothing was
   * changed. `holder` is the session that owns the name.
   */
  nameConflict?: { name: string; holder: string }
}

export const SNAPSHOT_VERSION = 1

export class Mesh {
  readonly registry: Registry
  readonly mailbox: Mailbox
  readonly claims: ClaimTable
  readonly options: MeshOptions

  readonly #clock: Clock
  readonly #deliverer: Deliverer | undefined
  readonly #defaults: { projectID?: string; directory?: string }
  readonly #idFactory: ((seq: number) => string) | undefined
  /**
   * Messages that are in a mailbox but were never injected into the live
   * session, keyed by the session that should receive them. A `synthetic` call
   * can fail across locations; without this the recipient would only ever find
   * the message by polling, so every tool call retries them first.
   */
  readonly #pendingInjection = new Map<string, CrosstalkMessage[]>()

  /** Mesh-mutation observers (the RPC bridge); a listener must never throw. */
  readonly #listeners = new Set<() => void>()

  constructor(deps: MeshDeps) {
    this.options = deps.options
    this.#clock = deps.clock ?? systemClock
    this.#deliverer = deps.deliverer
    this.#defaults = deps.defaults ?? {}
    this.#idFactory = deps.idFactory
    this.registry = new Registry({
      now: () => this.#clock.now(),
      staleAfterMs: deps.options.staleAfterMs,
      evictAfterMs: deps.options.evictAfterMs,
    })
    this.mailbox = new Mailbox({
      now: () => this.#clock.now(),
      maxPerSession: deps.options.maxMessages,
      ttlMs: deps.options.messageTtlMs,
      ...(this.#idFactory ? { idFactory: this.#idFactory } : {}),
    })
    this.claims = new ClaimTable({ now: () => this.#clock.now(), defaultTtlMs: deps.options.claimTtlMs })
  }

  now(): number {
    return this.#clock.now()
  }

  /**
   * Observe declarations and presence changes. The RPC bridge subscribes so it
   * can push directory updates without polling.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {
        // A broken observer must never break a tool call.
      }
    }
  }

  /** Fold a server event in and evict lapsed peers. */
  applyEvent(event: CrosstalkEvent): boolean {
    const applied = this.registry.apply(event)
    if (applied) {
      this.registry.prune(this.#clock.now())
      this.#notify()
    }
    return applied
  }

  /**
   * Guarantee a record for the calling session. A session that started before
   * the plugin loaded may never emit `session.created` at us.
   */
  ensureSelf(sessionID: string, agent?: string): Peer {
    return this.registry.ensure(sessionID, {
      projectID: this.#defaults.projectID,
      directory: this.#defaults.directory,
      ...(agent ? { agent } : {}),
    })
  }

  /** The directory claims and relative paths resolve against for a session. */
  directoryOf(sessionID: string): string | undefined {
    return this.registry.get(sessionID)?.directory ?? this.#defaults.directory
  }

  #filter(selfID: string, overrides: Partial<ListFilter> = {}): ListFilter {
    return {
      selfID,
      scope: this.options.scope,
      selfProjectID: this.#defaults.projectID,
      selfDirectory: this.#defaults.directory,
      ...overrides,
    }
  }

  /** Peer records visible to `selfID`, decorated with mesh state. */
  peers(selfID: string, filter: Partial<ListFilter> = {}): PeerView[] {
    this.ensureSelf(selfID)
    const now = this.#clock.now()
    return this.registry.list(this.#filter(selfID, filter)).map((peer) =>
      this.registry.view(
        peer,
        {
          isSelf: peer.sessionID === selfID,
          unread: this.mailbox.unreadCount(peer.sessionID),
          claims: this.claims.heldBy(peer.sessionID),
          addressable: this.#inScope(selfID, peer),
        },
        now,
      ),
    )
  }

  view(selfID: string): PeerView {
    const self = this.ensureSelf(selfID)
    return this.registry.view(
      self,
      { isSelf: true, unread: this.mailbox.unreadCount(selfID), claims: this.claims.heldBy(selfID), addressable: true },
      this.#clock.now(),
    )
  }

  /** Record what a session says it is doing. Returns the updated self view. */
  declare(sessionID: string, declared: Declared): DeclareResult {
    const id = sessionIDOrThrow(sessionID)
    const peer = this.ensureSelf(id)
    // A name is a nickname, not identity: it must be unique among the peers
    // the session can see, and a taken name is refused without touching the
    // rest of the declaration.
    if (declared.name !== undefined && declared.name !== peer.declared?.name) {
      const holder = this.#nameHolder(declared.name, id)
      if (holder) return { view: this.view(id), nameConflict: { name: declared.name, holder } }
    }
    const previous = peer.declared
    const merged: Declared = {
      name: declared.name ?? previous?.name,
      role: declared.role ?? previous?.role,
      goal: declared.goal ?? previous?.goal,
      note: declared.note ?? previous?.note,
      avatar: declared.avatar ?? previous?.avatar,
      workingOn: declared.workingOn ?? previous?.workingOn,
      updatedAt: this.#clock.now(),
    }
    peer.declared = merged
    peer.lastSeen = this.#clock.now()
    this.#notify()
    return { view: this.view(id) }
  }

  /** The visible session that already declared `name`, if any. */
  #nameHolder(name: string, selfID: string): string | undefined {
    const wanted = name.toLowerCase()
    for (const peer of this.registry.list(this.#filter(selfID))) {
      if (peer.sessionID === selfID) continue
      if (peer.declared?.name?.toLowerCase() === wanted) return peer.sessionID
    }
    return undefined
  }

  /**
   * Send a message to peers, then try to inject it into each recipient's live
   * session. A failed injection is not an error: the message stays in the
   * recipient's mailbox and surfaces on their next `crosstalk_inbox`.
   */
  async send(selfID: string, input: SendInput, signal?: AbortSignal): Promise<SendOutcome> {
    const sender = this.ensureSelf(selfID)
    const targets = this.#resolveTargets(selfID, input)
    if (targets.recipients.length === 0) {
      return { recipients: [], skipped: targets.skipped, messages: [] }
    }

    const meta: Record<string, unknown> = {}
    if (input.replyTo) meta.replyTo = input.replyTo
    meta.requested = sender.declared?.role

    const messages = this.mailbox.send({
      from: selfID,
      ...(sender.declared?.name ? { fromName: sender.declared.name } : {}),
      ...(sender.declared?.role ? { fromRole: sender.declared.role } : {}),
      to: targets.recipients,
      text: input.text,
      ...(input.topic ? { topic: input.topic } : {}),
      kind: input.kind ?? "message",
      delivery: input.delivery ?? "steer",
      meta,
    })

    const recipients: SendOutcome["recipients"] = []
    for (const message of messages) {
      if (signal?.aborted) {
        recipients.push({ sessionID: message.to, delivered: false, reason: "cancelled" })
        continue
      }
      const peer = this.registry.get(message.to)
      if (!peer) {
        recipients.push({ sessionID: message.to, delivered: false, reason: "session not known to the mesh" })
        continue
      }
      // Defense in depth: the targets were resolved inside the wall, but a
      // session whose location changed between resolution and delivery must
      // not receive mail across it.
      if (!this.#inScope(selfID, peer)) {
        recipients.push({ sessionID: message.to, delivered: false, reason: `outside the ${this.options.scope} scope` })
        continue
      }
      // `session.synthetic` on a foreign location may throw; the mailbox copy
      // is the durable path, so a failure only downgrades delivery and is
      // retried the next time the recipient touches a crosstalk tool.
      const result = this.#deliverer
        ? await this.#deliverer.deliver(message)
        : { delivered: false, reason: "no deliverer configured" }
      if (!result.delivered) this.#queuePending(message)
      recipients.push({ sessionID: message.to, delivered: result.delivered, reason: result.reason })
    }

    return { recipients, skipped: targets.skipped, messages }
  }

  /**
   * Retry injecting messages that were queued for `sessionID` but never made it
   * into its live turn. Called before every tool execution, so a peer recovers
   * from a failed injection as soon as it does anything at all. Returns how
   * many were delivered by this attempt.
   */
  async flushPendingInjection(sessionID: string, signal?: AbortSignal): Promise<number> {
    const queue = this.#pendingInjection.get(sessionID)
    if (!queue || queue.length === 0) return 0

    const cutoff = this.#clock.now() - this.options.messageTtlMs
    const remaining: CrosstalkMessage[] = []
    let delivered = 0

    for (const message of queue) {
      if (message.created < cutoff) continue
      const peer = this.registry.get(message.to)
      if (signal?.aborted || !peer) {
        remaining.push(message)
        continue
      }
      // The wall holds on retries too: a session that moved out of this
      // location's project must not receive cross-project mail. The message
      // stays queued in case the record catches up; it can never be injected.
      if (!this.#deliverable(peer)) {
        remaining.push(message)
        continue
      }
      const result = this.#deliverer ? await this.#deliverer.deliver(message) : { delivered: false }
      if (result.delivered) delivered += 1
      else remaining.push(message)
    }

    if (remaining.length === 0) this.#pendingInjection.delete(sessionID)
    else this.#pendingInjection.set(sessionID, remaining)
    return delivered
  }

  /**
   * A queued injection may only reach a session that is still provably inside
   * this location's scope. Unknown locations pass (they were in scope when the
   * message was queued, and an event may simply be missing); a provably
   * different project or directory is refused.
   */
  #deliverable(target: Peer): boolean {
    if (this.options.scope === "server") return true
    if (this.options.scope === "project") {
      const selfProject = this.#defaults.projectID
      return selfProject === undefined || target.projectID === undefined || target.projectID === selfProject
    }
    const selfDirectory = this.#defaults.directory
    return selfDirectory === undefined || target.directory === undefined || target.directory === selfDirectory
  }

  /** Messages still waiting to be injected into a session's live turn. */
  pendingInjectionCount(sessionID: string): number {
    return this.#pendingInjection.get(sessionID)?.length ?? 0
  }

  #queuePending(message: CrosstalkMessage): void {
    const queue = this.#pendingInjection.get(message.to) ?? []
    // Bounded: a recipient that never opens a tool call must not grow the
    // server's memory without limit. Oldest queued injection goes first.
    while (queue.length >= 50) queue.shift()
    queue.push(message)
    this.#pendingInjection.set(message.to, queue)
  }

  #resolveTargets(selfID: string, input: SendInput): { recipients: string[]; skipped: SendOutcome["skipped"] } {
    const skipped: SendOutcome["skipped"] = []
    if (input.all) {
      // `all` reaches every peer inside the communication wall; a session
      // whose project cannot be proven is never on the distribution list.
      return {
        recipients: this.registry.list(this.#filter(selfID, { strict: true })).map((p) => p.sessionID),
        skipped,
      }
    }
    if (input.to) {
      const target = input.to.trim()
      if (target === "") {
        skipped.push({ target: "(empty)", reason: "no session id given" })
        return { recipients: [], skipped }
      }
      if (target === selfID) {
        skipped.push({ target, reason: "that is you" })
        return { recipients: [], skipped }
      }
      if (this.registry.get(target)) {
        if (!this.#visible(selfID, target)) {
          skipped.push({ target, reason: `outside the ${this.options.scope} scope` })
          return { recipients: [], skipped }
        }
        return { recipients: [target], skipped }
      }
      // Not a session id: try a declared human name, case-insensitively,
      // among addressable peers only — names never cross the wall.
      const wanted = target.toLowerCase()
      const byName = this.registry
        .list(this.#filter(selfID, { strict: true }))
        .filter((peer) => peer.declared?.name?.toLowerCase() === wanted)
        .map((peer) => peer.sessionID)
      if (byName.length === 1) return { recipients: [byName[0] as string], skipped }
      if (byName.length > 1) {
        skipped.push({ target, reason: `"${target}" is claimed by ${byName.length} sessions; use a session id` })
        return { recipients: [], skipped }
      }
      skipped.push({ target, reason: "session unknown; check crosstalk_peers for session ids and names" })
      return { recipients: [], skipped }
    }
    if (input.role) {
      const wanted = input.role.trim().toLowerCase()
      const matches = this.registry
        .list(this.#filter(selfID, { strict: true }))
        .filter((peer) => peer.declared?.role?.toLowerCase() === wanted)
        .map((peer) => peer.sessionID)
      if (matches.length === 0) skipped.push({ target: `role:${input.role}`, reason: "no peer declared that role" })
      return { recipients: matches, skipped }
    }
    skipped.push({ target: "(none)", reason: "give to, role, or all" })
    return { recipients: [], skipped }
  }

  /**
   * True when `target` is a peer this session may address: provably within the
   * configured scope. An unknown location is a refusal, not a maybe.
   */
  #visible(selfID: string, target: string): boolean {
    const peer = this.registry.get(target)
    return peer !== undefined && this.#inScope(selfID, peer)
  }

  /**
   * The communication wall. `scope: "server"` has no wall; otherwise the peer
   * must carry a location that provably equals the caller's — a session whose
   * project (or directory) is unknown cannot be messaged or waited on.
   */
  #inScope(selfID: string, peer: Peer): boolean {
    const scope = this.options.scope
    if (peer.sessionID === selfID || scope === "server") return true
    const projectID = this.registry.get(selfID)?.projectID ?? this.#defaults.projectID
    if (scope === "project") return projectID !== undefined && peer.projectID === projectID
    const directory = this.registry.get(selfID)?.directory ?? this.#defaults.directory
    return directory !== undefined && peer.directory === directory
  }

  /** Read, optionally block for, and optionally ack the caller's mail. */
  async inbox(selfID: string, input: InboxInput, signal?: AbortSignal): Promise<InboxOutcome> {
    this.ensureSelf(selfID)
    const waitMs = Math.min(Math.max(0, input.waitMs ?? 0), this.options.maxWaitMs)

    let messages: CrosstalkMessage[]
    let reason: InboxOutcome["reason"] = "immediate"
    if (waitMs > 0) {
      const result = await this.mailbox.wait(selfID, waitMs, signal)
      messages = result.messages
      reason = result.reason
      if (reason === "messages") {
        // Re-read through the caller's filters; `wait` only filtered unread.
        messages = this.mailbox.list(selfID, input)
      }
    } else {
      messages = this.mailbox.list(selfID, input)
    }

    // Counted before acknowledging, so the header can say how much was unread
    // even though this call is about to mark it read.
    const unreadBefore = messages.filter((message) => message.readAt === undefined).length
    const marked = input.markRead === false ? 0 : this.mailbox.markRead(selfID, messages.map((m) => m.id))
    return {
      messages,
      reason,
      marked,
      unread: this.mailbox.unreadCount(selfID),
      unreadBefore,
    }
  }

  /** Lease bookkeeping for the caller's session. */
  claims_for(selfID: string): ClaimResult {
    return { outcome: emptyOutcome(), held: this.claims.list({ holder: selfID }), ttlMs: this.#claimsExpiry(selfID) }
  }

  claim(selfID: string, input: ClaimInput): ClaimResult {
    this.ensureSelf(selfID)
    const baseDir = this.directoryOf(selfID)
    const ttlMs = Math.min(Math.max(1, input.ttlMs ?? this.options.claimTtlMs), 86_400_000)
    const resources = (input.resources ?? []).filter((r) => r.trim() !== "")

    let outcome: ClaimOutcome
    switch (input.action) {
      case "claim":
        outcome = this.claims.claim({
          holder: selfID,
          resources,
          ttlMs,
          baseDir,
          ...(input.note ? { note: input.note } : {}),
          ...(input.force !== undefined ? { force: input.force } : {}),
          ...(input.atomic !== undefined ? { atomic: input.atomic } : {}),
        })
        break
      case "renew":
        outcome = this.claims.renew({
          holder: selfID,
          resources,
          ttlMs,
          baseDir,
          ...(input.note ? { note: input.note } : {}),
          ...(input.atomic !== undefined ? { atomic: input.atomic } : {}),
        })
        break
      case "release":
        outcome = this.claims.release({
          holder: selfID,
          resources,
          baseDir,
          ...(input.force !== undefined ? { force: input.force } : {}),
        })
        break
      case "list": {
        const held = this.claims.list({
          holder: selfID,
          baseDir,
          ...(input.includeExpired ? { includeExpired: true } : {}),
        })
        return { outcome: emptyOutcome(), held, ttlMs }
      }
    }

    return { outcome, held: this.claims.list({ holder: selfID }), ttlMs }
  }

  #claimsExpiry(selfID: string): number {
    const held = this.claims.list({ holder: selfID })
    const soonest = held.reduce((min, claim) => Math.min(min, claim.expires), Number.POSITIVE_INFINITY)
    return Number.isFinite(soonest) ? Math.max(0, soonest - this.#clock.now()) : this.options.claimTtlMs
  }

  /** Block until a peer stops being busy, disappears, or the wait expires. */
  async waitForPeerIdle(
    selfID: string,
    target: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<PeerIdleResult> {
    const start = this.#clock.now()
    const limit = Math.min(Math.max(0, timeoutMs), this.options.maxWaitMs)
    if (target === selfID) return { reason: "gone", elapsedMs: 0 }

    const peer = this.registry.get(target)
    if (!peer) return { reason: "gone", elapsedMs: 0 }
    // Waiting on a peer is communication: the wall applies. A session outside
    // the scope resolves at once instead of blocking until the timeout.
    if (!this.#inScope(selfID, peer)) return { reason: "outside", elapsedMs: 0, status: peer.status }

    for (;;) {
      if (peer.status === "idle" || peer.status === "unknown") {
        return { reason: "done", elapsedMs: this.#clock.now() - start, status: peer.status }
      }
      if (this.#clock.now() - start >= limit) {
        return { reason: signal?.aborted ? "aborted" : "timeout", elapsedMs: this.#clock.now() - start, status: peer.status }
      }
      await delay(this.options.pollMs, signal)
      if (signal?.aborted) return { reason: "aborted", elapsedMs: this.#clock.now() - start }
      const current = this.registry.get(target)
      if (!current) return { reason: "gone", elapsedMs: this.#clock.now() - start }
      if (!this.#inScope(selfID, current)) return { reason: "outside", elapsedMs: this.#clock.now() - start, status: current.status }
      if (current.status === "idle" || current.status === "unknown") {
        return { reason: "done", elapsedMs: this.#clock.now() - start, status: current.status }
      }
    }
  }

  /** Block until a resource has no live lease. */
  async waitForClaimFree(
    _selfID: string,
    resource: string,
    timeoutMs: number,
    baseDir?: string,
    signal?: AbortSignal,
  ): Promise<ClaimFreeResult> {
    const start = this.#clock.now()
    const limit = Math.min(Math.max(0, timeoutMs), this.options.maxWaitMs)
    const key = this.claims.normalize(resource, baseDir)
    const holderOf = (): string | undefined => {
      const claim = this.claims.list({ resource: key, includeExpired: true })[0]
      if (!claim || claim.expires <= this.#clock.now()) return undefined
      return claim.holder
    }

    for (;;) {
      const holder = holderOf()
      if (holder === undefined) return { reason: "done", elapsedMs: this.#clock.now() - start }
      if (this.#clock.now() - start >= limit) {
        return {
          reason: signal?.aborted ? "aborted" : "timeout",
          elapsedMs: this.#clock.now() - start,
          holder,
        }
      }
      await delay(this.options.pollMs, signal)
      if (signal?.aborted) return { reason: "aborted", elapsedMs: this.#clock.now() - start, holder }
    }
  }

  /** Serializable state. Messages are intentionally left out. */
  snapshot(): MeshSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      savedAt: this.#clock.now(),
      peers: [...this.registry.list({ scope: "server" })].map((peer) => ({ ...peer })),
      claims: this.claims.entries().map((claim) => ({ ...claim })),
    }
  }

  /**
   * Merge a snapshot back in. A session the live stream has already created
   * keeps its freshness and only receives fields the stream never carried
   * (declarations, project, directory); a session the registry has not seen is
   * restored wholesale. Restored claims are dropped when the same key is
   * already held.
   */
  restore(snapshot: MeshSnapshot): void {
    for (const peer of snapshot.peers) {
      if (!peer || typeof peer.sessionID !== "string") continue
      const live = this.registry.get(peer.sessionID)
      if (live) {
        if (live.title === undefined && peer.title !== undefined) live.title = peer.title
        if (live.agent === undefined && peer.agent !== undefined) live.agent = peer.agent
        if (live.model === undefined && peer.model !== undefined) live.model = peer.model
        if (live.parentID === undefined && peer.parentID !== undefined) live.parentID = peer.parentID
        if (live.projectID === undefined && peer.projectID !== undefined) live.projectID = peer.projectID
        if (live.directory === undefined && peer.directory !== undefined) live.directory = peer.directory
        if (live.created === undefined && peer.created !== undefined) live.created = peer.created
        if (live.declared === undefined && peer.declared !== undefined) live.declared = peer.declared
        continue
      }
      const restored = this.registry.ensure(peer.sessionID)
      restored.status = peer.status ?? "unknown"
      restored.lastSeen = typeof peer.lastSeen === "number" ? peer.lastSeen : this.#clock.now()
      if (peer.title !== undefined) restored.title = peer.title
      if (peer.agent !== undefined) restored.agent = peer.agent
      if (peer.model !== undefined) restored.model = peer.model
      if (peer.parentID !== undefined) restored.parentID = peer.parentID
      if (peer.projectID !== undefined) restored.projectID = peer.projectID
      if (peer.directory !== undefined) restored.directory = peer.directory
      if (peer.created !== undefined) restored.created = peer.created
      if (peer.declared !== undefined) restored.declared = peer.declared
    }
    const held = new Set(this.claims.entries().map((claim) => claim.key))
    for (const claim of snapshot.claims) {
      if (!claim || typeof claim.key !== "string" || held.has(claim.key)) continue
      if (claim.expires <= this.#clock.now()) continue
      this.claims.adopt(claim)
    }
  }
}

function emptyOutcome(): ClaimOutcome {
  return { claimed: [], renewed: [], released: [], stolen: [], conflicts: [], rolledBack: false }
}

function sessionIDOrThrow(sessionID: string): string {
  if (typeof sessionID !== "string" || sessionID === "") {
    throw new Error("crosstalk: session id is required")
  }
  return sessionID
}
