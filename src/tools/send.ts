/**
 * @fileoverview `crosstalk_send` — talk to another session.
 */

import { formatSend } from "../core/format.ts"
import { readBoolean, readEnum, readString } from "./args.ts"
import { jsonSchema, run, type CrosstalkToolInfo, type ToolDeps } from "./types.ts"

export function sendTool(deps: ToolDeps): CrosstalkToolInfo {
  return {
    name: "send",
    description: [
      "Send a message to another OpenCode session on this channel. The message is stored in the",
      "recipient's mailbox and, when possible, injected into their running session so they see it",
      "without waiting. Address it to a sessionID, to everyone with a declared role, or to all peers.",
      "Give one reason per message and say what you need back; the recipient replies with crosstalk_send.",
    ].join(" "),
    input: jsonSchema({
      type: "object",
      properties: {
        to: { type: "string", description: "Session ID of the recipient (see crosstalk_peers)" },
        role: { type: "string", description: "Send to every peer that declared this role" },
        all: { type: "boolean", description: "Send to every peer on this channel" },
        text: { type: "string", description: "The message body. Be specific about what you need." },
        topic: { type: "string", description: "Optional thread label, e.g. auth-refactor" },
        kind: {
          type: "string",
          enum: ["message", "status", "request", "answer", "system"],
          description: "Intent. 'request' expects a reply; 'answer' is a response to one.",
        },
        delivery: {
          type: "string",
          enum: ["steer", "queue"],
          description: "'steer' (default) folds into the recipient's current turn; 'queue' waits for it to end",
        },
        replyTo: { type: "string", description: "Message ID this answers" },
      },
      required: ["text"],
      additionalProperties: false,
    }),
    async execute(input, context) {
      return run(async () => {
        const text = readString(input, "text", { required: true, max: 8_000 })
        const to = readString(input, "to", { max: 200 })
        const role = readString(input, "role", { max: 64 })
        const all = readBoolean(input, "all", false)
        const topic = readString(input, "topic", { max: 80 })
        const kind = readEnum(input, "kind", ["message", "status", "request", "answer", "system"] as const, "message")
        const delivery = readEnum(input, "delivery", ["steer", "queue"] as const, "steer")
        const replyTo = readString(input, "replyTo", { max: 80 })

        // `all` defaults to false rather than undefined, so test the values.
        if (!to && !role && !all) {
          return 'crosstalk: give one of "to" (session id), "role", or "all": true'
        }

        const outcome = await deps.mesh.send(
          context.sessionID,
          {
            text,
            ...(to ? { to } : {}),
            ...(role ? { role } : {}),
            ...(all ? { all: true } : {}),
            ...(topic ? { topic } : {}),
            ...(kind ? { kind } : {}),
            ...(delivery ? { delivery } : {}),
            ...(replyTo ? { replyTo } : {}),
          },
          context.signal,
        )

        return formatSend({
          self: deps.mesh.view(context.sessionID),
          recipients: outcome.recipients,
          skipped: outcome.skipped,
          text,
          now: deps.mesh.now(),
        })
      })
    },
  }
}
