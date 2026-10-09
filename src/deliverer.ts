/**
 * @fileoverview Delivery of crosstalk messages into live sessions.
 *
 * A mailbox entry alone would not reach an agent that is mid-task, so each
 * message is also injected into the recipient's session with
 * `ctx.session.synthetic` — a durable, non-user message that does not masquerade
 * as something the human typed. `steer` (the default) folds it into the
 * recipient's current turn; `queue` waits for the turn to end.
 *
 * Delivery is best effort. A plugin instance belongs to one location, so
 * synthesizing into a session owned by another location can fail; the mailbox
 * copy is authoritative and the recipient sees the message on their next
 * `crosstalk_inbox`.
 */

import type { CrosstalkMessage } from "./types.ts"
import type { Deliverer } from "./core/mesh.ts"

/** Structural subset of `ctx.session`. */
export interface SessionLike {
  synthetic(input: {
    sessionID: string
    text: string
    description?: string
    delivery?: "steer" | "queue"
    metadata?: Record<string, unknown>
  }): Promise<unknown>
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "delivery failed"
}

/** The text injected into the recipient's session. */
export function renderDelivery(message: CrosstalkMessage): string {
  const lines: string[] = ["[crosstalk] another session on this project is talking to you."]
  const actor = `${message.from}${message.fromName ? ` (${message.fromName})` : ""}`
  if (message.fromRole) lines.push(`from ${actor} (${message.fromRole}) — ${message.kind}.`)
  else lines.push(`from ${actor} — ${message.kind}.`)
  if (message.topic) lines.push(`topic: ${message.topic}`)
  lines.push("")
  lines.push(message.text)
  lines.push("")
  // Only a `request` demands an answer. Steering every message manufactured
  // ack loops between polite sessions; `meta.requested` carries the sender's
  // role for context, it is not a reply demand.
  if (message.kind === "request") {
    lines.push(
      `This is a request: answer with crosstalk_send addressed to ${message.fromName ?? message.from}, then continue your task.`,
    )
  } else {
    lines.push("Read it with crosstalk_inbox when convenient; reply only if a reply is warranted.")
  }
  return lines.join("\n")
}

export function createSessionDeliverer(session: SessionLike): Deliverer {
  return {
    async deliver(message: CrosstalkMessage) {
      try {
        await session.synthetic({
          sessionID: message.to,
          text: renderDelivery(message),
          description: `crosstalk ${message.kind} from ${message.from}`,
          delivery: message.delivery,
          metadata: {
            crosstalk: {
              id: message.id,
              seq: message.seq,
              from: message.from,
              ...(message.fromName ? { fromName: message.fromName } : {}),
              fromRole: message.fromRole,
              kind: message.kind,
              ...(message.topic ? { topic: message.topic } : {}),
            },
          },
        })
        return { delivered: true }
      } catch (error) {
        return { delivered: false, reason: errorMessage(error) }
      }
    },
  }
}
