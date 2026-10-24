/**
 * @fileoverview `crosstalk_heartbeat` — send a message to a peer on an interval.
 *
 * Useful for "check in every 30 s" coordination without the caller having to
 * poll. Each started heartbeat is tracked per sender session and can be stopped
 * or listed. Timers are unref'd so they never keep the process alive.
 */

import { readBoolean, readEnum, readNumber, readString } from "./args.ts"
import { jsonSchema, run, type CrosstalkToolInfo, type ToolDeps } from "./types.ts"

interface Heartbeat {
  id: string
  sessionID: string
  to?: string
  role?: string
  all?: boolean
  text: string
  topic?: string
  kind?: "message" | "status" | "request" | "answer" | "system"
  intervalMs: number
  count: number  // 0 = forever
  sent: number
  timer: ReturnType<typeof setInterval>
}

const heartbeats = new Map<string, Heartbeat>()
let seq = 0

export function heartbeatTool(deps: ToolDeps): CrosstalkToolInfo {
  return {
    name: "heartbeat",
    description: [
      "Send a message to another session on a repeating interval. Use this for periodic",
      "check-ins (e.g. \"report status every 30 s\") without polling. Actions: 'start' begins a",
      "heartbeat, 'stop' cancels one by id, 'list' shows this session's active heartbeats.",
      "Timers are unref'd and stop automatically when the session ends.",
    ].join(" "),
    input: jsonSchema({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "stop", "list"],
          description: "What to do. Defaults to 'start'.",
        },
        id: { type: "string", description: "Heartbeat id (for 'stop')." },
        to: { type: "string", description: "Recipient session id or declared name." },
        role: { type: "string", description: "Send to every peer with this role." },
        all: { type: "boolean", description: "Send to every peer." },
        text: { type: "string", description: "Message body." },
        topic: { type: "string", description: "Optional thread label." },
        kind: {
          type: "string",
          enum: ["message", "status", "request", "answer", "system"],
          description: "Intent.",
        },
        intervalSeconds: {
          type: "number",
          description: "Seconds between sends. Min 5, max 3600. Defaults to 30.",
        },
        count: {
          type: "number",
          description: "How many times to send. 0 = forever (until stopped). Defaults to 0.",
        },
      },
      required: [],
      additionalProperties: false,
    }),
    async execute(input, context) {
      return run(async () => {
        const action = readEnum(input, "action", ["start", "stop", "list"] as const, "start")
        const sessionID = context.sessionID

        if (action === "list") {
          const mine = [...heartbeats.values()].filter((h) => h.sessionID === sessionID)
          if (mine.length === 0) return "crosstalk: no active heartbeats"
          return "crosstalk: active heartbeats:\n" + mine
            .map((h) => `  ${h.id}  every ${h.intervalMs / 1000}s  sent ${h.sent}/${h.count || "∞"}  to=${h.to ?? h.role ?? (h.all ? "all" : "?")}`)
            .join("\n")
        }

        if (action === "stop") {
          const id = readString(input, "id", { required: true, max: 64 })
          const h = heartbeats.get(id)
          if (!h || h.sessionID !== sessionID)
            return `crosstalk: no heartbeat '${id}' owned by this session`
          clearInterval(h.timer)
          heartbeats.delete(id)
          return `crosstalk: stopped heartbeat ${id} (sent ${h.sent})`
        }

        // start
        const text = readString(input, "text", { required: true, max: 8_000 })
        const to = readString(input, "to", { max: 200 })
        const role = readString(input, "role", { max: 64 })
        const all = readBoolean(input, "all", false)
        const topic = readString(input, "topic", { max: 80 })
        const kind = readEnum(input, "kind", ["message", "status", "request", "answer", "system"] as const, "message")
        if (!to && !role && !all)
          return 'crosstalk: give one of "to", "role", or "all": true'
        const intervalSeconds = Math.max(5, Math.min(3600, readNumber(input, "intervalSeconds", { fallback: 30 }) ?? 30))
        const count = Math.max(0, Math.floor(readNumber(input, "count", { fallback: 0 }) ?? 0))
        const intervalMs = intervalSeconds * 1000

        const id = `hb-${++seq}`
        let sent = 0

        const sendOne = async () => {
          sent++
          const h = heartbeats.get(id)
          if (!h) return
          try {
            await deps.mesh.send(sessionID, {
              text,
              ...(to ? { to } : {}),
              ...(role ? { role } : {}),
              ...(all ? { all: true } : {}),
              ...(topic ? { topic } : {}),
              ...(kind ? { kind } : {}),
            }, new AbortController().signal)
          } catch {
            // ignore delivery failures; the next tick retries
          }
          h.sent = sent
          if (count > 0 && sent >= count) {
            clearInterval(h.timer)
            heartbeats.delete(id)
          }
        }

        const timer = setInterval(() => { void sendOne() }, intervalMs)
        timer.unref?.()

        const h: Heartbeat = {
          id, sessionID, text, intervalMs, count, sent: 0, timer,
          ...(to ? { to } : {}),
          ...(role ? { role } : {}),
          ...(all ? { all: true } : {}),
          ...(topic ? { topic } : {}),
          ...(kind ? { kind } : {}),
        }
        heartbeats.set(id, h)

        // Send the first one immediately.
        void sendOne()

        return `crosstalk: started heartbeat ${id} (every ${intervalSeconds}s, ${count || "∞"} sends) to ${to || role || "all"}`
      })
    },
  }
}
