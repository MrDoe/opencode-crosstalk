/**
 * @fileoverview Test doubles.
 *
 * Everything the plugin touches from the outside — the clock, storage, the
 * event stream, the session domain, the tool editor — is injectable, so these
 * fakes are the whole harness. No test needs a running OpenCode server.
 */

import type { CrosstalkOptions } from "../../src/config.ts"
import { DEFAULTS } from "../../src/config.ts"
import { Mesh, type Deliverer, type MeshOptions } from "../../src/core/mesh.ts"
import type { CrosstalkMessage, MessageKind } from "../../src/types.ts"
import type { CrosstalkToolInfo, ToolContext } from "../../src/tools/types.ts"
import type { CrosstalkEvent } from "../../src/core/registry.ts"

// ── clock ────────────────────────────────────────────────────────────────────

export interface ManualClock {
  now(): number
  /** Move time forward. */
  advance(ms: number): number
  set(value: number): void
}

export function createManualClock(start = 1_700_000_000_000): ManualClock {
  let value = start
  return {
    now: () => value,
    advance(ms) {
      value += ms
      return value
    },
    set(next) {
      value = next
    },
  }
}

// ── storage ──────────────────────────────────────────────────────────────────

export interface FakeStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; limit?: number; after?: string }): Promise<{
    entries: ReadonlyArray<{ key: string; value: unknown }>
    next?: string
  }>
  /** Raw map, for asserting exactly what was written. */
  readonly data: Map<string, unknown>
  /** Make the next call to `get` reject. */
  failNextGet(error?: Error): void
}

export function createFakeStorage(initial: Record<string, unknown> = {}): FakeStorage {
  const data = new Map<string, unknown>(Object.entries(initial))
  let pendingFailure: Error | undefined
  return {
    data,
    failNextGet(error = new Error("storage unavailable")) {
      pendingFailure = error
    },
    async get(key) {
      if (pendingFailure) {
        const error = pendingFailure
        pendingFailure = undefined
        throw error
      }
      return data.get(key)
    },
    async set(key, value) {
      data.set(key, value)
    },
    async remove(key) {
      data.delete(key)
    },
    async scan({ prefix, after }) {
      const entries = [...data.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .filter(([key]) => (after === undefined ? true : key > after))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => ({ key, value }))
      const next = entries.length > 0 ? entries.at(-1)?.key : undefined
      return { entries, ...(next ? { next } : {}) }
    },
  }
}

// ── event stream ─────────────────────────────────────────────────────────────

export interface FakeEventStream {
  subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown>
  push(event: unknown): void
  close(): void
  readonly pending: number
  /** Let the consumer drain whatever is queued. */
  settle(times?: number): Promise<void>
}

/** A push-driven stand-in for `ctx.event.subscribe`. */
export function createEventStream(): FakeEventStream {
  const queue: unknown[] = []
  let wake: (() => void) | undefined
  let closed = false

  const stream: FakeEventStream = {
    get pending() {
      return queue.length
    },
    subscribe(options) {
      const signal = options?.signal
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (queue.length > 0) {
              const next = queue.shift()
              if (next !== undefined) yield next
            }
            if (closed || signal?.aborted) return
            // A real subscription ends when its signal aborts, so the pump's
            // `await` in plugin cleanup can actually settle.
            await Promise.race([
              new Promise<void>((resolve) => {
                wake = resolve
              }),
              new Promise<void>((resolve) => {
                signal?.addEventListener("abort", () => resolve(), { once: true })
              }),
            ])
          }
        },
      }
    },
    push(event) {
      queue.push(event)
      const resolve = wake
      wake = undefined
      resolve?.()
    },
    close() {
      closed = true
      const resolve = wake
      wake = undefined
      resolve?.()
    },
    async settle(times = 4) {
      for (let index = 0; index < times; index += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
    },
  }
  return stream
}

/**
 * Build a server event of the shape `ctx.event.subscribe()` yields. `created`
 * is omitted unless a test needs it, so the registry falls back to its injected
 * clock instead of comparing against a fixed epoch.
 */
export function event(type: string, data: Record<string, unknown>, created?: number): CrosstalkEvent & {
  type: string
} {
  return { type, data, ...(created === undefined ? {} : { created }) }
}

/** `session.created` for a session in a project directory. */
export function createdEvent(sessionID: string, overrides: Record<string, unknown> = {}, created?: number): CrosstalkEvent {
  return event(
    "session.created",
    { sessionID, projectID: "proj-1", location: { directory: "/repo" }, title: "session", ...overrides },
    created,
  )
}

// ── deliverer ────────────────────────────────────────────────────────────────

export interface RecordingDeliverer extends Deliverer {
  readonly calls: CrosstalkMessage[]
  /** Session IDs whose delivery should fail. */
  failFor: Set<string>
}

export function createDeliverer(): RecordingDeliverer {
  const calls: CrosstalkMessage[] = []
  const failFor = new Set<string>()
  return {
    calls,
    failFor,
    async deliver(message) {
      calls.push(message)
      if (failFor.has(message.to)) return { delivered: false, reason: "session is busy" }
      return { delivered: true }
    },
  }
}

// ── mesh ─────────────────────────────────────────────────────────────────────

export function meshOptions(overrides: Partial<MeshOptions> = {}): MeshOptions {
  return {
    scope: "project",
    staleAfterMs: 600_000,
    evictAfterMs: 3_600_000,
    maxMessages: 100,
    messageTtlMs: 86_400_000,
    claimTtlMs: 300_000,
    maxWaitMs: 120_000,
    // Tests drive time explicitly; a 1ms poll keeps barrier waits fast.
    pollMs: 1,
    ...overrides,
  }
}

export interface TestMesh {
  mesh: Mesh
  clock: ManualClock
  deliverer: RecordingDeliverer
}

export interface TestMeshOptions extends Partial<MeshOptions> {
  /**
   * Use the real clock. Barrier waits measure elapsed time with the injected
   * clock while sleeping on real timers, so the *timeout* path can only be
   * exercised when time actually passes.
   */
  realClock?: boolean
}

export function createTestMesh(options: TestMeshOptions = {}): TestMesh {
  const { realClock, ...meshOpts } = options
  const clock = createManualClock()
  const deliverer = createDeliverer()
  const mesh = new Mesh({
    options: meshOptions(meshOpts),
    clock: realClock ? { now: () => Date.now() } : clock,
    deliverer,
    defaults: { projectID: "proj-1", directory: "/repo" },
  })
  return { mesh, clock, deliverer }
}

export function toolOptions(overrides: Partial<CrosstalkOptions> = {}): CrosstalkOptions {
  return { ...DEFAULTS, heartbeatMs: 0, ...overrides }
}

// ── tool harness ─────────────────────────────────────────────────────────────

export function toolContext(sessionID: string, signal = new AbortController().signal): ToolContext {
  return {
    // The host brands these ids; the plugin only ever reads them as strings.
    sessionID: sessionID as never,
    agent: "build" as never,
    messageID: `msg-${sessionID}` as never,
    id: `call-${sessionID}` as never,
    signal,
    progress: async () => {},
  }
}

/** Run a tool executor and return its text content. */
export async function execTool(
  tool: CrosstalkToolInfo,
  input: unknown,
  sessionID: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await tool.execute(input, toolContext(sessionID, signal))
  if (typeof result.content === "string") return result.content
  if (Array.isArray(result.content)) {
    return result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
  }
  return ""
}

/** Collect the tools a registration adds, keyed by their effective id. */
export function createFakeEditor() {
  const namespaces: Array<{ name: string; description: string }> = []
  const added: Array<{ tool: CrosstalkToolInfo; id: string }> = []
  const editor = {
    namespace(namespace: { name: string; description: string }) {
      namespaces.push(namespace)
    },
    add(tool: CrosstalkToolInfo) {
      const namespace = tool.options?.namespace
      const id = namespace ? `${namespace}_${tool.name}` : tool.name
      const existing = added.findIndex((entry) => entry.id === id)
      if (existing >= 0) added.splice(existing, 1)
      added.push({ tool, id })
    },
    update() {},
    remove() {},
    list: () => added.map((entry) => entry.tool),
    get: (id: string) => added.find((entry) => entry.id === id)?.tool,
  }
  return {
    editor,
    namespaces,
    added,
    ids: () => added.map((entry) => entry.id),
    byName: (name: string) => {
      const entry = added.find((candidate) => candidate.tool.name === name)
      if (!entry) throw new Error(`tool "${name}" was not registered`)
      return entry.tool
    },
  }
}

/** Convenience: a message-shaped object for mailbox unit tests. */
export function message(overrides: Partial<CrosstalkMessage> = {}): CrosstalkMessage {
  return {
    id: "msg-1",
    seq: 1,
    from: "ses_sender",
    to: "ses_receiver",
    text: "hello",
    kind: "message" as MessageKind,
    delivery: "steer",
    created: 1_700_000_000_000,
    ...overrides,
  }
}
