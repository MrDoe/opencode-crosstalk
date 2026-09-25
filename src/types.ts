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
  role?: string
  goal?: string
  workingOn?: string[]
  note?: string
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
}

/** A peer enriched with mesh-derived state, as returned to tools. */
export interface PeerView extends Peer {
  isSelf: boolean
  /** No event for longer than the stale threshold. */
  stale: boolean
  unread: number
  claims: string[]
}

export type MessageKind = "message" | "status" | "request" | "answer" | "system"

export type Delivery = "steer" | "queue"

/** A message delivered into one recipient's mailbox. */
export interface CrosstalkMessage {
  id: string
  seq: number
  from: string
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
