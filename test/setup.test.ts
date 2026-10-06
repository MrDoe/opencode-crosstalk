import assert from "node:assert/strict"
import { test } from "node:test"
import plugin, { id as pluginId } from "../src/index.ts"
import { createEventStream, createFakeEditor, createFakeStorage } from "./helpers/fakes.ts"
import type { CrosstalkEvent } from "../src/core/registry.ts"
import type { StorageLike } from "../src/storage.ts"

interface FakeContext {
  ctx: Record<string, unknown>
  editor: ReturnType<typeof createFakeEditor>
  events: ReturnType<typeof createEventStream>
  storage: ReturnType<typeof createFakeStorage>
  synthetic: Array<{ sessionID: string; text: string; delivery?: string; description?: string; metadata?: unknown }>
  sessionGets: string[]
  hooks: Array<{ kind: string; handler: (event: Record<string, unknown>) => void }>
  rpc: {
    registered: Array<{
      definition: { id: string }
      handlers: Record<string, (input?: unknown, context?: unknown) => unknown>
    }>
    emitted: Array<{ name: string; data: unknown }>
  }
  disposed: { tools: number; hooks: number; rpc: number }
}

function fakeContext(options: unknown = undefined, storageOverrides?: Record<string, unknown>): FakeContext {
  const editor = createFakeEditor()
  const events = createEventStream()
  const storage = createFakeStorage(storageOverrides)
  const synthetic: FakeContext["synthetic"] = []
  const sessionGets: string[] = []
  const hooks: FakeContext["hooks"] = []
  const rpc: FakeContext["rpc"] = { registered: [], emitted: [] }
  const disposed = { tools: 0, hooks: 0, rpc: 0 }

  const ctx = {
    app: { name: "opencode", version: "2.0.16", channel: "dev" },
    location: {
      directory: "/repo",
      project: { id: "proj-1", directory: "/repo", canonical: "/repo" },
    },
    options,
    tool: {
      async transform(callback: (e: unknown) => void) {
        callback(editor.editor)
        return {
          async dispose() {
            disposed.tools += 1
            editor.added.length = 0
          },
        }
      },
    },
    session: {
      async synthetic(input: FakeContext["synthetic"][number]) {
        synthetic.push(input)
        return { id: "inbox-1" }
      },
      async hook(kind: string, handler: (event: Record<string, unknown>) => void) {
        hooks.push({ kind, handler })
        return {
          async dispose() {
            disposed.hooks += 1
          },
        }
      },
      async get(input: { sessionID: string }) {
        sessionGets.push(input.sessionID)
        return {
          projectID: "proj-1",
          location: { directory: "/repo" },
          title: `enriched ${input.sessionID}`,
          agent: "build",
          time: { created: 123 },
        }
      },
    },
    event: events,
    storage: storage as unknown as StorageLike,
    rpc: {
      async register(definition: { id: string }, handlers: Record<string, (input?: unknown, context?: unknown) => unknown>) {
        rpc.registered.push({ definition, handlers })
        return {
          events: {
            async emit(name: string, data: unknown) {
              rpc.emitted.push({ name, data })
            },
          },
          async dispose() {
            disposed.rpc += 1
          },
        }
      },
    },
  }

  return { ctx, editor, events, storage, synthetic, sessionGets, hooks, rpc, disposed }
}

/** `setup` returns `void | Cleanup`; the plugin contract is that it is a function. */
function requireCleanup(value: unknown): () => Promise<void> {
  assert.equal(typeof value, "function", "setup must return a cleanup function")
  return value as () => Promise<void>
}

async function setup(options?: unknown, storageOverrides?: Record<string, unknown>) {
  const fake = fakeContext(options, storageOverrides)
  const cleanup = requireCleanup(await plugin.setup(fake.ctx as never))
  return { ...fake, cleanup }
}

/** Drive the registered event stream and let the pump drain it. */
async function emit(fake: FakeContext, event: CrosstalkEvent): Promise<void> {
  fake.events.push(event)
  await fake.events.settle()
}

test("setup registers the namespace, six tools, and the briefing hook", async () => {
  const fake = await setup()

  assert.equal(pluginId, "opencode.crosstalk")
  assert.equal(fake.editor.namespaces[0]?.name, "crosstalk")
  assert.deepEqual(fake.editor.ids(), [
    "crosstalk_status",
    "crosstalk_peers",
    "crosstalk_send",
    "crosstalk_inbox",
    "crosstalk_claim",
    "crosstalk_wait",
  ])
  assert.equal(fake.hooks.length, 1)
  assert.equal(fake.hooks[0]?.kind, "context")
  await fake.cleanup()
})

test("setup honours option overrides", async () => {
  const fake = await setup({ namespace: "mesh", permission: "coord", codemode: true, scope: "server" })

  assert.equal(fake.editor.namespaces[0]?.name, "mesh")
  for (const { tool } of fake.editor.added) {
    assert.equal(tool.options?.namespace, "mesh")
    assert.equal(tool.options?.permission, "coord")
    assert.equal(tool.options?.codemode, true)
  }
  await fake.cleanup()
})

test("announce: false skips the briefing hook entirely", async () => {
  const fake = await setup({ announce: false })
  assert.equal(fake.hooks.length, 0)
  await fake.cleanup()
})

test("events from the stream populate the mesh the tools read", async () => {
  const fake = await setup()
  await emit(fake, {
    type: "session.created",
    data: { sessionID: "ses_a", projectID: "proj-1", location: { directory: "/repo" }, title: "one" },
  })
  await emit(fake, {
    type: "session.created",
    data: { sessionID: "ses_b", projectID: "proj-1", location: { directory: "/repo" }, title: "two" },
  })
  await emit(fake, { type: "session.execution.started", data: { sessionID: "ses_b" } })

  const peers = await fake.editor.byName("peers").execute({ includeSelf: true }, {
    sessionID: "ses_a" as never,
    signal: new AbortController().signal,
    progress: async () => {},
  } as never)
  const text = String(peers.content)
  assert.match(text, /2 found, 1 running/)
  assert.match(text, /ses_b\s+running/)
  await fake.cleanup()
})

test("a message sent by one session is injected into the other", async () => {
  const fake = await setup()
  for (const id of ["ses_a", "ses_b"]) {
    await emit(fake, {
      type: "session.created",
      data: { sessionID: id, projectID: "proj-1", location: { directory: "/repo" } },
    })
  }

  const result = await fake.editor.byName("send").execute(
    { to: "ses_b", text: "hold src/auth.ts", kind: "request" },
    { sessionID: "ses_a" as never, signal: new AbortController().signal, progress: async () => {} } as never,
  )

  assert.match(String(result.content), /✓ ses_b/)
  assert.equal(fake.synthetic.length, 1)
  const injected = fake.synthetic[0]
  assert.equal(injected?.sessionID, "ses_b")
  assert.equal(injected?.delivery, "steer")
  assert.match(injected?.text ?? "", /\[crosstalk\]/)
  assert.match(injected?.text ?? "", /hold src\/auth\.ts/)
  assert.match(injected?.text ?? "", /crosstalk_send/)
  assert.equal(
    (injected?.metadata as { crosstalk: { kind: string } }).crosstalk.kind,
    "request",
    "the injected message is tagged as crosstalk mail",
  )
  await fake.cleanup()
})

test("a message whose injection failed is delivered on the recipient's next tool call", async () => {
  const fake = fakeContext()
  let rejectNext = true
  fake.ctx.session = {
    async synthetic(input: FakeContext["synthetic"][number]) {
      if (rejectNext) {
        rejectNext = false
        throw new Error("session belongs to another location")
      }
      fake.synthetic.push(input)
      return { id: "inbox-1" }
    },
    async hook(kind: string, handler: (event: Record<string, unknown>) => void) {
      fake.hooks.push({ kind, handler })
      return {
        async dispose() {
          fake.disposed.hooks += 1
        },
      }
    },
  }
  const cleanup = requireCleanup(await plugin.setup(fake.ctx as never))

  for (const id of ["ses_a", "ses_b"]) {
    await emit(fake, {
      type: "session.created",
      data: { sessionID: id, projectID: "proj-1", location: { directory: "/repo" } },
    })
  }
  const context = (sessionID: string) =>
    ({ sessionID: sessionID as never, signal: new AbortController().signal, progress: async () => {} }) as never

  const sent = await fake.editor.byName("send").execute({ to: "ses_b", text: "over here" }, context("ses_a"))
  assert.match(String(sent.content), /queued only: session belongs to another location/)
  assert.equal(fake.synthetic.length, 0, "the first injection was rejected")

  // Any crosstalk call from the recipient retries it — no polling required.
  await fake.editor.byName("status").execute({}, context("ses_b"))
  assert.equal(fake.synthetic.length, 1)
  assert.match(String(fake.synthetic[0]?.text ?? ""), /over here/)
  await cleanup()
})

test("a claim from one session blocks the other through the tool surface", async () => {
  const fake = await setup()
  for (const id of ["ses_a", "ses_b"]) {
    await emit(fake, {
      type: "session.created",
      data: { sessionID: id, projectID: "proj-1", location: { directory: "/repo" } },
    })
  }
  const context = (sessionID: string) =>
    ({ sessionID: sessionID as never, signal: new AbortController().signal, progress: async () => {} }) as never

  const taken = await fake.editor.byName("claim").execute(
    { action: "claim", resources: ["src/auth.ts"], note: "in progress" },
    context("ses_a"),
  )
  assert.match(String(taken.content), /1 claimed/)

  const blocked = await fake.editor.byName("claim").execute({ action: "claim", resources: ["src/auth.ts"] }, context("ses_b"))
  assert.match(String(blocked.content), /refused/)
  assert.match(String(blocked.content), /held by ses_a \(in progress\)/)
  await fake.cleanup()
})

test("the briefing is added only when there is something to say", async () => {
  const fake = await setup()
  const handler = fake.hooks[0]?.handler
  assert.ok(handler)

  const withPeers = (sessionID: string) => {
    const pushed: Array<{ type: string; text: string }> = []
    handler({ sessionID, system: pushed })
    return pushed
  }

  assert.deepEqual(withPeers("ses_a"), [], "no peers and no leases: stay silent")

  await emit(fake, {
    type: "session.created",
    data: { sessionID: "ses_b", projectID: "proj-1", location: { directory: "/repo" } },
  })
  const announced = withPeers("ses_a")
  assert.equal(announced.length, 1)
  assert.equal(announced[0]?.type, "text")
  assert.match(announced[0]?.text ?? "", /crosstalk_claim/)
  assert.match(announced[0]?.text ?? "", /1 other session is on this channel/)
  await fake.cleanup()
})

test("a snapshot on disk is restored into a fresh mesh", async () => {
  const snapshot = {
    version: 1,
    savedAt: 0,
    peers: [{ sessionID: "ses_old", status: "running" as const, lastSeen: Date.now(), title: "restored" }],
    claims: [{ key: "/repo/src/a.ts", raw: "src/a.ts", holder: "ses_old", acquired: 0, expires: Date.now() + 60_000 }],
  }
  const fake = await setup(undefined, { "crosstalk/proj-1": snapshot })

  const listed = await fake.editor.byName("peers").execute(
    { scope: "server" },
    { sessionID: "ses_new" as never, signal: new AbortController().signal, progress: async () => {} } as never,
  )
  assert.match(String(listed.content), /ses_old/)
  assert.match(String(listed.content), /restored/)
  await fake.cleanup()
})

test("cleanup disposes the tools and the hook, and stops consuming events", async () => {
  const fake = await setup()
  assert.equal(fake.editor.added.length, 6)

  await fake.cleanup()

  assert.equal(fake.disposed.tools, 1)
  assert.equal(fake.disposed.hooks, 1)
  assert.equal(fake.disposed.rpc, 1)
  assert.equal(fake.editor.added.length, 0, "tools are removed from the catalog")
  assert.throws(() => fake.editor.byName("peers"), /was not registered/)

  // Events arriving after unload must not resurrect anything or reject.
  fake.events.push({ type: "session.created", data: { sessionID: "ses_late" } })
  await fake.events.settle()
  assert.equal(fake.storage.data.has("crosstalk/proj-1"), true, "the final snapshot is written")
})

test("the RPC directory exposes declared sessions", async () => {
  const fake = await setup()
  await emit(fake, {
    type: "session.created",
    data: { sessionID: "ses_a", projectID: "proj-1", location: { directory: "/repo" }, title: "one" },
  })
  await fake.editor.byName("status").execute(
    { name: "Rita", role: "coder", avatar: "👩" },
    { sessionID: "ses_a" as never, signal: new AbortController().signal, progress: async () => {} } as never,
  )

  const registration = fake.rpc.registered[0]
  assert.equal(registration?.definition.id, "crosstalk")
  const payload = (await registration?.handlers.directory?.()) as {
    sessions: Array<{ sessionID: string; name?: string; role?: string; avatar?: string }>
  }
  const rita = payload.sessions.find((session) => session.sessionID === "ses_a")
  assert.equal(rita?.name, "Rita")
  assert.equal(rita?.role, "coder")
  assert.equal(rita?.avatar, "👩")
  await fake.cleanup()
})

test("a peer that missed session.created is healed through session.get", async () => {
  const fake = await setup()
  // A status event alone creates a bare record: no project, no directory.
  await emit(fake, { type: "session.status", data: { sessionID: "ses_late" } })
  await fake.events.settle()

  const registration = fake.rpc.registered[0]
  const payload = (await registration?.handlers.directory?.()) as {
    sessions: Array<{ sessionID: string; projectID?: string; directory?: string; title?: string }>
  }
  const healed = payload.sessions.find((session) => session.sessionID === "ses_late")
  assert.equal(healed?.projectID, "proj-1")
  assert.equal(healed?.directory, "/repo")
  assert.equal(fake.sessionGets.length, 1, "the host is asked once per session")

  // A later event must not trigger another read.
  await emit(fake, { type: "session.status", data: { sessionID: "ses_late" } })
  await fake.events.settle()
  assert.equal(fake.sessionGets.length, 1)
  await fake.cleanup()
})

test("persist: false leaves storage untouched", async () => {
  const fake = await setup({ persist: false })
  await emit(fake, {
    type: "session.created",
    data: { sessionID: "ses_a", projectID: "proj-1", location: { directory: "/repo" } },
  })
  await fake.cleanup()
  assert.equal(fake.storage.data.size, 0)
})

test("a storage write failure does not break setup or cleanup", async () => {
  const fake = fakeContext()
  fake.storage.set = async () => {
    throw new Error("disk full")
  }
  const cleanup = requireCleanup(await plugin.setup(fake.ctx as never))
  assert.equal(fake.editor.added.length, 6)
  await assert.doesNotReject(() => cleanup())
})

test("an unusable stored snapshot is ignored instead of failing setup", async () => {
  for (const bad of [42, "nope", { version: 99, peers: [], claims: [], savedAt: 1 }]) {
    const fake = fakeContext(undefined, { "crosstalk/proj-1": bad })
    const cleanup = requireCleanup(await plugin.setup(fake.ctx as never))
    assert.equal(fake.editor.added.length, 6, `snapshot ${JSON.stringify(bad)} must be ignored, not fatal`)
    await cleanup()
  }
})
