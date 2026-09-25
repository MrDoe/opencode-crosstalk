/**
 * @fileoverview `crosstalk_inbox` — read and acknowledge mail from peers.
 */

import { formatInbox } from "../core/format.ts"
import { readBoolean, readNumber, readString } from "./args.ts"
import { clampWait, jsonSchema, run, startHeartbeat, type CrosstalkToolInfo, type ToolDeps } from "./types.ts"

export function inboxTool(deps: ToolDeps): CrosstalkToolInfo {
  return {
    name: "inbox",
    description: [
      "Read messages other sessions sent you. Set wait to block until something arrives (or the",
      "timeout expires) instead of returning an empty inbox — useful when you are waiting on a peer",
      "to finish. Messages are marked read unless you pass markRead: false.",
    ].join(" "),
    input: jsonSchema({
      type: "object",
      properties: {
        wait: {
          type: "number",
          description: "Seconds to block for a new message. 0 returns immediately. Capped by plugin config.",
        },
        limit: { type: "number", description: "Maximum messages to return (most recent, default 20)" },
        topic: { type: "string", description: "Only messages with this topic" },
        unreadOnly: { type: "boolean", description: "Skip messages you already read" },
        since: { type: "string", description: "Return only messages after this message ID" },
        markRead: { type: "boolean", description: "Mark the returned messages read (default true)" },
      },
      additionalProperties: false,
    }),
    async execute(input, context) {
      return run(async () => {
        const waitSeconds = readNumber(input, "wait", { min: 0, max: 600, fallback: 0 })
        const limit = readNumber(input, "limit", { min: 1, max: 200, fallback: 20 })
        const topic = readString(input, "topic", { max: 80 })
        const unreadOnly = readBoolean(input, "unreadOnly", false)
        const since = readString(input, "since", { max: 80 })
        const markRead = readBoolean(input, "markRead", true)
        const waitMs = clampWait((waitSeconds ?? 0) * 1000, deps.options)

        const stop = startHeartbeat(context, deps.options.heartbeatMs, () => ({
          status: "waiting",
          waitSeconds: Math.round(waitMs / 1000),
        }))
        let outcome
        try {
          outcome = await deps.mesh.inbox(
            context.sessionID,
            {
              waitMs,
              markRead,
              limit,
              ...(unreadOnly ? { unreadOnly: true } : {}),
              ...(topic ? { topic } : {}),
              ...(since ? { since } : {}),
            },
            context.signal,
          )
        } finally {
          stop()
        }

        return formatInbox({
          self: deps.mesh.view(context.sessionID),
          messages: outcome.messages,
          marked: outcome.marked,
          unread: outcome.unreadBefore,
          now: deps.mesh.now(),
          reason: outcome.reason,
          ...(limit !== undefined ? { limit } : {}),
        })
      })
    },
  }
}
