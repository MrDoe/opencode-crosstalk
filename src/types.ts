/**
 * @fileoverview Shared value types for the crosstalk mesh.
 *
 * Nothing in `src/core` imports an OpenCode package: the host adapter in
 * `src/index.ts` translates OpenCode events and tool calls into these plain
 * shapes, which keeps the coordination logic unit-testable in isolation.
 */

/** Coarse liveness of a peer session, derived from the server event stream. */
export type PeerStatus = "running" | "idle" | "unknown"

export type Scope = "project" | "location" | "server"

/** What a session told the mesh about itself through `crosstalk_status`. */
export interface Declared {
  /**
   * A unique human name chosen by the session, so the user can say "tell
   * George…" and peers can address it in `crosstalk_send`. Optional; the
   * session id stays the authoritative identity.
   */
  name?: string
  role?: string
  goal?: string
  /**
   * What the session is doing *right now*: one or two short sentences, kept
   * current as the work moves. Unlike `goal` — the overall objective, declared
   * once — this is the live status line shown under the avatar in the TUI
   * sidebar and read by peers through `crosstalk_peers`, so it is meant to be
   * re-declared whenever the task changes.
   */
  summary?: string
  /**
   * When `summary` was last declared, in ms. Refreshing any other declared
   * field leaves it alone, so it ages the *summary* rather than the
   * declaration. Absent for summaries restored from a snapshot written by an
   * older version — those are neither annotated nor dimmed, just shown.
   */
  summaryAt?: number
  workingOn?: string[]
  note?: string
  /**
   * Optional avatar hint (an emoji such as `👩` or `👨`) that steers which
   * character pool the portrait is drawn from. The concrete artwork is chosen
   * by the mesh on the session's first task-bearing declaration and then
   * frozen on the peer record — see `Peer.portrait`.
   */
  avatar?: string
  updatedAt?: number
}

/** One session the mesh knows about. */
export interface Peer {
  sessionID: string
  title?: string
  agent?: string
  /** Human readable `provider/model#variant` label. */
  model?: string
  parentID?: string
  projectID?: string
  directory?: string
  status: PeerStatus
  created?: number
  /** Timestamp of the most recent event seen for this session. */
  lastSeen: number
  declared?: Declared
  /**
   * Frozen portrait: `pool/file` inside `assets/avatars/`, assigned by the
   * mesh when the session first declares a task and never changed again —
   * re-declaring a different role, name, or avatar hint cannot move it.
   */
  portrait?: string
}

/** A peer enriched with mesh-derived state, as returned to tools. */
export interface PeerView extends Peer {
  isSelf: boolean
  /** No event for longer than the stale threshold. */
  stale: boolean
  unread: number
  claims: string[]
  /**
   * Provably within the configured communication scope. Only addressable
   * peers can be messaged or awaited; the rest are listed for visibility but
   * marked "not addressable".
   */
  addressable: boolean
}

export type MessageKind = "message" | "status" | "request" | "answer" | "system"

export type Delivery = "steer" | "queue"

/** A message delivered into one recipient's mailbox. */
export interface CrosstalkMessage {
  id: string
  seq: number
  from: string
  /** The sender's declared human name, stamped at send time. */
  fromName?: string
  fromRole?: string
  to: string
  text: string
  topic?: string
  kind: MessageKind
  delivery: Delivery
  created: number
  readAt?: number
  meta?: Record<string, unknown>
}

/** An exclusive lease on a path or named resource. */
export interface Claim {
  /** Normalized comparison key. */
  key: string
  /** The resource string as the holder wrote it. */
  raw: string
  holder: string
  note?: string
  acquired: number
  expires: number
}

export interface ClaimConflict {
  key: string
  raw: string
  holder: string
  note?: string
  expires: number
}

export interface ClaimOutcome {
  claimed: string[]
  renewed: string[]
  released: string[]
  stolen: string[]
  conflicts: ClaimConflict[]
  /** True when a single conflict aborted the whole request. */
  rolledBack: boolean
}

/** Serialized mesh state. Messages are intentionally not persisted. */
export interface MeshSnapshot {
  version: number
  savedAt: number
  peers: Peer[]
  claims: Claim[]
}
