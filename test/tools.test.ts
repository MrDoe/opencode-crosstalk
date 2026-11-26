import assert from "node:assert/strict"
import { test } from "node:test"
import { SUMMARY_STALE_MS } from "../src/core/format.ts"
import { registerTools, toolFactories, NAMESPACE_DESCRIPTION } from "../src/tools/index.ts"
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import { createdEvent, createFakeEditor, createTestMesh, execTool, toolOptions } from "./helpers/fakes.ts"
import type { TestMeshOptions } from "./helpers/fakes.ts"
import type { ToolDeps } from "../src/tools/types.ts"

interface Harness {
  deps: ToolDeps
  mesh: ReturnType<typeof createTestMesh>["mesh"]
  clock: ReturnType<typeof createTestMesh>["clock"]
  deliverer: ReturnType<typeof createTestMesh>["deliverer"]
  editor: ReturnType<typeof createFakeEditor>
  status: (input: unknown, sessionID?: string) => Promise<string>
  peers: (input: unknown, sessionID?: string) => Promise<string>
  send: (input: unknown, sessionID?: string) => Promise<string>
  reply: (input: unknown, sessionID?: string) => Promise<string>
  continue: (input: unknown, sessionID?: string) => Promise<string>
  inbox: (input: unknown, sessionID?: string) => Promise<string>
  claim: (input: unknown, sessionID?: string) => Promise<string>
  wait: (input: unknown, sessionID?: string) => Promise<string>
  tool: (name: string) => ReturnType<typeof createFakeEditor>["added"][number]["tool"]
}

function harness(options: TestMeshOptions = {}, optionOverrides = {}): Harness {
  const { mesh, clock, deliverer } = createTestMesh(options)
  const deps: ToolDeps = { mesh, options: toolOptions(optionOverrides) }
  const editor = createFakeEditor()
  registerTools(editor.editor as unknown as ToolEditor, deps)
  const call = (name: string, input: unknown, sessionID = "ses_self") =>
    execTool(editor.byName(name), input, sessionID)
  return {
    deps,
    mesh,
    clock,
    deliverer,
    editor,
    status: (input, sessionID) => call("status", input, sessionID),
    peers: (input, sessionID) => call("peers", input, sessionID),
    send: (input, sessionID) => call("send", input, sessionID),
    reply: (input, sessionID) => call("reply", input, sessionID),
    continue: (input, sessionID) => call("continue", input, sessionID),
    inbox: (input, sessionID) => call("inbox", input, sessionID),
    claim: (input, sessionID) => call("claim", input, sessionID),
    wait: (input, sessionID) => call("wait", input, sessionID),
    tool: (name) => editor.byName(name),
  }
}

// ── registration ─────────────────────────────────────────────────────────────

test("registration publishes one namespace and nine namespaced tools", () => {
  const h = harness()
  assert.equal(h.editor.namespaces.length, 1)
  assert.equal(h.editor.namespaces[0]?.name, "crosstalk")
  assert.equal(h.editor.namespaces[0]?.description, NAMESPACE_DESCRIPTION)
  assert.deepEqual(h.editor.ids(), [
    "crosstalk_status",
    "crosstalk_peers",
    "crosstalk_send",
    "crosstalk_reply",
    "crosstalk_continue",
    "crosstalk_inbox",
    "crosstalk_claim",
    "crosstalk_heartbeat",
    "crosstalk_wait",
  ])
  assert.equal(toolFactories.length, 9)
})

test("every tool carries the configured namespace, permission, and codemode flag", () => {
  const direct = harness()
  for (const { tool } of direct.editor.added) {
    assert.equal(tool.options?.namespace, "crosstalk")
    assert.equal(tool.options?.permission, "crosstalk")
    assert.equal(tool.options?.codemode, false)
  }

  const custom = harness({}, { namespace: "mesh", permission: "coord", codemode: true })
  assert.equal(custom.editor.namespaces[0]?.name, "mesh")
  for (const { tool } of custom.editor.added) {
    assert.equal(tool.options?.namespace, "mesh")
    assert.equal(tool.options?.permission, "coord")
    assert.equal(tool.options?.codemode, true)
  }
})

test("every tool declares a description and a closed input schema", () => {
  const h = harness()
  for (const { tool } of h.editor.added) {
    assert.ok(tool.description.length > 40, `${tool.name} needs a usable description`)
    const schema = tool.input as { type?: string; additionalProperties?: boolean; properties?: object }
    assert.equal(schema.type, "object", `${tool.name} input must be an object schema`)
    assert.equal(schema.additionalProperties, false, `${tool.name} must reject unknown keys`)
    assert.equal(typeof schema.properties, "object")
  }
})

// ── crosstalk_status ─────────────────────────────────────────────────────────

test("status declares a role and reports the peer list", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self", { title: "mine" }))
  h.mesh.applyEvent(createdEvent("ses_peer", { title: "theirs", agent: "plan" }))

  const output = await h.status({ role: "migrator", goal: "port auth", summary: "half of auth ported", workingOn: ["src/auth.ts"] })
  assert.match(output, /you are ses_self/)
  assert.match(output, /role: migrator/)
  assert.match(output, /goal: port auth/)
  assert.match(output, /summary: half of auth ported/)
  assert.match(output, /working on: src\/auth\.ts/)
  assert.match(output, /- ses_peer/)
  assert.match(output, /claim what you are about to edit/)
})

test("status shows a self-check line with snapshot format and storage key", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  const output = await h.status(undefined)
  assert.match(output, /self-check: snapshot v2/)
  assert.match(output, /storage crosstalk\//, "the persisted mesh key is named")
})

test("status self-check counts live plugin locations through the guard", async () => {
  const holder = globalThis as { __crosstalk?: unknown }
  const previous = holder.__crosstalk
  holder.__crosstalk = { owners: new Map([["dir-a", Symbol("a")], ["dir-b", Symbol("b")]]), refused: 2 }
  try {
    const h = harness()
    h.mesh.applyEvent(createdEvent("ses_self"))
    const output = await h.status(undefined)
    assert.match(output, /2 locations owned/)
    assert.match(output, /2 refused loads/, "the guard-refused twin loads reach the model")
  } finally {
    if (previous === undefined) delete holder.__crosstalk
    else holder.__crosstalk = previous
  }
})

test("status self-check degrades when the guard shape is unexpected", async () => {
  const holder = globalThis as { __crosstalk?: unknown }
  const previous = holder.__crosstalk
  holder.__crosstalk = { owners: new Map([["dir-a", Symbol("a")]]) }
  try {
    const h = harness()
    h.mesh.applyEvent(createdEvent("ses_self"))
    const output = await h.status(undefined)
    assert.doesNotMatch(output, /locations|refused/, "no refused counter in the shape: the whole check is omitted, not guessed")
  } finally {
    if (previous === undefined) delete holder.__crosstalk
    else holder.__crosstalk = previous
  }
})

test("status reports a peer's summary on its line", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.status({ summary: "porting the token refresh" }, "ses_peer")

  const output = await h.status({ summary: "half of auth ported" })
  assert.match(output, /- ses_peer {2}unknown {2}summary="porting the token refresh"/)
  assert.doesNotMatch(output, /tell peers what you are doing right now/, "the own summary silences the hint")
})

test("status rejects an over-long summary instead of truncating it", async () => {
  const h = harness()
  const output = await h.status({ summary: "x".repeat(201) })
  assert.match(output, /^crosstalk: "summary" is 201 characters; the limit is 200$/)
})

test("peers shows a peer's goal and how old its summary is", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.status({ goal: "port auth", summary: "handlers half done" }, "ses_peer")
  h.clock.advance(14 * 60_000)

  const output = await h.peers({})
  assert.match(output, /goal="port auth" {2}summary="handlers half done" \(14m ago\)/)
})

test("peers leaves a fresh summary undated", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.status({ summary: "handlers half done" }, "ses_peer")

  const output = await h.peers({})
  assert.match(output, /summary="handlers half done" {2}/, "a fresh summary is simply reported")
  assert.doesNotMatch(output, /summary="handlers half done" \(/, "without an age")
})

test("status hints at a missing summary while peers are listening", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))

  const missing = await h.status({ role: "migrator" })
  assert.match(missing, /tell peers what you are doing right now/)

  const declared = await h.status({ summary: "half of auth ported" })
  assert.doesNotMatch(declared, /tell peers what you are doing right now/)
})

test("status without peers says nothing about summaries", async () => {
  const h = harness()
  const output = await h.status({})
  assert.doesNotMatch(output, /tell peers what you are doing right now/)
})

test("a bare status call says out loud that it declared nothing", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self", { title: "Reading the logs" }))
  h.mesh.applyEvent(createdEvent("ses_peer"))

  const bare = await h.status({})
  assert.match(bare, /passed no fields, so it declared nothing/)

  const real = await h.status({ role: "reader" })
  assert.doesNotMatch(real, /passed no fields/, "a field-bearing call is not a no-op")
})

test("an auto-declared entry is called out as the title placeholder", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self", { title: "Investigate the timeout" }))
  h.mesh.autoDeclareFromTitle("ses_self", "Investigate the timeout")

  const output = await h.status({})
  assert.match(output, /directory entry is only the session title/)
  assert.match(output, /Investigate the timeout/, "the placeholder itself is shown")
})

test("status with no arguments still reports who you are", async () => {
  const h = harness()
  const output = await h.status({})
  assert.match(output, /you are ses_self/)
  assert.doesNotMatch(output, /role: /)
})

test("status hints at unread mail and at peers' leases", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  h.mesh.claim("ses_peer", { action: "claim", resources: ["src/a.ts"] })
  await h.mesh.send("ses_peer", { to: "ses_self", text: "hi" })

  const output = await h.status({})
  assert.match(output, /some peers hold leases/)
  assert.match(output, /you have 1 unread message\(s\)/)
})

test("status rejects an over-long role instead of truncating it", async () => {
  const h = harness()
  const output = await h.status({ role: "x".repeat(65) })
  assert.match(output, /^crosstalk: "role" is 65 characters; the limit is 64$/)
})

test("status sets a human name and shows it in the header and peer list", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.status({ name: "George" }, "ses_peer")

  const output = await h.status({ name: "Alex", role: "reviewer" })
  assert.match(output, /you are ses_self \(Alex\)/)
  assert.match(output, /- ses_peer {2}\(George\) {2}/)
})

test("status refuses a name another session already took", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.status({ name: "George" }, "ses_peer")

  const output = await h.status({ name: "george", role: "reviewer" })
  assert.match(output, /the name "george" is already used by ses_peer/)
  assert.doesNotMatch(output, /role: reviewer/, "nothing is applied on a name conflict")
})

test("status rejects a name with unsupported characters", async () => {
  const h = harness()
  const output = await h.status({ name: "George!" })
  assert.match(output, /^crosstalk: "name" must start with a letter/)
})

test("send addresses a peer by name", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.status({ name: "Alexandra" }, "ses_peer")

  const output = await h.send({ to: "alexandra", text: "review this" })
  assert.match(output, /signalled 1 session/)
  assert.match(output, /✓ ses_peer/)
})

test("peers lists an unknown-location peer as not addressable", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent({ type: "session.status", data: { sessionID: "ses_unknown", status: { type: "busy" } } })

  const output = await h.peers({})
  assert.match(output, /ses_unknown/)
  assert.match(output, /location unknown — not addressable/)
})

test("send refuses a peer outside the project scope", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_elsewhere", { projectID: "proj-9" }))

  const output = await h.send({ to: "ses_elsewhere", text: "hi" })
  assert.match(output, /- ses_elsewhere: outside the project scope/)
})

test("wait refuses a peer outside the project scope", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_elsewhere", { projectID: "proj-9" }))

  const output = await h.wait({ for: "peer_idle", sessionID: "ses_elsewhere", timeoutSeconds: 0 })
  assert.match(output, /is outside the project scope/)
})

// ── crosstalk_peers ──────────────────────────────────────────────────────────

test("peers lists others and excludes the caller", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_b", { title: "one" }))
  h.mesh.applyEvent(createdEvent("ses_c", { title: "two" }))

  const output = await h.peers({})
  assert.match(output, /2 found/)
  assert.match(output, /ses_b/)
  assert.match(output, /ses_c/)
  assert.doesNotMatch(output, /- ses_self/)
})

test("peers filters by status and honours includeSelf and limit", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_busy"))
  h.mesh.applyEvent(createdEvent("ses_quiet"))
  h.mesh.applyEvent({ type: "session.execution.started", data: { sessionID: "ses_busy" } })
  h.mesh.applyEvent({ type: "session.idle", data: { sessionID: "ses_quiet" } })

  assert.match(await h.peers({ status: "running" }), /1 found/)
  assert.match(await h.peers({ status: "idle" }), /1 found/)
  assert.match(await h.peers({ status: "running", includeSelf: true }), /2 found/)
  assert.match(await h.peers({ limit: 1 }), /1 found/)
})

test("peers explains an empty channel rather than returning nothing", async () => {
  const h = harness()
  const output = await h.peers({})
  assert.match(output, /no other sessions on this channel/)
  assert.match(output, /do not need to claim anything/)
})

test("peers rejects an unknown status value", async () => {
  const h = harness()
  assert.match(await h.peers({ status: "sleepy" }), /^crosstalk: "status" must be one of: all, running, idle \(got "sleepy"\)$/)
})

// ── crosstalk_peers: overlap ────────────────────────────────────────────────

test("peers overlaps leases and workingOn, and explains no match", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_holder"))
  h.mesh.applyEvent(createdEvent("ses_planner"))
  await h.claim({ action: "claim", resources: ["src/auth.ts"] }, "ses_holder")
  await h.status({ workingOn: ["src/db.ts"] }, "ses_planner")

  const byClaim = await h.peers({ overlap: ["src/auth.ts"] })
  assert.match(byClaim, /1 found/)
  assert.match(byClaim, /ses_holder/)
  assert.doesNotMatch(byClaim, /ses_planner/)

  const byWorkingOn = await h.peers({ overlap: ["src/db.ts"] })
  assert.match(byWorkingOn, /1 found/)
  assert.match(byWorkingOn, /ses_planner/)

  const both = await h.peers({ overlap: ["src/db.ts", "src/auth.ts"] })
  assert.match(both, /2 found/)
  assert.match(both, /overlap src\/db\.ts, src\/auth\.ts/)

  const none = await h.peers({ overlap: ["src/other.ts"] })
  assert.match(none, /no peers overlap src\/other\.ts/)
  assert.match(none, /2 other sessions on this channel, but none leases or works on those exact paths/)
})

test("peers treats overlap paths as exact keys, like every claim key", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_holder"))
  await h.claim({ action: "claim", resources: ["src/auth.ts"] }, "ses_holder")

  assert.match(await h.peers({ overlap: ["src"] }), /no peers overlap src /, "a directory covers nothing inside it")
  assert.match(await h.peers({ overlap: ["src/auth.**"] }), /no peers overlap src\/auth\.\*\*/, "and `**` is a literal segment")
  assert.match(await h.peers({ overlap: ["src/auth.ts"] }), /1 found/, "the file itself does")
})

test("peers does not overlap a peer's working path from another directory", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_elsewhere", { location: { directory: "/other" } }))
  await h.status({ workingOn: ["src/db.ts"] }, "ses_elsewhere")

  const output = await h.peers({ overlap: ["src/db.ts"] })
  assert.match(output, /no peers overlap src\/db\.ts/, "the same relative string in another worktree is another file")
  assert.match(output, /1 other session on this channel/)
})

test("peers can overlap the caller's own lease through includeSelf", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  await h.claim({ action: "claim", resources: ["src/auth.ts"] })

  assert.match(await h.peers({ overlap: ["src/auth.ts"] }), /no peers overlap/, "the caller is not a peer to itself")
  const withSelf = await h.peers({ overlap: ["src/auth.ts"], includeSelf: true })
  assert.match(withSelf, /1 found/)
  assert.match(withSelf, /you: ses_self/)
})

test("peers treats an empty overlap list as no filter at all", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_b"))

  const output = await h.peers({ overlap: [] })
  assert.match(output, /1 found/)
  assert.doesNotMatch(output, /overlap/)
})

test("peers rejects an over-long overlap entry", async () => {
  const h = harness()
  const output = await h.peers({ overlap: ["x".repeat(201)] })
  assert.match(output, /^crosstalk: "overlap" entries must be at most 200 characters$/)
})

// ── crosstalk_status: summary freshness ───────────────────────────────────────

test("status leaves a fresh summary unannotated", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  const output = await h.status({ summary: "porting handlers" })
  assert.match(output, / {2}summary: porting handlers\n/, "no annotation while fresh")
  assert.doesNotMatch(output, /refresh it/)
})

test("status annotates an aging summary and nudges only once it is stale", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.status({ summary: "porting handlers" })
  h.clock.advance(14 * 60_000)

  const aging = await h.status({})
  assert.match(aging, / {2}summary: porting handlers \(14m ago\)/, "the agent sees its own age first")
  assert.doesNotMatch(aging, /refresh it/, "aging is information, not yet a nudge")

  h.clock.advance(SUMMARY_STALE_MS - 14 * 60_000)
  const atBoundary = await h.status({})
  assert.doesNotMatch(atBoundary, /refresh it/, "exactly at the window is not stale")

  h.clock.advance(1)
  const stale = await h.status({})
  assert.match(stale, / {2}summary: porting handlers \(15m ago\)/)
  assert.match(stale, /your summary is 15m old — refresh it: crosstalk_status \{ summary: … \}/)
})

test("a summary-free session is told to declare one, not to refresh it", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  const output = await h.status({ role: "migrator" })
  assert.match(output, /tell peers what you are doing right now/)
  assert.doesNotMatch(output, /refresh it/, "only a declared summary can go stale")
})

// ── crosstalk_send ───────────────────────────────────────────────────────────

test("send delivers to a peer and reports it", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.status({ role: "migrator" })

  const output = await h.send({ to: "ses_peer", text: "please hold off on src/auth.ts", kind: "request" })
  assert.match(output, /signalled 1 session \(1 delivered now, 0 queued in mailbox\)/)
  assert.match(output, /✓ ses_peer/)
  assert.equal(h.deliverer.calls[0]?.kind, "request")
  assert.equal(h.deliverer.calls[0]?.fromRole, "migrator")
  assert.equal(h.deliverer.calls[0]?.meta?.requested, "migrator")
})

test("send downgrades to queued when injection fails", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  h.deliverer.failFor.add("ses_peer")

  const output = await h.send({ to: "ses_peer", text: "important" })
  assert.match(output, /0 delivered now, 1 queued in mailbox/)
  assert.match(output, /queued only: session is busy/)
})

test("send requires a recipient and a body", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  assert.match(await h.send({ text: "hi" }), /give one of "to".*"role".*"all"/)
  assert.match(await h.send({ to: "ses_x" }), /^crosstalk: "text" is required$/)
})

test("send reports a target it cannot resolve", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  assert.match(await h.send({ to: "ses_ghost", text: "hi" }), /session unknown/)
  assert.match(await h.send({ to: "ses_self", text: "hi" }), /that is you/)
  assert.match(await h.send({ role: "ghost", text: "hi" }), /no peer declared that role/)
})

test("send can address a whole role or the whole channel", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_a"))
  h.mesh.applyEvent(createdEvent("ses_b"))
  await h.status({ role: "reviewer" }, "ses_a")
  await h.status({ role: "tester" }, "ses_b")

  assert.match(await h.send({ role: "tester", text: "hi" }), /signalled 1 session/)
  assert.match(await h.send({ all: true, text: "hi" }), /signalled 2 sessions/)
})

test("send rejects an oversized body", async () => {
  const h = harness()
  const output = await h.send({ to: "ses_peer", text: "x".repeat(8_001) })
  assert.match(output, /"text" is 8001 characters; the limit is 8000/)
})

// ── crosstalk_inbox ──────────────────────────────────────────────────────────

test("inbox renders mail and marks it read", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.send({ to: "ses_self", text: "line one\nline two" }, "ses_peer")

  const output = await h.inbox({})
  assert.match(output, /1 message \(1 unread\)/)
  assert.match(output, /line one/)
  assert.match(output, /line two/)
  assert.match(output, /marked 1 message read/)
  assert.equal(h.mesh.mailbox.unreadCount("ses_self"), 0)
})

test("inbox can peek without acking", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.send({ to: "ses_self", text: "note" }, "ses_peer")

  await h.inbox({ markRead: false })
  assert.equal(h.mesh.mailbox.unreadCount("ses_self"), 1)
})

test("inbox filters by topic", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.send({ to: "ses_self", text: "auth", topic: "auth" }, "ses_peer")
  await h.send({ to: "ses_self", text: "db", topic: "db" }, "ses_peer")

  const output = await h.inbox({ topic: "auth" })
  assert.match(output, /1 message/)
  assert.match(output, /auth/)
  assert.doesNotMatch(output, /^\s+db$/m)
  assert.equal(h.mesh.mailbox.unreadCount("ses_self"), 1, "the other topic is untouched")
})

test("inbox reports a wait that expires", async () => {
  const h = harness({ realClock: true, maxWaitMs: 5 })
  h.mesh.applyEvent(createdEvent("ses_self"))
  const output = await h.inbox({ wait: 30 })
  assert.match(output, /0 messages/)
  assert.match(output, /nothing arrived before the wait expired/)
})

test("inbox waits and returns a message that arrives", async () => {
  const h = harness({ realClock: true, maxWaitMs: 2_000 })
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))

  const pending = h.inbox({ wait: 2 })
  setTimeout(() => {
    void h.send({ to: "ses_self", text: "landed" }, "ses_peer")
  }, 5)

  const output = await pending
  assert.match(output, /1 message/)
  assert.match(output, /landed/)
})

test("inbox rejects a negative wait", async () => {
  const h = harness()
  assert.match(await h.inbox({ wait: -1 }), /"wait" must be >= 0/)
})

// ── crosstalk_claim ──────────────────────────────────────────────────────────

test("claim takes a lease on a file and reports the duration", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  const output = await h.claim({ action: "claim", resources: ["src/auth.ts"], ttlSeconds: 120 })
  assert.match(output, /1 claimed/)
  assert.match(output, /\+ \/repo\/src\/auth\.ts {2}\(lease 120s\)/)
  assert.match(output, /you currently hold:/)
})

test("claim refuses a file another session holds and names the holder", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.claim({ action: "claim", resources: ["/repo/src/a.ts"], note: "migrating" }, "ses_peer")

  const output = await h.claim({ action: "claim", resources: ["/repo/src/a.ts"] })
  assert.match(output, /refused — 1 resource already leased/)
  assert.match(output, /a\.ts held by ses_peer \(migrating\)/)
  assert.match(output, /nothing was claimed \(atomic request\)/)
  assert.match(output, /crosstalk_wait/)
})

test("a batch claim takes nothing when one file is busy", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.claim({ action: "claim", resources: ["/repo/busy.ts"] }, "ses_peer")

  const output = await h.claim({ action: "claim", resources: ["/repo/free.ts", "/repo/busy.ts"] })
  assert.match(output, /refused/)
  assert.match(output, /nothing was claimed/)
  assert.equal(h.mesh.claims.isFree("/repo/free.ts"), true)
})

test("claim renews, releases, and lists", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))

  await h.claim({ action: "claim", resources: ["src/a.ts"] })
  assert.match(await h.claim({ action: "renew", resources: ["src/a.ts"] }), /1 renewed/)
  assert.match(await h.claim({ action: "list" }), /\/repo\/src\/a\.ts/)

  const released = await h.claim({ action: "release", resources: ["src/a.ts"] })
  assert.match(released, /1 released/)
  assert.match(await h.claim({ action: "list" }), /nothing to do/)
})

test("claim can be forced to steal a lease", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.claim({ action: "claim", resources: ["/repo/a.ts"] }, "ses_peer")

  const output = await h.claim({ action: "claim", resources: ["/repo/a.ts"], force: true })
  assert.match(output, /1 stolen from another session/)
  assert.deepEqual(h.mesh.claims.heldBy("ses_self"), ["/repo/a.ts"])
})

test("claim requires resources for everything but list", async () => {
  const h = harness()
  assert.match(await h.claim({ action: "claim" }), /needs "resources"/)
  assert.match(await h.claim({ action: "renew", resources: [] }), /needs "resources"/)
  assert.match(await h.claim({ action: "teleport" }), /"action" must be one of/)
  assert.match(await h.claim({ action: "teleport" }), /got "teleport"/)
})

test("claim infers the action when it is omitted", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))

  // The host validates against the JSON Schema before the executor runs, and
  // its "Missing key" message carries no guidance. Keep `action` optional so
  // the executor can infer it instead.
  const schema = h.tool("claim").input as { required?: string[] }
  assert.deepEqual(schema.required ?? [], [])

  assert.match(await h.claim({ resources: ["src/a.ts"], note: "editing", ttlSeconds: 120 }), /1 claimed/)
  assert.match(await h.claim({}), /you currently hold:/)
})

test("claim rejects a non-string resource list", async () => {
  const h = harness()
  assert.match(await h.claim({ action: "claim", resources: [42] }), /"resources" must be a list of strings/)
})

// ── crosstalk_wait ───────────────────────────────────────────────────────────

test("wait returns once a peer goes idle", async () => {
  const h = harness({ realClock: true, maxWaitMs: 2_000 })
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  h.mesh.applyEvent({ type: "session.execution.started", data: { sessionID: "ses_peer" } })

  const pending = h.wait({ for: "peer_idle", sessionID: "ses_peer", timeoutSeconds: 2 })
  setTimeout(() => {
    h.mesh.applyEvent({ type: "session.idle", data: { sessionID: "ses_peer" } })
  }, 5)

  assert.match(await pending, /peer idle after/)
})

test("wait reports a peer that is not on the channel", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  const output = await h.wait({ for: "peer_idle", sessionID: "ses_ghost", timeoutSeconds: 0 })
  assert.match(output, /is not on this channel any more/)
})

test("wait reports a timeout with the current holder", async () => {
  const h = harness({ realClock: true, maxWaitMs: 5 })
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.claim({ action: "claim", resources: ["/repo/a.ts"] }, "ses_peer")

  const output = await h.wait({ for: "claim_free", resource: "/repo/a.ts", timeoutSeconds: 30 })
  assert.match(output, /timed out after/)
  assert.match(output, /still held by ses_peer/)
})

test("wait returns as soon as a claim is released", async () => {
  const h = harness({ realClock: true, maxWaitMs: 2_000 })
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.claim({ action: "claim", resources: ["/repo/a.ts"] }, "ses_peer")

  const pending = h.wait({ for: "claim_free", resource: "/repo/a.ts", timeoutSeconds: 2 })
  setTimeout(() => {
    void h.claim({ action: "release", resources: ["/repo/a.ts"] }, "ses_peer")
  }, 5)

  assert.match(await pending, /claim free after/)
})

test("wait validates its mode and required arguments", async () => {
  const h = harness()
  assert.match(await h.wait({}), /^crosstalk: "for" is required — use "peer_idle"/)
  assert.match(await h.wait({ for: "forever" }), /must be "peer_idle" or "claim_free"/)
  assert.match(await h.wait({ for: "peer_idle" }), /needs "sessionID"/)
  assert.match(await h.wait({ for: "claim_free" }), /needs "resource"/)
  assert.match(
    await h.wait({ sessionID: "ses_peer", resource: "/repo/a.ts" }),
    /give "for" when both "sessionID" and "resource" are set/,
  )
})

test("wait infers the mode when it is omitted", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))

  const schema = h.tool("wait").input as { required?: string[] }
  assert.deepEqual(schema.required ?? [], [])

  assert.match(await h.wait({ sessionID: "ses_peer", timeoutSeconds: 0 }), /peer idle after/)
  assert.match(await h.wait({ resource: "/repo/free.ts", timeoutSeconds: 0 }), /claim free after/)
})

// ── argument reader ──────────────────────────────────────────────────────────

test("a non-object tool input is treated as empty rather than crashing", async () => {
  const h = harness()
  assert.match(await h.status(undefined), /you are ses_self/)
  assert.match(await h.claim("nonsense"), /you hold no leases/)
  assert.match(await h.inbox(42), /0 messages/)
})

test("argument errors name the offending key, and other failures still throw", async () => {
  const h = harness()
  const tool = h.tool("claim")
  // `ArgError` is turned into tool output so the model can correct itself.
  assert.match(await execTool(tool, { action: "claim", resources: "x".repeat(401) }, "ses_self"), /at most 400 characters/)
  // A genuine bug still surfaces as a real error rather than being swallowed.
  const broken = { ...tool, execute: async () => Promise.reject(new Error("kaboom")) }
  await assert.rejects(() => execTool(broken as never, {}, "ses_self"), /kaboom/)
})

// ── crosstalk_reply ──────────────────────────────────────────────────────────

test("reply answers the sender of a message by its id", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.status({ name: "Peer" }, "ses_peer")
  await h.mesh.send("ses_peer", { to: "ses_self", text: "review this", topic: "T#7" })
  const original = (await h.mesh.inbox("ses_self", { waitMs: 0, markRead: false })).messages[0]
  assert.ok(original)

  const output = await h.reply({ messageId: original.id, text: "on it" })
  assert.match(output, /in reply to/)
  assert.equal(h.deliverer.calls.at(-1)?.kind, "answer")
  assert.equal(h.deliverer.calls.at(-1)?.to, "ses_peer")
  assert.equal((h.deliverer.calls.at(-1)?.meta as { replyTo?: string } | undefined)?.replyTo, original.id)
  assert.equal(h.deliverer.calls.at(-1)?.topic, "T#7", "the thread is inherited")
})

test("reply refuses an id that is not in your inbox", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  assert.match(await h.reply({ messageId: "m404", text: "hi" }), /not in your inbox/)
})

// ── decline ──────────────────────────────────────────────────────────────────

test("a decline is delivered without demanding an answer", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.send({ to: "ses_peer", text: "fix the tui", kind: "decline" })
  assert.equal(h.deliverer.calls[0]?.kind, "decline")

  const inbox = await h.inbox({}, "ses_peer")
  assert.match(inbox, /decline/)
  assert.doesNotMatch(inbox, /answer with crosstalk_send/)
})

// ── evidence-bearing briefs ──────────────────────────────────────────────────

test("send carries writeScope, gate and evidence into the recipient's inbox", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  await h.send({
    to: "ses_peer",
    text: "T#1 build the reply tool",
    kind: "request",
    writeScope: ["src/tools/reply.ts", "test/tools.test.ts"],
    validation: "npm run check",
    evidence: "commit hash + gate result",
  })

  const meta = h.deliverer.calls[0]?.meta as { task?: Record<string, unknown> } | undefined
  assert.deepEqual(meta?.task?.writeScope, ["src/tools/reply.ts", "test/tools.test.ts"])
  assert.equal(meta?.task?.validation, "npm run check")
  assert.equal(meta?.task?.evidence, "commit hash + gate result")

  const inbox = await h.inbox({}, "ses_peer")
  assert.match(inbox, /brief: files src\/tools\/reply\.ts, test\/tools\.test\.ts/)
  assert.match(inbox, /gate npm run check/)
  assert.match(inbox, /evidence commit hash \+ gate result/)
})

// ── self-check ───────────────────────────────────────────────────────────────

test("status self-check reports scope, permission action and direct/code mode", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  const output = await h.status({})
  assert.match(output, /self-check:.*scope project/)
  assert.match(output, /self-check:.*action crosstalk/)
  assert.match(output, /self-check:.*direct/)

  const code = harness({}, { codemode: true, scope: "server", permission: "coord" })
  const codeOutput = await code.status({})
  assert.match(codeOutput, /scope server/)
  assert.match(codeOutput, /action coord/)
  assert.match(codeOutput, /code mode/)
})

test("status warns about a refused duplicate load", async () => {
  const holder = globalThis as { __crosstalk?: unknown }
  const previous = holder.__crosstalk
  holder.__crosstalk = { owners: new Map([["dir-a", Symbol("a")]]), refused: 1 }
  try {
    const h = harness()
    h.mesh.applyEvent(createdEvent("ses_self"))
    const output = await h.status({})
    assert.match(output, /duplicate install|twin install/i)
  } finally {
    if (previous === undefined) delete holder.__crosstalk
    else holder.__crosstalk = previous
  }
})

// ── crosstalk_continue ───────────────────────────────────────────────────────

test("continue steers an exact session id with a queued delivery", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  const output = await h.continue({ sessionID: "ses_peer", prompt: "resume T#1" })
  assert.match(output, /signalled 1 session/)
  assert.equal(h.deliverer.calls[0]?.to, "ses_peer")
  assert.equal(h.deliverer.calls[0]?.delivery, "queue")
})

test("continue refuses a session that is not on the channel", async () => {
  const h = harness()
  h.mesh.applyEvent(createdEvent("ses_self"))
  assert.match(await h.continue({ sessionID: "ses_ghost", prompt: "hi" }), /not on this channel/)
})

// ── loop guard ───────────────────────────────────────────────────────────────

test("loop guard warns on repeated identical sends and blocks the sixth", async () => {
  const h = harness({}, { loopGuard: true })
  h.mesh.applyEvent(createdEvent("ses_self"))
  h.mesh.applyEvent(createdEvent("ses_peer"))
  const outputs: string[] = []
  for (let i = 0; i < 6; i += 1) outputs.push(await h.send({ to: "ses_peer", text: "same" }))
  assert.match(outputs[2] ?? "", /repeated identical/)
  assert.match(outputs[5] ?? "", /blocked/)
})

test("loop guard leaves inbox reads unblocked", async () => {
  const h = harness({}, { loopGuard: true })
  h.mesh.applyEvent(createdEvent("ses_self"))
  for (let i = 0; i < 8; i += 1) assert.doesNotMatch(await h.inbox({}), /blocked/)
})
