/**
 * @fileoverview `crosstalk_send` — talk to another session.
 */

import { formatSend } from "../core/format.ts"
import { readBoolean, readEnum, readString, readStringArray } from "./args.ts"
import { jsonSchema, run, type CrosstalkToolInfo, type ToolDeps } from "./types.ts"

export function sendTool(deps: ToolDeps): CrosstalkToolInfo {
  return {
    name: "send",
    description: [
      "Send a message to another OpenCode session on this channel. The message is stored in the",
      "recipient's mailbox and, when possible, injected into their running session so they see it",
      "without waiting. Address it with a session id or a peer's declared human name (crosstalk_peers",
      "shows both), to everyone with a declared role, or to all peers. Only sessions in this project",
      "are reachable — peers marked \"not addressable\" are refused.",
      "Give one reason per message and say what you need back; the recipient replies with crosstalk_send.",
    ].join(" "),
    input: jsonSchema({
      type: "object",
      properties: {
        to: { type: "string", description: "Session ID or declared human name of the recipient (see crosstalk_peers)" },
        role: { type: "string", description: "Send to every peer that declared this role" },
        all: { type: "boolean", description: "Send to every peer on this channel" },
        text: { type: "string", description: "The message body. Be specific about what you need." },
        topic: { type: "string", description: "Optional thread label, e.g. auth-refactor" },
        kind: {
          type: "string",
          enum: ["message", "status", "request", "answer", "decline", "system"],
          description: "Intent. 'request' expects a reply; 'answer' responds to one; 'decline' asks for no reply.",
        },
        delivery: {
          type: "string",
          enum: ["steer", "queue"],
          description: "'steer' (default) folds into the recipient's current turn; 'queue' waits for it to end",
        },
        replyTo: { type: "string", description: "Message ID this answers" },
        writeScope: {
          type: "array",
          items: { type: "string" },
          description: "Exact files the task may edit (one owner per file per phase)",
        },
        validation: { type: "string", description: "Gate command that decides whether the work landed green" },
        evidence: { type: "string", description: "What must be shown to prove completion, e.g. hash + gate result" },
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
        const kind = readEnum(
          input,
          "kind",
          ["message", "status", "request", "answer", "decline", "system"] as const,
          "message",
        )
        const delivery = readEnum(input, "delivery", ["steer", "queue"] as const, "steer")
        const replyTo = readString(input, "replyTo", { max: 80 })
        const writeScope = readStringArray(input, "writeScope", { max: 32, maxLength: 200 })
        const validation = readString(input, "validation", { max: 400 })
        const evidence = readString(input, "evidence", { max: 800 })

        // `all` defaults to false rather than undefined, so test the values.
        if (!to && !role && !all) {
          return 'crosstalk: give one of "to" (session id or name), "role", or "all": true'
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
            ...(validation ? { validation } : {}),
            ...(evidence ? { evidence } : {}),
            ...(writeScope ? { writeScope } : {}),
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
