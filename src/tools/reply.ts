/**
 * @fileoverview `crosstalk_reply` — answer a message by its id.
 *
 * Ownership comes from the caller's own inbox, not from a caller-chosen
 * recipient: the original sender is resolved from the stored message, so a
 * reply cannot be redirected at another session by mistake or by name reuse.
 * The communication wall is still enforced by `mesh.send`.
 */

import { formatSend } from "../core/format.ts"
import { readEnum, readString } from "./args.ts"
import { jsonSchema, run, type CrosstalkToolInfo, type ToolDeps } from "./types.ts"

export function replyTool(deps: ToolDeps): CrosstalkToolInfo {
  return {
    name: "reply",
    description: [
      "Reply to a specific message by its ID, as shown by crosstalk_inbox. The recipient is read",
      "from that message, so you cannot accidentally reply to a different session. The thread topic",
      "is inherited. Answer one request once, then continue your task — do not answer an ack.",
    ].join(" "),
    input: jsonSchema({
      type: "object",
      properties: {
        messageId: { type: "string", description: "ID of the message in your inbox, e.g. msg-3" },
        text: { type: "string", description: "Your reply. Be specific and keep it to one or two sentences." },
        delivery: {
          type: "string",
          enum: ["steer", "queue"],
          description: "'steer' (default) folds into the current turn; 'queue' waits for it to end",
        },
      },
      required: ["messageId", "text"],
      additionalProperties: false,
    }),
    async execute(input, context) {
      return run(async () => {
        const messageId = readString(input, "messageId", { required: true, max: 80 })
        const text = readString(input, "text", { required: true, max: 8_000 })
        const delivery = readEnum(input, "delivery", ["steer", "queue"] as const, "steer")

        const original = deps.mesh.findMessage(context.sessionID, messageId)
        if (original === undefined) {
          return `crosstalk reply: message ${messageId} is not in your inbox — use crosstalk_inbox to find its id`
        }

        const outcome = await deps.mesh.send(
          context.sessionID,
          {
            to: original.from,
            text,
            replyTo: messageId,
            kind: "answer",
            ...(delivery ? { delivery } : {}),
            ...(original.topic ? { topic: original.topic } : {}),
          },
          context.signal,
        )
        const head = `crosstalk: in reply to ${messageId} from ${original.fromName ?? original.from}`
        return [
          head,
          formatSend({
            self: deps.mesh.view(context.sessionID),
            recipients: outcome.recipients,
            skipped: outcome.skipped,
            text,
            now: deps.mesh.now(),
          }),
        ].join("\n")
      })
    },
  }
}
