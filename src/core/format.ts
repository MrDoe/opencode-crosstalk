/**
 * @fileoverview Agent-facing rendering.
 *
 * Tool output is the only thing an agent sees, so these strings are part of
 * the plugin's contract: compact, stable, and free of absolute paths the model
 * cannot act on. Tests assert exact output, which is deliberate — a silent
 * format change would degrade coordination without failing anything.
 */

import type { ClaimOutcome, CrosstalkMessage, PeerView, Scope } from "../types.ts"

/** Compact relative age, e.g. `4s`, `12m`, `3h`. */
export function relativeAge(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** Trim a long value for one-line display. */
export function ellipsis(value: string, max: number): string {
  const flat = value.replaceAll(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

/**
 * A summary younger than this is current. The peer line annotates its age only
 * once a session has stopped refreshing it: a running session's live status
 * needs no timestamp to be trusted, and every peer line paying for a clock it
 * does not need is noise.
 */
export const SUMMARY_FRESH_MS = 5 * 60_000

/**
 * A summary older than this is *stale*: the sidebar already dims it (see
 * `STALE_SUMMARY_MS` in `src/tui/avatar.ts`, which mirrors this value on
 * purpose — the dim the user sees and the nudge the agent gets should land
 * together), and the declaring session is told to refresh it.
 */
export const SUMMARY_STALE_MS = 15 * 60_000

/**
 * How long ago the peer declared its summary — ` (14m ago)`, or an empty
 * string while it is fresh, missing (declared before the feature, or restored
 * from a snapshot that predates it), or clock-skewed into the future. The
 * window is closed at the boundary: exactly `SUMMARY_FRESH_MS` is still fresh,
 * one millisecond past it is not — the same convention as the dim rule in
 * `src/tui/avatar.ts`.
 */
function summaryAge(peer: PeerView, now: number): string {
  const at = peer.declared?.summaryAt
  if (at === undefined || now - at <= SUMMARY_FRESH_MS) return ""
  return ` (${relativeAge(at, now)} ago)`
}

function peerLine(peer: PeerView, now: number, scope: Scope): string {
  const parts = [`- ${peer.sessionID}`]
  if (peer.declared?.name) parts.push(`(${ellipsis(peer.declared.name, 32)})`)
  if (peer.isSelf) parts.push("(you)")
  parts.push(peer.stale ? `${peer.status}?` : peer.status)
  if (peer.declared?.role) parts.push(`role=${ellipsis(peer.declared.role, 24)}`)
  if (peer.declared?.goal) parts.push(`goal="${ellipsis(peer.declared.goal, 60)}"`)
  // The self view prints role → goal → summary; keep a peer's line in the same
  // order, with the summary's age once it stops being fresh.
  if (peer.declared?.summary) {
    parts.push(`summary="${ellipsis(peer.declared.summary, 60)}"${summaryAge(peer, now)}`)
  }
  if (peer.title) parts.push(`"${ellipsis(peer.title, 48)}"`)
  if (peer.agent) parts.push(peer.agent)
  parts.push(`active ${relativeAge(peer.lastSeen, now)} ago`)
  if (peer.unread > 0) parts.push(`unread ${peer.unread}`)
  if (peer.claims.length > 0) parts.push(`claims ${peer.claims.join(", ")}`)
  if (!peer.addressable) parts.push(notAddressable(peer, scope))
  return parts.join("  ")
}

/** Why a listed peer cannot be messaged, shown on its line. */
function notAddressable(peer: PeerView, scope: Scope): string {
  return peer.projectID === undefined || peer.directory === undefined
    ? "location unknown — not addressable"
    : `outside the ${scope} scope — not addressable`
}

/**
 * Plugin health for the calling location, rendered as one diagnostic line so
 * install problems (double loads, lost snapshots) are visible to the model
 * without spelunking logs.
 */
export interface SelfCheck {
  /** Snapshot format this build writes and restores, e.g. `v2`. */
  snapshot: string
  /** Mesh storage key; only meaningful when `persist` is true. */
  storageKey?: string
  /** False when persistence is off: nothing survives a restart. */
  persist: boolean
  /** Locations the live plugin instances in this process own. Absent when unknown. */
  locations?: number
}

export interface StatusViewInput {
  self: PeerView
  peers: PeerView[]
  scope: Scope
  now: number
  hints?: string[]
  selfCheck?: SelfCheck
}

export function formatStatus(input: StatusViewInput): string {
  const { self, peers, now } = input
  const lines: string[] = []
  const header = [`crosstalk: you are ${self.sessionID}`]
  if (self.declared?.name) header.push(`(${ellipsis(self.declared.name, 32)})`)
  if (self.agent) header.push(`(${self.agent})`)
  header.push(self.stale ? `${self.status}?` : self.status)
  lines.push(header.join(" "))

  if (self.title) lines.push(`  session: ${ellipsis(self.title, 72)}`)
  if (self.declared?.role) lines.push(`  role: ${self.declared.role}`)
  if (self.declared?.goal) lines.push(`  goal: ${self.declared.goal}`)
  // The own record annotates the summary by the same rule as a peer's line:
  // silent while fresh, explicit once it is worth re-reading before trusting.
  if (self.declared?.summary) {
    lines.push(`  summary: ${self.declared.summary}${summaryAge(self, now)}`)
  }
  if (self.declared?.workingOn && self.declared.workingOn.length > 0) {
    lines.push(`  working on: ${self.declared.workingOn.join(", ")}`)
  }
  if (self.claims.length > 0) lines.push(`  your claims: ${self.claims.join(", ")}`)

  if (input.selfCheck) {
    const check = input.selfCheck
    const parts = [`snapshot ${check.snapshot}`]
    if (check.persist && check.storageKey !== undefined) parts.push(`storage ${check.storageKey}`)
    if (!check.persist) parts.push("persistence off")
    if (check.locations !== undefined) parts.push(`${check.locations} location${check.locations === 1 ? "" : "s"} owned`)
    lines.push(`  self-check: ${parts.join(" · ")}`)
  }

  const running = peers.filter((p) => p.status === "running").length
  const idle = peers.filter((p) => p.status === "idle").length
  const stale = peers.filter((p) => p.stale).length
  const counts = [`${peers.length} peer${peers.length === 1 ? "" : "s"}`, `${running} running`, `${idle} idle`]
  if (stale > 0) counts.push(`${stale} stale`)
  lines.push(`  peers on this channel (${input.scope}): ${counts.join(", ")}`)
  for (const peer of peers) lines.push(`    ${peerLine(peer, now, input.scope)}`)
  if (peers.length === 0) {
    lines.push("    (none — you are the only session here; crosstalk_wait will just time out)")
  }
  for (const hint of input.hints ?? []) lines.push(`  ${hint}`)
  return lines.join("\n")
}

export interface PeersViewInput {
  self: PeerView
  peers: PeerView[]
  scope: Scope
  now: number
  /**
   * Set when the caller asked for an overlap filter. The `paths` are echoed in
   * the header and in the empty answer, so the model sees what the filter was
   * about; `considered` is how many peers the channel held before the filter
   * narrowed them, which distinguishes "nobody is here" from "nobody overlaps".
   */
  overlap?: { paths: readonly string[]; considered: number }
}

export function formatPeers(input: PeersViewInput): string {
  const { peers, now } = input
  const lines: string[] = []
  // The paths are echoed so an empty answer still says what the filter was about.
  const paths = input.overlap ? ellipsis(input.overlap.paths.join(", "), 120) : ""
  if (peers.length === 0) {
    if (input.overlap) {
      const others = input.overlap.considered
      return [
        `crosstalk: no peers overlap ${paths} (scope ${input.scope}).`,
        others > 0
          ? `${others} other session${others === 1 ? "" : "s"} on this channel, but none leases or works on those exact` +
            " paths — you do not need to claim anything."
          : "Nobody else is on this channel, so nothing can overlap — you do not need to claim anything.",
      ].join("\n")
    }
    return [
      `crosstalk: no other sessions on this channel (scope ${input.scope}).`,
      "Nobody is competing for files right now; you do not need to claim anything.",
    ].join("\n")
  }
  const running = peers.filter((p) => p.status === "running").length
  lines.push(
    `crosstalk peers (scope ${input.scope}, ${peers.length} found, ${running} running${input.overlap ? `, overlap ${paths}` : ""}):`,
  )
  const you = [`you: ${input.self.sessionID}`]
  if (input.self.declared?.name) you.push(`(${ellipsis(input.self.declared.name, 32)})`)
  you.push(input.self.status)
  you.push(input.self.declared?.role ? `role=${input.self.declared.role}` : "role=undeclared")
  lines.push(`  ${you.join("  ")}`)
  for (const peer of peers) lines.push(`  ${peerLine(peer, now, input.scope)}`)
  return lines.join("\n")
}

export interface MessageViewInput {
  message: CrosstalkMessage
  now: number
}

export function formatMessage(input: MessageViewInput): string {
  const { message, now } = input
  const parts = [`from ${message.from}`]
  if (message.fromName) parts.push(`(${message.fromName})`)
  if (message.fromRole) parts.push(`(${message.fromRole})`)
  parts.push(`· ${message.kind}`)
  if (message.topic) parts.push(`· topic ${message.topic}`)
  parts.push(`· ${relativeAge(message.created, now)} ago`)
  return parts.join(" ")
}

export interface InboxViewInput {
  self: PeerView
  messages: CrosstalkMessage[]
  marked: number
  now: number
  reason?: "messages" | "timeout" | "aborted" | "immediate"
  limit?: number
  /** Unread count observed *before* this call marked anything read. */
  unread?: number
}

export function formatInbox(input: InboxViewInput): string {
  const { messages, now } = input
  const lines: string[] = []
  const unread = input.unread ?? input.self.unread
  const head = `crosstalk inbox for ${input.self.sessionID}: ${messages.length} message${messages.length === 1 ? "" : "s"}`
  if (unread > 0) lines.push(`${head} (${unread} unread)`)
  else lines.push(head)

  if (messages.length === 0) {
    if (input.reason === "timeout") lines.push("  nothing arrived before the wait expired")
    else if (input.reason === "aborted") lines.push("  wait cancelled before a message arrived")
    else lines.push("  empty")
    return lines.join("\n")
  }

  for (const message of messages) {
    lines.push(`  [${message.id}] ${formatMessage({ message, now })}`)
    for (const line of message.text.split("\n")) lines.push(`      ${line}`)
    if (message.kind === "request") {
      lines.push(`      ↳ answer with crosstalk_send to ${message.fromName ?? message.from}`)
    }
  }
  if (input.limit !== undefined && messages.length >= input.limit) {
    lines.push(`  (showing the most recent ${input.limit}; raise the limit for more)`)
  }
  if (input.marked > 0) lines.push(`  marked ${input.marked} message${input.marked === 1 ? "" : "s"} read`)
  return lines.join("\n")
}

export interface SendViewInput {
  self: PeerView
  recipients: Array<{ sessionID: string; delivered: boolean; reason?: string }>
  skipped: Array<{ target: string; reason: string }>
  text: string
  now: number
}

export function formatSend(input: SendViewInput): string {
  const lines: string[] = []
  const delivered = input.recipients.filter((r) => r.delivered).length
  const queued = input.recipients.length - delivered
  const head = `crosstalk: signalled ${input.recipients.length} session${input.recipients.length === 1 ? "" : "s"}`
  lines.push(`${head} (${delivered} delivered now, ${queued} queued in mailbox)`)

  for (const recipient of input.recipients) {
    lines.push(
      recipient.delivered
        ? `  ✓ ${recipient.sessionID}`
        : `  · ${recipient.sessionID} — queued only${recipient.reason ? `: ${recipient.reason}` : ""}`,
    )
  }
  for (const skip of input.skipped) lines.push(`  - ${skip.target}: ${skip.reason}`)
  if (input.skipped.length === 0 && input.recipients.length === 0) {
    lines.push("  no matching peers — check crosstalk_peers, or send with all: true")
  }
  lines.push(`  message: ${ellipsis(input.text, 160)}`)
  return lines.join("\n")
}

export interface ClaimViewInput {
  self: PeerView
  outcome: ClaimOutcome
  ttlMs: number
  now: number
  held: Array<{ key: string; expires: number; note?: string }>
}

export function formatClaims(input: ClaimViewInput): string {
  const { outcome, now } = input
  const lines: string[] = []

  if (outcome.conflicts.length > 0) {
    lines.push(
      `crosstalk claim: refused — ${outcome.conflicts.length} resource${outcome.conflicts.length === 1 ? "" : "s"} already leased`,
    )
    for (const conflict of outcome.conflicts) {
      const who = conflict.holder || "unknown"
      const note = conflict.note ? ` (${conflict.note})` : ""
      const expires = conflict.expires > 0 ? `, free in ${relativeAge(now, conflict.expires)}` : ""
      lines.push(`  - ${conflict.raw} held by ${who}${note}${expires}`)
    }
    lines.push("  wait for them with crosstalk_wait, signal them with crosstalk_send, or pass force: true to steal.")
    if (outcome.rolledBack) lines.push("  nothing was claimed (atomic request).")
    return lines.join("\n")
  }

  const acquired = outcome.claimed.length
  const renewed = outcome.renewed.length
  const released = outcome.released.length
  const stolen = outcome.stolen.length
  const parts: string[] = []
  if (acquired > 0) parts.push(`${acquired} claimed`)
  if (renewed > 0) parts.push(`${renewed} renewed`)
  if (released > 0) parts.push(`${released} released`)
  if (stolen > 0) parts.push(`${stolen} stolen from another session`)
  lines.push(`crosstalk claim: ${parts.length > 0 ? parts.join(", ") : "nothing to do"}`)

  for (const key of outcome.claimed) lines.push(`  + ${key}  (lease ${Math.round(input.ttlMs / 1000)}s)`)
  for (const key of outcome.renewed) lines.push(`  ~ ${key}`)
  for (const key of outcome.released) lines.push(`  - ${key}  released`)

  if (input.held.length > 0) {
    lines.push("  you currently hold:")
    for (const claim of input.held) {
      const note = claim.note ? ` (${claim.note})` : ""
      lines.push(`    ${claim.key}  expires in ${relativeAge(now, claim.expires)}${note}`)
    }
  } else {
    lines.push("  you hold no leases")
  }
  return lines.join("\n")
}

export interface WaitViewInput {
  forWhat: "peer_idle" | "claim_free"
  reason: WaitReasonLike
  elapsedMs: number
  detail?: string
}

type WaitReasonLike = "done" | "timeout" | "aborted" | "gone" | "outside"

export function formatWait(input: WaitViewInput): string {
  const lines: string[] = []
  const what = input.forWhat === "peer_idle" ? "peer idle" : "claim free"
  const seconds = Math.round(input.elapsedMs / 100) / 10
  if (input.reason === "done") {
    lines.push(`crosstalk wait: ${what} after ${seconds}s${input.detail ? ` — ${input.detail}` : ""}`)
    return lines.join("\n")
  }
  if (input.reason === "gone") {
    lines.push(`crosstalk wait: ${input.detail ?? "target is gone"} after ${seconds}s`)
    return lines.join("\n")
  }
  if (input.reason === "outside") {
    lines.push(`crosstalk wait: ${input.detail ?? "target is outside the communication scope"} after ${seconds}s`)
    return lines.join("\n")
  }
  if (input.reason === "aborted") {
    lines.push(`crosstalk wait: cancelled after ${seconds}s while waiting for ${what}`)
    return lines.join("\n")
  }
  lines.push(
    `crosstalk wait: timed out after ${seconds}s waiting for ${what}${input.detail ? ` — ${input.detail}` : ""}`,
  )
  return lines.join("\n")
}
