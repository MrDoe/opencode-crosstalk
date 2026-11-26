/**
 * @fileoverview `crosstalk_continue` — steer an existing session by exact id.
 *
 * Continuation reuses the peer's context instead of spawning a new lane. It is
 * a thin, explicit spelling of `send { to: <exact session id> }` with queued
 * delivery, so the intent is visible in a report and the target cannot be a
 * name that another session now claims.
 */

import { formatSend } from "../core/format.ts"
import { readEnum, readString } from "./args.ts"
import { jsonSchema, run, type CrosstalkToolInfo, type ToolDeps } from "./types.ts"

export function continueTool(deps: ToolDeps): CrosstalkToolInfo {
  return {
    name: "continue",
    description: [
      "Continue an existing session by its exact session ID (see crosstalk_peers), preserving its",
      "context instead of starting a new task. Defaults to queued delivery. The communication wall",
      "still applies: out-of-scope and unknown sessions are refused.",
    ].join(" "),
    input: jsonSchema({
      type: "object",
      properties: {
        sessionID: { type: "string", description: "Exact session ID to continue" },
        prompt: { type: "string", description: "What the peer should do next" },
        topic: { type: "string", description: "Optional thread label" },
        delivery: {
          type: "string",
          enum: ["steer", "queue"],
          description: "'queue' (default) waits for the peer's turn to end; 'steer' folds into it now",
        },
      },
      required: ["sessionID", "prompt"],
      additionalProperties: false,
    }),
    async execute(input, context) {
      return run(async () => {
        const sessionID = readString(input, "sessionID", { required: true, max: 200 })
        const prompt = readString(input, "prompt", { required: true, max: 8_000 })
        const topic = readString(input, "topic", { max: 80 })
        const delivery = readEnum(input, "delivery", ["steer", "queue"] as const, "queue")

        const outcome = await deps.mesh.send(
          context.sessionID,
          {
            to: sessionID,
            text: prompt,
            kind: "request",
            delivery,
            ...(topic ? { topic } : {}),
          },
          context.signal,
        )
        if (outcome.skipped.some((skip) => /session unknown/.test(skip.reason))) {
          return `crosstalk continue: ${sessionID} is not on this channel — check crosstalk_peers for session ids`
        }
        return formatSend({
          self: deps.mesh.view(context.sessionID),
          recipients: outcome.recipients,
          skipped: outcome.skipped,
          text: prompt,
          now: deps.mesh.now(),
        })
      })
    },
  }
}
