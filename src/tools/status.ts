/**
 * @fileoverview `crosstalk_status` — declare who you are, see who else is here.
 */

import { formatStatus } from "../core/format.ts"
import { ArgError, readString, readStringArray } from "./args.ts"
import { jsonSchema, run, type ToolDeps, type CrosstalkToolInfo } from "./types.ts"

/** A human name is a nickname: letters, digits, spaces, `-`, `_`; 1-32 chars. */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/

export function statusTool(deps: ToolDeps): CrosstalkToolInfo {
  return {
    name: "status",
    description: [
      "Declare what this session is working on and see every other session on this channel.",
      "Call this early in a task: peers use your role to route messages, and it is how two agents",
      "on one repository discover each other. Give yourself a unique human name so the user and",
      "peers can address you (\"tell George…\"). Fields you leave out keep their previous value.",
      "Returns your own record plus the peer list with each peer's status, activity age, unread mail,",
      "and any files they have already leased.",
    ].join(" "),
    input: jsonSchema({
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'Unique human name others can address you by, e.g. "George" (letters, digits, spaces, - and _)',
        },
        role: { type: "string", description: "Short noun for your job, e.g. reviewer, migrator, tester" },
        goal: { type: "string", description: "What you are trying to accomplish in this session" },
        workingOn: {
          type: "array",
          items: { type: "string" },
          description: "Files or areas you expect to touch, e.g. src/auth/session.ts",
        },
        note: { type: "string", description: "Anything peers should know (a blocker, a hand-off)" },
      },
      additionalProperties: false,
    }),
    async execute(input, context) {
      return run(() => {
        const selfID = context.sessionID
        const name = readString(input, "name", { max: 32 })
        if (name !== undefined && !NAME_PATTERN.test(name)) {
          throw new ArgError('"name" must start with a letter and contain only letters, digits, spaces, "-" or "_"')
        }
        const role = readString(input, "role", { max: 64 })
        const goal = readString(input, "goal", { max: 400 })
        const note = readString(input, "note", { max: 400 })
        const workingOn = readStringArray(input, "workingOn", { max: 32, maxLength: 200 })

        const declared =
          name || role || goal || note || workingOn
            ? deps.mesh.declare(selfID, { name, role, goal, note, workingOn })
            : { view: deps.mesh.view(selfID) }
        if (declared.nameConflict) {
          return (
            `crosstalk: the name "${declared.nameConflict.name}" is already used by ${declared.nameConflict.holder}` +
            ` — pick another, or address them with crosstalk_send { to: "${declared.nameConflict.holder}" }`
          )
        }
        const self = declared.view

        const peers = deps.mesh.peers(selfID)
        const claimsHeld = self.claims.length
        const hints: string[] = []
        if (peers.some((peer) => peer.claims.length > 0)) {
          hints.push("some peers hold leases — use crosstalk_claim before editing their files")
        }
        if (peers.some((peer) => !peer.addressable)) {
          hints.push("some peers are outside the communication wall and cannot be messaged")
        }
        if (self.unread > 0) hints.push(`you have ${self.unread} unread message(s) — crosstalk_inbox`)
        if (claimsHeld === 0 && peers.length > 0) {
          hints.push("claim what you are about to edit: crosstalk_claim { resources: [...] }")
        }

        return formatStatus({ self, peers, scope: deps.options.scope, now: deps.mesh.now(), hints })
      })
    },
  }
}
