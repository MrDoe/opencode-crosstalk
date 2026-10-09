/**
 * @fileoverview The RPC contract shared by the server plugin and the TUI plugin.
 *
 * Only a type is imported: `Rpc.define` is an identity function, so this plain
 * object works on both sides and the TUI process never resolves a runtime
 * plugin module for it. Keep the schemas in step with `DirectoryEntry`.
 */

import type { Rpc } from "@opencode/plugin/rpc"

const sessionSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    status: { type: "string" },
    title: { type: "string" },
    name: { type: "string" },
    role: { type: "string" },
    goal: { type: "string" },
    summary: { type: "string" },
    summaryAt: { type: "number" },
    avatar: { type: "string" },
    directory: { type: "string" },
    projectID: { type: "string" },
    portrait: { type: "string" },
  },
  required: ["sessionID", "status"],
  additionalProperties: false,
} as const

const directorySchema = {
  type: "object",
  properties: {
    sessions: { type: "array", items: sessionSchema },
  },
  required: ["sessions"],
  additionalProperties: false,
} as const

/** Method + event surface the TUI uses; the server registers the handlers. */
export const CrosstalkRpc = {
  id: "crosstalk",
  methods: {
    directory: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: directorySchema,
    },
  },
  events: {
    changed: { schema: directorySchema },
  },
} as const satisfies Rpc.Definition
