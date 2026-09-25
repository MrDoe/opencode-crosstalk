/**
 * @fileoverview `crosstalk_wait` — block on a peer or a lease.
 *
 * Mail waiting is covered by `crosstalk_inbox { wait }`; this tool is the
 * barrier between two agents that have to take turns — one waits for the other
 * to stop touching the code, or for a file to be released.
 */

import { formatWait } from "../core/format.ts"
import { readNumber, readString } from "./args.ts"
import { clampWait, jsonSchema, run, startHeartbeat, type CrosstalkToolInfo, type ToolDeps } from "./types.ts"

export function waitTool(deps: ToolDeps): CrosstalkToolInfo {
  return {
    name: "wait",
    description: [
      "Block until another session is no longer working, or until a claimed resource is released.",
      "Use it instead of sleeping or re-checking by hand when two sessions are taking turns on the",
      "same code. Returns as soon as the condition holds, or reports a timeout you can act on.",
    ].join(" "),
    input: jsonSchema({
      type: "object",
      properties: {
        for: {
          type: "string",
          enum: ["peer_idle", "claim_free"],
          description: "Wait for a peer to go idle, or for a resource to become unclaimed",
        },
        sessionID: { type: "string", description: "Peer to wait for. Required for peer_idle." },
        resource: { type: "string", description: "File path or named resource. Required for claim_free." },
        timeoutSeconds: { type: "number", description: "Give up after this many seconds (default 30)" },
      },
      required: ["for"],
      additionalProperties: false,
    }),
    async execute(input, context) {
      return run(async () => {
        const forWhat = readString(input, "for", { required: true })
        if (forWhat !== "peer_idle" && forWhat !== "claim_free") {
          return 'crosstalk: "for" must be "peer_idle" or "claim_free"'
        }
        const sessionID = readString(input, "sessionID", { max: 200 })
        const resource = readString(input, "resource", { max: 400 })
        const timeoutSeconds = readNumber(input, "timeoutSeconds", { min: 0, max: 600, fallback: 30 })
        const timeoutMs = clampWait((timeoutSeconds ?? 30) * 1000, deps.options)

        if (forWhat === "peer_idle" && sessionID === undefined) {
          return 'crosstalk: waiting for a peer needs "sessionID" (see crosstalk_peers)'
        }
        if (forWhat === "claim_free" && resource === undefined) {
          return 'crosstalk: waiting for a resource needs "resource" (the path you want to edit)'
        }

        const stop = startHeartbeat(context, deps.options.heartbeatMs, () => ({
          status: "waiting",
          for: forWhat,
          ...(sessionID ? { sessionID } : {}),
          ...(resource ? { resource } : {}),
        }))

        let body: string
        try {
          if (forWhat === "peer_idle" && sessionID) {
            const result = await deps.mesh.waitForPeerIdle(context.sessionID, sessionID, timeoutMs, context.signal)
            body = formatWait({
              forWhat,
              reason: result.reason,
              elapsedMs: result.elapsedMs,
              ...(result.reason === "gone" ? { detail: `${sessionID} is not on this channel any more` } : {}),
            })
          } else if (resource) {
            const result = await deps.mesh.waitForClaimFree(
              context.sessionID,
              resource,
              timeoutMs,
              deps.mesh.directoryOf(context.sessionID),
              context.signal,
            )
            body = formatWait({
              forWhat,
              reason: result.reason,
              elapsedMs: result.elapsedMs,
              ...(result.holder ? { detail: `still held by ${result.holder}` } : {}),
            })
          } else {
            body = "crosstalk: nothing to wait for"
          }
        } finally {
          stop()
        }
        return body
      })
    },
  }
}
