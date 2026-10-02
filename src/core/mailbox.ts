/**
 * @fileoverview Per-session mailboxes with unread tracking and long-poll
 * wakeups.
 *
 * Every send fans out one message copy per recipient, so a broadcast is just a
 * send to several session IDs and each mailbox stays independently readable
 * and ackable. Delivery into a live session is a host concern (see
 * `src/deliverer.ts`); a message that cannot be injected right now still sits
 * in the mailbox and is picked up by the next `crosstalk_inbox`.
 */

import type { CrosstalkMessage, Delivery, MessageKind } from "../types.ts"

export interface MailboxOptions {
  now(): number
  /** Retained messages per session. */
  maxPerSession: number
  /** Messages older than this are pruned on write and on read. */
  ttlMs: number
  /** Injectable for deterministic IDs in tests. */
  idFactory?(seq: number): string
}

export interface SendInput {
  from: string
  fromName?: string
  fromRole?: string
  to: readonly string[]
  text: string
  topic?: string
  kind?: MessageKind
  delivery?: Delivery
  meta?: Record<string, unknown>
}

export interface ListOptions {
  unreadOnly?: boolean
  topic?: string
  limit?: number
  /** Return messages strictly after this ID. */
  since?: string
}

export type WaitReason = "messages" | "timeout" | "aborted"

export interface WaitResult {
  messages: CrosstalkMessage[]
  reason: WaitReason
}

interface Waiter {
  resolve(result: WaitResult): void
  timer: ReturnType<typeof setTimeout> | undefined
  onAbort: (() => void) | undefined
  signal: AbortSignal | undefined
}

export class Mailbox {
  readonly #boxes = new Map<string, CrosstalkMessage[]>()
  readonly #waiters = new Map<string, Set<Waiter>>()
  readonly #now: () => number
  readonly #max: number
  readonly #ttlMs: number
  readonly #idFactory: (seq: number) => string
  #seq = 0

  constructor(options: MailboxOptions) {
    this.#now = options.now
    this.#max = Math.max(1, options.maxPerSession)
    this.#ttlMs = Math.max(1, options.ttlMs)
    this.#idFactory = options.idFactory ?? ((seq) => `msg-${seq.toString(36)}`)
  }

  get size(): number {
    let total = 0
    for (const box of this.#boxes.values()) total += box.length
    return total
  }

  /** Append one copy per recipient and wake anyone blocked on that mailbox. */
  send(input: SendInput): CrosstalkMessage[] {
    const created = this.#now()
    const delivered: CrosstalkMessage[] = []
    for (const to of input.to) {
      this.#seq += 1
      const message: CrosstalkMessage = {
        id: this.#idFactory(this.#seq),
        seq: this.#seq,
        from: input.from,
        fromName: input.fromName,
        fromRole: input.fromRole,
        to,
        text: input.text,
        topic: input.topic,
        kind: input.kind ?? "message",
        delivery: input.delivery ?? "steer",
        created,
        meta: input.meta,
      }
      this.#push(to, message)
      delivered.push(message)
    }
    return delivered
  }

  /** Messages for a session, newest last. Prunes expired entries first. */
  list(sessionID: string, options: ListOptions = {}): CrosstalkMessage[] {
    this.#pruneBox(sessionID)
    let messages = [...(this.#boxes.get(sessionID) ?? [])]
    if (options.unreadOnly) messages = messages.filter((m) => m.readAt === undefined)
    if (options.topic !== undefined) messages = messages.filter((m) => m.topic === options.topic)
    if (options.since !== undefined) {
      const index = messages.findIndex((m) => m.id === options.since)
      // Unknown cursor: treat as "give me everything" rather than nothing.
      messages = index >= 0 ? messages.slice(index + 1) : messages
    }
    if (options.limit !== undefined && options.limit >= 0 && messages.length > options.limit) {
      messages = messages.slice(messages.length - options.limit)
    }
    return messages
  }

  unreadCount(sessionID: string): number {
    this.#pruneBox(sessionID)
    return (this.#boxes.get(sessionID) ?? []).filter((m) => m.readAt === undefined).length
  }

  hasUnread(sessionID: string): boolean {
    return this.unreadCount(sessionID) > 0
  }

  /**
   * Mark messages read. With no IDs, marks everything currently unread.
   * Returns the number of messages transitioned to read.
   */
  markRead(sessionID: string, ids?: readonly string[]): number {
    const box = this.#boxes.get(sessionID)
    if (!box) return 0
    const wanted = ids ? new Set(ids) : undefined
    const at = this.#now()
    let marked = 0
    for (const message of box) {
      if (message.readAt !== undefined) continue
      if (wanted && !wanted.has(message.id)) continue
      message.readAt = at
      marked += 1
    }
    return marked
  }

  clear(sessionID: string): void {
    this.#boxes.delete(sessionID)
  }

  /** Drop expired messages everywhere. Returns how many were removed. */
  prune(): number {
    let removed = 0
    for (const sessionID of [...this.#boxes.keys()]) {
      removed += this.#pruneBox(sessionID)
    }
    return removed
  }

  /**
   * Resolve as soon as the mailbox holds an unread message, otherwise after
   * `timeoutMs`. Never rejects: an aborted or expired wait resolves with an
   * empty list and the reason, so tool executors can report it plainly.
   */
  async wait(sessionID: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    if (signal?.aborted) return { messages: [], reason: "aborted" }
    const pending = this.list(sessionID, { unreadOnly: true })
    if (pending.length > 0) return { messages: pending, reason: "messages" }

    return new Promise<WaitResult>((resolve) => {
      const waiter: Waiter = { resolve, timer: undefined, onAbort: undefined, signal }
      const finish = (reason: WaitReason) => {
        const set = this.#waiters.get(sessionID)
        set?.delete(waiter)
        if (set && set.size === 0) this.#waiters.delete(sessionID)
        if (waiter.timer !== undefined) clearTimeout(waiter.timer)
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort)
        resolve({ messages: reason === "messages" ? this.list(sessionID, { unreadOnly: true }) : [], reason })
      }
      waiter.resolve = (result) => finish(result.reason)

      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          waiter.resolve({ messages: [], reason: "timeout" })
        }, timeoutMs)
      }
      if (signal) {
        waiter.onAbort = () => waiter.resolve({ messages: [], reason: "aborted" })
        signal.addEventListener("abort", waiter.onAbort, { once: true })
      }

      const set = this.#waiters.get(sessionID) ?? new Set<Waiter>()
      set.add(waiter)
      this.#waiters.set(sessionID, set)
    })
  }

  #push(sessionID: string, message: CrosstalkMessage): void {
    const box = this.#boxes.get(sessionID) ?? []
    this.#pruneBox(sessionID)
    box.push(message)
    // Evict the oldest already-read message; fall back to the oldest overall
    // only when everything is unread, so a burst never silently drops mail the
    // agent has not seen.
    const index = box.findIndex((m) => m.readAt !== undefined)
    const at = index >= 0 ? index : 0
    while (box.length > this.#max) box.splice(at, 1)
    this.#boxes.set(sessionID, box)
    this.#wake(sessionID)
  }

  #wake(sessionID: string): void {
    const set = this.#waiters.get(sessionID)
    if (!set || set.size === 0) return
    for (const waiter of [...set]) {
      waiter.resolve({ messages: [], reason: "messages" })
    }
  }

  #pruneBox(sessionID: string): number {
    const box = this.#boxes.get(sessionID)
    if (!box || box.length === 0) return 0
    const cutoff = this.#now() - this.#ttlMs
    let removed = 0
    for (let index = box.length - 1; index >= 0; index -= 1) {
      const message = box[index]
      if (message && message.created < cutoff) {
        box.splice(index, 1)
        removed += 1
      }
    }
    if (box.length === 0) this.#boxes.delete(sessionID)
    return removed
  }
}
