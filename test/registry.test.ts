import assert from "node:assert/strict"
import { test } from "node:test"
import { Registry } from "../src/core/registry.ts"
import { createManualClock, createdEvent, event } from "./helpers/fakes.ts"

function registry() {
  const clock = createManualClock()
  return {
    clock,
    registry: new Registry({ now: () => clock.now(), staleAfterMs: 600_000, evictAfterMs: 3_600_000 }),
  }
}

test("session.created records identity, project, and directory", () => {
  const { registry: reg } = registry()
  const applied = reg.apply(
    createdEvent("ses_a", { title: "Fix login", agent: "build", parentID: "ses_root" }, 500),
  )

  assert.equal(applied, true)
  const peer = reg.get("ses_a")
  assert.ok(peer)
  assert.equal(peer.title, "Fix login")
  assert.equal(peer.agent, "build")
  assert.equal(peer.parentID, "ses_root")
  assert.equal(peer.projectID, "proj-1")
  assert.equal(peer.directory, "/repo")
  assert.equal(peer.status, "unknown")
  assert.equal(peer.lastSeen, 500)
})

test("execution.started and session.status move a peer through running and idle", () => {
  const { registry: reg } = registry()
  reg.apply(createdEvent("ses_a"))

  reg.apply(event("session.execution.started", { sessionID: "ses_a" }))
  assert.equal(reg.get("ses_a")?.status, "running")

  reg.apply(event("session.status", { sessionID: "ses_a", status: { type: "busy" } }))
  assert.equal(reg.get("ses_a")?.status, "running")

  reg.apply(event("session.status", { sessionID: "ses_a", status: { type: "retry", attempt: 2 } }))
  assert.equal(reg.get("ses_a")?.status, "running")

  reg.apply(event("session.status", { sessionID: "ses_a", status: { type: "idle" } }))
  assert.equal(reg.get("ses_a")?.status, "idle")
})

test("session.idle and terminal execution events all mean idle", () => {
  for (const type of ["session.idle", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]) {
    const { registry: reg } = registry()
    reg.apply(createdEvent("ses_a"))
    reg.apply(event("session.execution.started", { sessionID: "ses_a" }))
    reg.apply(event(type, { sessionID: "ses_a" }))
    assert.equal(reg.get("ses_a")?.status, "idle", `${type} should mark the peer idle`)
  }
})

test("session.tool.called marks the peer running and refreshes activity", () => {
  const { registry: reg, clock } = registry()
  reg.apply(createdEvent("ses_a", {}, 1_000))
  clock.set(2_000)

  reg.apply(event("session.tool.called", { sessionID: "ses_a", id: "call-1", input: {} }, 2_000))

  const peer = reg.get("ses_a")
  assert.equal(peer?.status, "running")
  assert.equal(peer?.lastSeen, 2_000)
})

test("a status event for a session never seen created still registers it", () => {
  const { registry: reg } = registry()
  assert.equal(reg.size, 0)
  reg.apply(event("session.status", { sessionID: "ses_late", status: { type: "busy" } }, 42))
  const peer = reg.get("ses_late")
  assert.equal(peer?.status, "running")
  assert.equal(peer?.lastSeen, 42)
})

test("renamed, moved, and forked update the record they name", () => {
  const { registry: reg } = registry()
  reg.apply(createdEvent("ses_a", { title: "old" }))

  reg.apply(event("session.renamed", { sessionID: "ses_a", title: "new" }))
  assert.equal(reg.get("ses_a")?.title, "new")

  reg.apply(event("session.moved", { sessionID: "ses_a", location: { directory: "/repo/wt" }, projectID: "proj-2" }))
  assert.equal(reg.get("ses_a")?.directory, "/repo/wt")
  assert.equal(reg.get("ses_a")?.projectID, "proj-2")

  reg.apply(event("session.forked", { sessionID: "ses_b", parentID: "ses_a", boundary: { type: "before" } }))
  assert.equal(reg.get("ses_b")?.parentID, "ses_a")
})

test("session.deleted removes the record", () => {
  const { registry: reg } = registry()
  reg.apply(createdEvent("ses_a"))
  assert.equal(reg.apply(event("session.deleted", { sessionID: "ses_a" })), true)
  assert.equal(reg.get("ses_a"), undefined)
})

test("malformed and unrelated events are ignored", () => {
  const { registry: reg } = registry()
  assert.equal(reg.apply({ type: "session.created" }), false)
  assert.equal(reg.apply({ type: "session.created", data: {} }), false)
  assert.equal(reg.apply({ type: "tui.theme.changed", data: { theme: "dark" } }), false)
  assert.equal(reg.size, 0)
})

test("model references are flattened to a readable label", () => {
  const { registry: reg } = registry()
  reg.apply(createdEvent("ses_a", { model: { providerID: "anthropic", id: "claude-sonnet-4-5", variant: "high" } }))
  assert.equal(reg.get("ses_a")?.model, "anthropic/claude-sonnet-4-5#high")
})

test("stale peers are flagged but kept; lapsed peers are evicted", () => {
  const { registry: reg, clock } = registry()
  reg.apply(createdEvent("ses_fresh", {}, clock.now()))
  reg.apply(createdEvent("ses_old", {}, clock.now() - 700_000))

  clock.advance(0)
  assert.equal(reg.isStale(reg.get("ses_old")!), true)
  assert.equal(reg.isStale(reg.get("ses_fresh")!), false)

  const removed = reg.prune()
  assert.deepEqual(removed, [])
  clock.advance(3_600_001)
  assert.deepEqual(reg.prune().sort(), ["ses_fresh", "ses_old"])
  assert.equal(reg.size, 0)
})

test("list orders running peers first, then by recency, and hides self by default", () => {
  const { registry: reg, clock } = registry()
  reg.apply(createdEvent("ses_self", {}, clock.now()))
  reg.apply(createdEvent("ses_idle", {}, clock.now()))
  reg.apply(event("session.idle", { sessionID: "ses_idle" }, clock.now()))
  reg.apply(createdEvent("ses_busy_recent", {}, clock.now()))
  reg.apply(event("session.execution.started", { sessionID: "ses_busy_recent" }, clock.now()))
  reg.apply(createdEvent("ses_busy_old", {}, clock.now() - 60_000))
  reg.apply(event("session.execution.started", { sessionID: "ses_busy_old" }, clock.now() - 60_000))

  const peers = reg.list({ selfID: "ses_self" })
  assert.deepEqual(
    peers.map((peer) => peer.sessionID),
    ["ses_busy_recent", "ses_busy_old", "ses_idle"],
  )

  const withSelf = reg.list({ selfID: "ses_self", includeSelf: true })
  assert.equal(withSelf.length, 4)

  assert.deepEqual(
    reg.list({ selfID: "ses_self", status: "idle" }).map((peer) => peer.sessionID),
    ["ses_idle"],
  )
})

test("list sorts deterministically for equal timestamps", () => {
  const { registry: reg } = registry()
  for (const id of ["ses_c", "ses_a", "ses_b"]) reg.apply(createdEvent(id, {}, 1_000))
  assert.deepEqual(
    reg.list().map((peer) => peer.sessionID),
    ["ses_a", "ses_b", "ses_c"],
  )
})

test("project scope hides other projects but keeps unknown-project peers", () => {
  const { registry: reg } = registry()
  reg.apply(createdEvent("ses_self", { projectID: "proj-1" }))
  reg.apply(createdEvent("ses_same", { projectID: "proj-1" }))
  reg.apply(createdEvent("ses_other", { projectID: "proj-9" }))
  reg.apply(event("session.status", { sessionID: "ses_unknown", status: { type: "busy" } }))

  const visible = reg.list({ selfID: "ses_self", scope: "project" }).map((peer) => peer.sessionID)
  assert.deepEqual(visible.sort(), ["ses_same", "ses_unknown"])
})

test("strict project scope excludes peers whose project cannot be proven", () => {
  const { registry: reg } = registry()
  reg.apply(createdEvent("ses_self", { projectID: "proj-1" }))
  reg.apply(createdEvent("ses_same", { projectID: "proj-1" }))
  reg.apply(createdEvent("ses_other", { projectID: "proj-9" }))
  reg.apply(event("session.status", { sessionID: "ses_unknown", status: { type: "busy" } }))

  const strict = reg.list({ selfID: "ses_self", scope: "project", strict: true }).map((peer) => peer.sessionID)
  assert.deepEqual(strict, ["ses_same"], "the wall only knows provable peers")
})

test("strict location scope requires a provable directory", () => {
  const { registry: reg } = registry()
  reg.apply(createdEvent("ses_self", { location: { directory: "/repo" } }))
  reg.apply(createdEvent("ses_same_dir", { location: { directory: "/repo" } }))
  reg.apply(createdEvent("ses_worktree", { location: { directory: "/repo/wt" } }))
  reg.apply(event("session.status", { sessionID: "ses_unknown", status: { type: "busy" } }))

  const strict = reg.list({ selfID: "ses_self", scope: "location", strict: true }).map((peer) => peer.sessionID)
  assert.deepEqual(strict, ["ses_same_dir"])
})

test("location scope compares directories", () => {
  const { registry: reg } = registry()
  reg.apply(createdEvent("ses_self", { location: { directory: "/repo" } }))
  reg.apply(createdEvent("ses_same_dir", { location: { directory: "/repo" } }))
  reg.apply(createdEvent("ses_worktree", { location: { directory: "/repo/wt" } }))

  const visible = reg.list({ selfID: "ses_self", scope: "location" }).map((peer) => peer.sessionID)
  assert.deepEqual(visible, ["ses_same_dir"])
})

test("server scope shows everything and list honours a limit", () => {
  const { registry: reg } = registry()
  for (const id of ["ses_a", "ses_b", "ses_c"]) reg.apply(createdEvent(id, { projectID: `p-${id}` }))
  assert.equal(reg.list({ scope: "server" }).length, 3)
  assert.equal(reg.list({ scope: "server", limit: 2 }).length, 2)
  assert.equal(reg.list({ scope: "server", limit: 0 }).length, 0)
})

test("ensure creates a placeholder and never overwrites an existing record", () => {
  const { registry: reg } = registry()
  const created = reg.ensure("ses_child", { projectID: "proj-1", directory: "/repo", agent: "general" })
  assert.equal(created.status, "unknown")
  assert.equal(created.agent, "general")

  reg.apply(event("session.execution.started", { sessionID: "ses_child" }))
  const again = reg.ensure("ses_child", { agent: "build" })
  assert.equal(again.agent, "general", "ensure must not clobber observed state")
  assert.equal(again.status, "running")
})
