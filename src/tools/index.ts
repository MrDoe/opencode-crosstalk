/**
 * @fileoverview Tool registration.
 *
 * All six tools share one namespace and one permission action, so a project can
 * allow or deny coordination with a single rule.
 */

import type { ToolEditor } from "@opencode/plugin/promise/tool"
import { claimTool } from "./claim.ts"
import { inboxTool } from "./inbox.ts"
import { peersTool } from "./peers.ts"
import { sendTool } from "./send.ts"
import { statusTool } from "./status.ts"
import { waitTool } from "./wait.ts"
import type { CrosstalkToolInfo, ToolDeps } from "./types.ts"

export const NAMESPACE_DESCRIPTION =
  "Coordinate with the other OpenCode sessions on this project: discover peers, exchange messages, " +
  "and lease files so two agents never edit the same path at once. Start with status, then peers."

/** Tool factories in registration order. */
export const toolFactories: Array<(deps: ToolDeps) => CrosstalkToolInfo> = [
  statusTool,
  peersTool,
  sendTool,
  inboxTool,
  claimTool,
  waitTool,
]

/**
 * Register the namespace and every tool. Must run inside
 * `ctx.tool.transform`, whose callback has to stay synchronous and cheap.
 *
 * Every executor is wrapped to retry queued injections first, so a message
 * whose delivery failed — most likely because the recipient's session belongs
 * to another location — still reaches its turn the moment that session next
 * calls any crosstalk tool.
 */
export function registerTools(editor: ToolEditor, deps: ToolDeps): void {
  editor.namespace({ name: deps.options.namespace, description: NAMESPACE_DESCRIPTION })
  for (const factory of toolFactories) {
    const tool = factory(deps)
    const execute = tool.execute
    editor.add({
      ...tool,
      execute: async (input, context) => {
        await deps.mesh.flushPendingInjection(context.sessionID, context.signal)
        return execute(input, context)
      },
      options: {
        namespace: deps.options.namespace,
        permission: deps.options.permission,
        codemode: deps.options.codemode,
      },
    })
  }
}

export { claimTool, inboxTool, peersTool, sendTool, statusTool, waitTool }
