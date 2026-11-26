/**
 * @fileoverview Tool registration.
 *
 * All seven tools share one namespace and one permission action, so a project can
 * allow or deny coordination with a single rule.
 */

import type { ToolEditor } from "@opencode/plugin/promise/tool"
import { claimTool } from "./claim.ts"
import { continueTool } from "./continue.ts"
import { heartbeatTool } from "./heartbeat.ts"
import { replyTool } from "./reply.ts"
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
  replyTool,
  continueTool,
  inboxTool,
  claimTool,
  heartbeatTool,
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
  // The optional guard counts only calls whose input AND result are identical
  // to the previous one, so a repeated read of changed mail never counts.
  // `inbox`, leases, status and waits are exempt: blocking retrieval would
  // deadlock the recovery path the guard is meant to protect.
  const guarded = new Set(["send", "reply"])
  const loopState = new Map<string, { key: string; result: string; count: number }>()
  for (const factory of toolFactories) {
    const tool = factory(deps)
    const execute = tool.execute
    editor.add({
      ...tool,
      execute: async (input, context) => {
        await deps.mesh.flushPendingInjection(context.sessionID, context.signal)
        const result = await execute(input, context)
        if (!deps.options.loopGuard || !guarded.has(tool.name)) return result

        const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content)
        const key = `${tool.name}\u0000${JSON.stringify(input ?? {})}`
        const previous = loopState.get(context.sessionID)
        const count = previous?.key === key && previous.result === text ? previous.count + 1 : 1
        loopState.set(context.sessionID, { key, result: text, count })
        if (count > 5) {
          return { content: `crosstalk: repeated identical ${tool.name} call blocked — change the message or stop` }
        }
        if (count === 3) {
          return { content: `${text}\n  warning: repeated identical call — change the message or stop` }
        }
        return result
      },
      options: {
        namespace: deps.options.namespace,
        permission: deps.options.permission,
        codemode: deps.options.codemode,
      },
    })
  }
}

export {
  claimTool,
  continueTool,
  heartbeatTool,
  inboxTool,
  peersTool,
  replyTool,
  sendTool,
  statusTool,
  waitTool,
}
