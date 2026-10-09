/**
 * @fileoverview `crosstalk_peers` — who else is running right now.
 */

import { formatPeers } from "../core/format.ts"
import { normalizeResource } from "../core/claims.ts"
import type { PeerView } from "../types.ts"
import { readBoolean, readEnum, readNumber, readStringArray } from "./args.ts"
import { jsonSchema, run, type CrosstalkToolInfo, type ToolDeps } from "./types.ts"

/**
 * Which peers touch any of `paths`: a session holding a lease on the exact key,
 * or one that listed it in `workingOn`. Both sides are normalized to absolute
 * keys — the caller's paths against the caller's directory, a peer's
 * `workingOn` against the peer's own — so `src/auth.ts` typed by a session in
 * another worktree does not match this one until it provably is the same file.
 *
 * Keys are exact, like every claim key: asking about a directory never matches
 * the files inside it, and `**` is an ordinary path segment. An empty `paths`
 * list matches every peer, which is "no filter" expressed as data.
 */
export function overlappingPeers(
  peers: readonly PeerView[],
  paths: readonly string[],
  baseDir?: string,
): PeerView[] {
  const wanted = paths.map((path) => normalizeResource(path, baseDir)).filter((key) => key !== "")
  if (wanted.length === 0) return [...peers]
  const claimed = new Set(wanted)
  return peers.filter(
    (peer) =>
      peer.claims.some((claim) => claimed.has(claim)) ||
      (peer.declared?.workingOn ?? []).some((entry) => claimed.has(normalizeResource(entry, peer.directory))),
  )
}

export function peersTool(deps: ToolDeps): CrosstalkToolInfo {
  return {
    name: "peers",
    description: [
      "List the other OpenCode sessions on this channel with their liveness, what they declared",
      "they are working on, unread mail counts, and the files they have leased.",
      "Use this before editing shared code, and to find out which session to signal.",
      'Pass "overlap" with exact paths to see only the peers whose leases or workingOn cover them.',
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
        overlap: {
          type: "array",
          items: { type: "string" },
          description:
            "Only peers whose leases or workingOn cover one of these exact paths — no globs, relative paths resolve against your directory",
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
        const overlap = readStringArray(input, "overlap", { max: 32, maxLength: 200 })
        const includeSelf = readBoolean(input, "includeSelf", false)
        const limit = readNumber(input, "limit", { min: 1, max: 500, fallback: 50 })

        const known = deps.mesh.peers(context.sessionID, {
          status,
          scope,
          includeSelf,
          ...(limit !== undefined ? { limit } : {}),
        })
        // An empty list is "no filter", not "match nothing".
        const asked = overlap && overlap.length > 0 ? overlap : undefined
        const peers = asked
          ? overlappingPeers(known, asked, deps.mesh.directoryOf(context.sessionID))
          : known
        return formatPeers({
          self: deps.mesh.view(context.sessionID),
          peers,
          scope,
          now: deps.mesh.now(),
          ...(asked ? { overlap: { paths: asked, considered: known.length } } : {}),
        })
      })
    },
  }
}
