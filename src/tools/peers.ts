/**
 * @fileoverview `crosstalk_peers` — who else is running right now.
 */

import { formatPeers } from "../core/format.ts"
import { readBoolean, readEnum, readNumber } from "./args.ts"
import { jsonSchema, run, type CrosstalkToolInfo, type ToolDeps } from "./types.ts"

export function peersTool(deps: ToolDeps): CrosstalkToolInfo {
  return {
    name: "peers",
    description: [
      "List the other OpenCode sessions on this channel with their liveness, what they declared",
      "they are working on, unread mail counts, and the files they have leased.",
      "Use this before editing shared code, and to find out which session to signal.",
    ].join(" "),
    input: jsonSchema({
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["all", "running", "idle"],
          description: "Filter by liveness. 'all' (default) lists everyone the mesh knows.",
        },
        scope: {
          type: "string",
          enum: ["project", "location", "server"],
          description: "Widen or narrow visibility for this call. Defaults to the configured scope.",
        },
        includeSelf: { type: "boolean", description: "Include this session in the list" },
        limit: { type: "number", description: "Maximum peers to return (default 50)" },
      },
      additionalProperties: false,
    }),
    async execute(input, context) {
      return run(() => {
        const status = readEnum(input, "status", ["all", "running", "idle"] as const, "all")
        const scope =
          readEnum(input, "scope", ["project", "location", "server"] as const, deps.options.scope) ??
          deps.options.scope
        const includeSelf = readBoolean(input, "includeSelf", false)
        const limit = readNumber(input, "limit", { min: 1, max: 500, fallback: 50 })

        const peers = deps.mesh.peers(context.sessionID, {
          status,
          scope,
          includeSelf,
          ...(limit !== undefined ? { limit } : {}),
        })
        return formatPeers({
          self: deps.mesh.view(context.sessionID),
          peers,
          scope,
          now: deps.mesh.now(),
        })
      })
    },
  }
}
