/**
 * @fileoverview `crosstalk_claim` — exclusive, expiring leases on files.
 *
 * This is the tool that makes two agents safe on one repository: a claim is a
 * hard lease, not a note in the conversation, and the default atomic behaviour
 * means a batch request that touches one busy file takes nothing at all.
 */

import { formatClaims } from "../core/format.ts"
import { readBoolean, readEnum, readNumber, readString, readStringArray } from "./args.ts"
import { jsonSchema, run, type CrosstalkToolInfo, type ToolDeps } from "./types.ts"

export function claimTool(deps: ToolDeps): CrosstalkToolInfo {
  return {
    name: "claim",
    description: [
      "Take an exclusive, expiring lease on files or named resources so another session does not",
      "edit them at the same time. Claim before you edit, release when you are done, renew if you",
      "work longer than the lease. If a file is already leased the request is refused and tells you",
      "who holds it — signal them with crosstalk_send, wait with crosstalk_wait, or pass force: true.",
      "Paths are normalized, and relative paths resolve against this session's directory.",
      "Claim keys are exact: there is no glob expansion, and leasing a directory",
      "does not cover the files inside it — claim each file you edit.",
    ].join(" "),
    input: jsonSchema({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["claim", "renew", "release", "list"],
          description: "Operation. 'list' reports the leases you hold and needs no resources.",
        },
        resources: {
          type: "array",
          items: { type: "string" },
          description: "Exact normalized file paths (src/a.ts, src/auth/login.ts) or named resources (db:migrate). No globs: '**' is an ordinary path segment, not a pattern",
        },
        ttlSeconds: { type: "number", description: "Lease duration in seconds (default 300, max 86400)" },
        note: { type: "string", description: "Why you hold it — shown to the peer you block" },
        force: { type: "boolean", description: "Steal a lease held by another session" },
        atomic: {
          type: "boolean",
          description: "On conflict take nothing (default true). false claims whatever is free",
        },
        includeExpired: { type: "boolean", description: "Include lapsed leases in list output" },
      },
      required: ["action"],
      additionalProperties: false,
    }),
    async execute(input, context) {
      return run(() => {
        const action = readEnum(input, "action", ["claim", "renew", "release", "list"] as const, undefined)
        if (action === undefined) {
          return 'crosstalk: "action" is required (claim, renew, release, or list)'
        }
        const resources = readStringArray(input, "resources", { max: 64, maxLength: 400 })
        const ttlSeconds = readNumber(input, "ttlSeconds", { min: 1, max: 86_400 })
        const note = readString(input, "note", { max: 200 })
        const force = readBoolean(input, "force", false)
        const atomic = readBoolean(input, "atomic", true)
        const includeExpired = readBoolean(input, "includeExpired", false)

        if (action !== "list" && (resources === undefined || resources.length === 0)) {
          return `crosstalk: action "${action}" needs "resources" (use action "list" to see what you hold)`
        }

        const result = deps.mesh.claim(context.sessionID, {
          action,
          ...(resources ? { resources } : {}),
          ...(ttlSeconds !== undefined ? { ttlMs: ttlSeconds * 1000 } : {}),
          ...(note ? { note } : {}),
          force,
          atomic,
          includeExpired,
        })

        return formatClaims({
          self: deps.mesh.view(context.sessionID),
          outcome: result.outcome,
          ttlMs: result.ttlMs,
          now: deps.mesh.now(),
          held: result.held,
        })
      })
    },
  }
}
