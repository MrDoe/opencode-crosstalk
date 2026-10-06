import assert from "node:assert/strict"
import { test } from "node:test"
import { Mesh } from "../src/core/mesh.ts"
import { createdEvent, createManualClock, createTestMesh, event, meshOptions } from "./helpers/fakes.ts"

test("peers excludes the caller and decorates with unread counts and claims", async () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self", { title: "mine" }))
  mesh.applyEvent(createdEvent("ses_peer", { title: "theirs" }))
  mesh.claim("ses_peer", { action: "claim", resources: ["src/a.ts"] })
  await mesh.send("ses_peer", { to: "ses_self", text: "hi" })

  const peers = mesh.peers("ses_self")
  assert.deepEqual(
    peers.map((peer) => peer.sessionID),
    ["ses_peer"],
  )
  assert.deepEqual(peers[0]?.claims, ["/repo/src/a.ts"], "claims are reported by normalized key")

  const self = mesh.view("ses_self")
  assert.equal(self.isSelf, true)
  assert.equal(self.unread, 1)
  assert.equal(self.claims.length, 0)
})

test("ensureSelf registers a session the stream never announced", () => {
  const { mesh } = createTestMesh()
  assert.equal(mesh.registry.size, 0)
  const self = mesh.view("ses_orphan")
  assert.equal(self.projectID, "proj-1", "falls back to the plugin location")
  assert.equal(self.directory, "/repo")
})

test("declare merges, leaving unmentioned fields alone, and refreshes activity", async () => {
  const { mesh, clock } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.declare("ses_self", { name: "George", role: "reviewer", goal: "audit auth" })
  clock.advance(60_000)

  const merged = mesh.declare("ses_self", { goal: "audit auth + sessions" })
  assert.equal(merged.view.declared?.name, "George", "the name survives a partial update")
  assert.equal(merged.view.declared?.role, "reviewer", "role survives a partial update")
  assert.equal(merged.view.declared?.goal, "audit auth + sessions")
  assert.equal(merged.view.lastSeen, clock.now(), "declaring counts as activity")
})

test("subscribe observes declarations and events", () => {
  const { mesh } = createTestMesh()
  let calls = 0
  const stop = mesh.subscribe(() => {
    calls += 1
  })
  mesh.applyEvent(createdEvent("ses_a"))
  assert.equal(calls, 1)
  mesh.declare("ses_a", { name: "Rita" })
  assert.equal(calls, 2)
  stop()
  mesh.applyEvent(createdEvent("ses_b"))
  assert.equal(calls, 2, "an unsubscribed listener stops hearing")
})

test("restore fills gaps on a record the live stream already created", () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(event("session.status", { sessionID: "ses_live" }))
  assert.equal(mesh.registry.get("ses_live")?.projectID, undefined)

  mesh.restore({
    version: 1,
    savedAt: 0,
    peers: [
      {
        sessionID: "ses_live",
        status: "idle",
        lastSeen: 1,
        projectID: "proj-1",
        directory: "/repo",
        title: "restored title",
        declared: { name: "Rita", role: "coder" },
      },
    ],
    claims: [],
  })

  const restored = mesh.registry.get("ses_live")
  assert.equal(restored?.projectID, "proj-1", "the snapshot supplies what the stream never carried")
  assert.equal(restored?.directory, "/repo")
  assert.equal(restored?.title, "restored title")
  assert.equal(restored?.declared?.name, "Rita")
  assert.equal(restored?.status, "unknown", "live status is not overwritten by the snapshot")
})

test("restore keeps live fields when both sides have them", () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_a", { title: "live title" }))
  mesh.declare("ses_a", { name: "Live" })
  mesh.restore({
    version: 1,
    savedAt: 0,
    peers: [{ sessionID: "ses_a", status: "idle", lastSeen: 1, title: "stale title", declared: { name: "Stale" } }],
    claims: [],
  })
  const peer = mesh.registry.get("ses_a")
  assert.equal(peer?.title, "live title", "a live title is newer than the snapshot")
  assert.equal(peer?.declared?.name, "Live")
})

// ── portraits ────────────────────────────────────────────────────────────────

const personaPool = [
  { file: "f-coder.png", pool: "female", role: "coder" },
  { file: "m-manager.png", pool: "male", role: "manager" },
  { file: "f-writer.png", pool: "female", role: "writer" },
]

test("the first task-bearing declaration freezes the portrait", () => {
  const { mesh } = createTestMesh({ avatars: personaPool })
  mesh.declare("ses_a", { name: "Rita", role: "coder", goal: "avatars" })
  const frozen = mesh.registry.get("ses_a")?.portrait
  assert.equal(frozen, "female/f-coder.png", "the matching role inside the pool wins")

  mesh.declare("ses_a", { role: "manager", avatar: "👨" })
  assert.equal(mesh.registry.get("ses_a")?.portrait, frozen, "a later role or hint cannot move the artwork")
})

test("a bare name is not a task, so the portrait waits for one", () => {
  const { mesh } = createTestMesh({ avatars: personaPool })
  mesh.declare("ses_a", { name: "Rita", note: "just saying hi" })
  assert.equal(mesh.registry.get("ses_a")?.portrait, undefined, "no role, no goal: no avatar")

  mesh.declare("ses_a", { role: "writer" })
  assert.equal(mesh.registry.get("ses_a")?.portrait, "female/f-writer.png", "the first task assigns it")
})

test("assignPortraits backfills restored task-bearing peers without moving frozen ones", () => {
  const { mesh } = createTestMesh({ avatars: personaPool })
  mesh.restore({
    version: 1,
    savedAt: 0,
    peers: [
      { sessionID: "ses_old", status: "idle", lastSeen: 1, declared: { name: "Rita", role: "coder" } },
      {
        sessionID: "ses_set",
        status: "idle",
        lastSeen: 1,
        declared: { name: "Max", role: "manager" },
        portrait: "male/m-manager.png",
      },
    ],
    claims: [],
  })
  assert.equal(mesh.registry.get("ses_old")?.portrait, undefined)

  assert.equal(mesh.assignPortraits(), 1, "only the missing portrait is assigned")
  assert.ok(mesh.registry.get("ses_old")?.portrait)
  assert.equal(mesh.registry.get("ses_set")?.portrait, "male/m-manager.png", "a frozen portrait survives")
})

test("send to a known peer delivers and records in their mailbox", async () => {
  const { mesh, deliverer } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_peer"))
  mesh.declare("ses_self", { role: "migrator" })

  const outcome = await mesh.send("ses_self", { to: "ses_peer", text: "handing over", topic: "db" })

  assert.deepEqual(outcome.recipients, [{ sessionID: "ses_peer", delivered: true, reason: undefined }])
  assert.equal(deliverer.calls.length, 1)
  assert.equal(deliverer.calls[0]?.fromRole, "migrator")
  assert.equal(mesh.mailbox.unreadCount("ses_peer"), 1)
  assert.equal(mesh.mailbox.list("ses_peer")[0]?.topic, "db")
})

test("a failed injection still leaves the message in the mailbox", async () => {
  const { mesh, deliverer } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_far"))
  deliverer.failFor.add("ses_far")

  const outcome = await mesh.send("ses_self", { to: "ses_far", text: "still important" })

  assert.equal(outcome.recipients[0]?.delivered, false)
  assert.match(outcome.recipients[0]?.reason ?? "", /busy/)
  assert.equal(mesh.mailbox.unreadCount("ses_far"), 1, "the mailbox is the durable path")
})

test("send resolves a declared role, case-insensitively", async () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_a"))
  mesh.applyEvent(createdEvent("ses_b"))
  mesh.declare("ses_a", { role: "Reviewer" })
  mesh.declare("ses_b", { role: "tester" })

  const outcome = await mesh.send("ses_self", { role: "reviewer", text: "look at this" })
  assert.deepEqual(
    outcome.recipients.map((r) => r.sessionID),
    ["ses_a"],
  )
})

test("declare accepts a unique human name and refuses a taken one", () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_peer"))

  const first = mesh.declare("ses_self", { name: "George", role: "reviewer" })
  assert.equal(first.nameConflict, undefined)
  assert.equal(first.view.declared?.name, "George")

  // Case-insensitive uniqueness; the conflict names the holder and changes nothing.
  const refused = mesh.declare("ses_peer", { name: "george", role: "tester" })
  assert.deepEqual(refused.nameConflict, { name: "george", holder: "ses_self" })
  assert.equal(refused.view.declared?.name, undefined, "the conflicting name is not applied")
  assert.equal(refused.view.declared?.role, undefined, "the rest of the declaration is not applied either")

  // Redeclaring the same name is not a conflict.
  assert.equal(mesh.declare("ses_self", { name: "George" }).nameConflict, undefined)
})

test("send addresses a peer by declared name, case-insensitively", async () => {
  const { mesh, deliverer } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_a"))
  mesh.declare("ses_a", { name: "Alexandra" })

  const outcome = await mesh.send("ses_self", { to: "alexandra", text: "look at this" })
  assert.deepEqual(outcome.recipients.map((r) => r.sessionID), ["ses_a"])
  assert.equal(deliverer.calls.length, 1)
})

test("send refuses a name nobody declared", async () => {
  const { mesh, deliverer } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_a"))
  mesh.declare("ses_a", { name: "Alex" })

  const outcome = await mesh.send("ses_self", { to: "Bob", text: "x" })
  assert.match(outcome.skipped[0]?.reason ?? "", /session unknown/)
  assert.deepEqual(outcome.recipients, [])
  assert.equal(deliverer.calls.length, 0, "no message is recorded for an unresolvable name")
})

test("a message carries the sender's name", async () => {
  const { mesh, deliverer } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_peer"))
  mesh.declare("ses_self", { name: "George" })

  await mesh.send("ses_self", { to: "ses_peer", text: "hi" })
  assert.equal(deliverer.calls[0]?.fromName, "George")
  assert.equal(mesh.mailbox.list("ses_peer")[0]?.fromName, "George")
})

test("a peer with an unknown project is listed but not addressable", async () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(event("session.status", { sessionID: "ses_unknown", status: { type: "busy" } }))

  const peers = mesh.peers("ses_self")
  assert.deepEqual(peers.map((p) => p.sessionID), ["ses_unknown"], "listing still over-reports")
  assert.equal(peers[0]?.addressable, false, "the communication wall excludes unknown locations")

  const outcome = await mesh.send("ses_self", { to: "ses_unknown", text: "x" })
  assert.match(outcome.skipped[0]?.reason ?? "", /outside the project scope/)
  assert.deepEqual(outcome.recipients, [])
})

test("all and role sends skip peers with an unknown project", async () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_a"))
  mesh.applyEvent(createdEvent("ses_b"))
  mesh.applyEvent(event("session.status", { sessionID: "ses_unknown", status: { type: "busy" } }))
  mesh.declare("ses_unknown", { role: "tester" })

  const all = await mesh.send("ses_self", { all: true, text: "heads up" })
  assert.deepEqual(all.recipients.map((r) => r.sessionID).sort(), ["ses_a", "ses_b"])

  const byRole = await mesh.send("ses_self", { role: "tester", text: "x" })
  assert.deepEqual(byRole.recipients, [], "an unknown-location role holder is not addressable")
  assert.match(byRole.skipped[0]?.reason ?? "", /no peer declared/)
})

test("waitForPeerIdle refuses a target outside the project scope", async () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_elsewhere", { projectID: "proj-9" }))

  const result = await mesh.waitForPeerIdle("ses_self", "ses_elsewhere", 5_000)
  assert.equal(result.reason, "outside")
  assert.equal(result.elapsedMs, 0, "the refusal is immediate, not a timeout")
})

test("a queued injection is not delivered to a session that moved out of the project", async () => {
  const { mesh, deliverer } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_sender"))
  mesh.applyEvent(createdEvent("ses_peer"))
  deliverer.failFor.add("ses_peer")
  await mesh.send("ses_sender", { to: "ses_peer", text: "moved away" })
  assert.equal(mesh.pendingInjectionCount("ses_peer"), 1)

  mesh.applyEvent(
    event("session.moved", { sessionID: "ses_peer", location: { directory: "/elsewhere" }, projectID: "proj-9" }),
  )
  const callsBefore = deliverer.calls.length
  assert.equal(await mesh.flushPendingInjection("ses_peer"), 0)
  assert.equal(deliverer.calls.length, callsBefore, "no injection crosses the wall")
  assert.equal(mesh.pendingInjectionCount("ses_peer"), 1, "the message is held, not dropped")
})

test("send rejects unusable targets with a reason instead of guessing", async () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_peer"))

  assert.match((await mesh.send("ses_self", { text: "x" })).skipped[0]?.reason ?? "", /to.*role.*all/)
  assert.match((await mesh.send("ses_self", { to: "ses_nope", text: "x" })).skipped[0]?.reason ?? "", /unknown/)
  assert.match((await mesh.send("ses_self", { to: "ses_self", text: "x" })).skipped[0]?.reason ?? "", /you/)
  assert.match(
    (await mesh.send("ses_self", { to: "   ", text: "x" })).skipped[0]?.reason ?? "",
    /no session id/,
  )
  assert.match(
    (await mesh.send("ses_self", { role: "ghost", text: "x" })).skipped[0]?.reason ?? "",
    /no peer declared/,
  )
})

test("send to all fans out to every visible peer but not the sender", async () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_a"))
  mesh.applyEvent(createdEvent("ses_b"))
  mesh.applyEvent(createdEvent("ses_elsewhere", { projectID: "proj-9" }))

  const outcome = await mesh.send("ses_self", { all: true, text: "heads up" })
  assert.deepEqual(
    outcome.recipients.map((r) => r.sessionID).sort(),
    ["ses_a", "ses_b"],
  )
})

test("a target outside the configured scope is refused", async () => {
  const { mesh } = createTestMesh({ scope: "location" })
  mesh.applyEvent(createdEvent("ses_self", { location: { directory: "/repo" } }))
  mesh.applyEvent(createdEvent("ses_other_dir", { location: { directory: "/elsewhere" } }))

  const outcome = await mesh.send("ses_self", { to: "ses_other_dir", text: "x" })
  assert.match(outcome.skipped[0]?.reason ?? "", /outside the location scope/)
  assert.deepEqual(outcome.recipients, [])
})

test("an aborted send reports remaining recipients as cancelled", async () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_a"))
  const controller = new AbortController()
  controller.abort()

  const outcome = await mesh.send("ses_self", { all: true, text: "x" }, controller.signal)
  assert.equal(outcome.recipients[0]?.delivered, false)
  assert.equal(outcome.recipients[0]?.reason, "cancelled")
  assert.equal(mesh.mailbox.unreadCount("ses_a"), 1, "mail is still recorded")
})

test("inbox marks read by default and leaves messages alone on request", async () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_peer"))
  await mesh.send("ses_peer", { to: "ses_self", text: "note" })

  const peeked = await mesh.inbox("ses_self", { markRead: false })
  assert.equal(peeked.marked, 0)
  assert.equal(peeked.unread, 1)

  const read = await mesh.inbox("ses_self", {})
  assert.equal(read.marked, 1)
  assert.equal(read.unread, 0)
  assert.equal(read.reason, "immediate")
})

test("inbox passes topic, unread, and limit filters through", async () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_peer"))
  await mesh.send("ses_peer", { to: "ses_self", text: "auth thing", topic: "auth" })
  await mesh.send("ses_peer", { to: "ses_self", text: "db thing", topic: "db" })

  const auth = await mesh.inbox("ses_self", { topic: "auth" })
  assert.deepEqual(
    auth.messages.map((m) => m.text),
    ["auth thing"],
  )
  assert.equal(auth.marked, 1, "only the filtered message is acked")
  assert.equal(auth.unread, 1)
})

test("inbox with a wait is capped by the configured maximum", async () => {
  const { mesh } = createTestMesh({ realClock: true, maxWaitMs: 5 })
  mesh.applyEvent(createdEvent("ses_self"))
  const outcome = await mesh.inbox("ses_self", { waitMs: 60_000 })
  assert.equal(outcome.reason, "timeout")
})

test("claim resolves relative resources against the session's directory", () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self", { location: { directory: "/repo/wt" } }))
  mesh.claim("ses_self", { action: "claim", resources: ["src/a.ts"] })
  assert.deepEqual(mesh.claims.heldBy("ses_self"), ["/repo/wt/src/a.ts"])
})

test("claim actions map through and report held leases", () => {
  const { mesh, clock } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_peer"))

  const claimed = mesh.claim("ses_self", { action: "claim", resources: ["a.ts"], ttlMs: 1_000, note: "mine" })
  assert.deepEqual(claimed.outcome.claimed, ["/repo/a.ts"])

  const blocked = mesh.claim("ses_peer", { action: "claim", resources: ["/repo/a.ts"] })
  assert.equal(blocked.outcome.conflicts.length, 1)
  assert.equal(blocked.outcome.conflicts[0]?.note, "mine")

  const renewed = mesh.claim("ses_self", { action: "renew", resources: ["a.ts"], ttlMs: 1_000 })
  assert.deepEqual(renewed.outcome.renewed, ["/repo/a.ts"])
  assert.equal(renewed.held[0]?.expires, clock.now() + 1_000)

  const listed = mesh.claim("ses_self", { action: "list" })
  assert.equal(listed.held.length, 1)

  const released = mesh.claim("ses_self", { action: "release", resources: ["a.ts"] })
  assert.deepEqual(released.outcome.released, ["/repo/a.ts"])
  assert.equal(released.held.length, 0)
})

test("claim clamps the lease to a day", () => {
  const { mesh, clock } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  const result = mesh.claim("ses_self", { action: "claim", resources: ["a.ts"], ttlMs: 999_999_999 })
  assert.equal(result.held[0]?.expires, clock.now() + 86_400_000)
})

test("waitForPeerIdle returns as soon as the peer reports idle", async () => {
  const clock = createManualClock()
  const mesh = new Mesh({ options: meshOptions({ pollMs: 1 }), clock, defaults: { projectID: "p", directory: "/repo" } })
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_peer"))
  mesh.applyEvent(event("session.execution.started", { sessionID: "ses_peer" }))

  const waiting = mesh.waitForPeerIdle("ses_self", "ses_peer", 5_000)
  mesh.applyEvent(event("session.idle", { sessionID: "ses_peer" }))
  const result = await waiting

  assert.equal(result.reason, "done")
  assert.equal(result.status, "idle")
})

test("waitForPeerIdle reports a target that vanished and refuses to wait on self", async () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  assert.equal((await mesh.waitForPeerIdle("ses_self", "ses_self", 10)).reason, "gone")
  assert.equal((await mesh.waitForPeerIdle("ses_self", "ses_never", 10)).reason, "gone")
})

test("waitForPeerIdle times out while the peer stays busy and aborts on signal", async () => {
  const { mesh } = createTestMesh({ realClock: true, maxWaitMs: 5 })
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_peer"))
  mesh.applyEvent(event("session.execution.started", { sessionID: "ses_peer" }))

  const timedOut = await mesh.waitForPeerIdle("ses_self", "ses_peer", 5_000)
  assert.equal(timedOut.reason, "timeout")
  assert.equal(timedOut.status, "running")

  const controller = new AbortController()
  controller.abort()
  assert.equal((await mesh.waitForPeerIdle("ses_self", "ses_peer", 5_000, controller.signal)).reason, "aborted")
})

test("waitForClaimFree resolves when the holder releases or the lease lapses", async () => {
  const { mesh, clock } = createTestMesh({ maxWaitMs: 5_000 })
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_peer"))
  mesh.claim("ses_peer", { action: "claim", resources: ["src/a.ts"], ttlMs: 1_000 })

  const waiting = mesh.waitForClaimFree("ses_self", "src/a.ts", 5_000, "/repo")
  mesh.claim("ses_peer", { action: "release", resources: ["src/a.ts"] })
  assert.equal((await waiting).reason, "done")

  mesh.claim("ses_peer", { action: "claim", resources: ["src/b.ts"], ttlMs: 1_000 })
  const lapsing = mesh.waitForClaimFree("ses_self", "src/b.ts", 5_000, "/repo")
  clock.advance(1_001)
  assert.equal((await lapsing).reason, "done")
})

test("waitForClaimFree times out with the holder named", async () => {
  const { mesh } = createTestMesh({ realClock: true, maxWaitMs: 5 })
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_peer"))
  mesh.claim("ses_peer", { action: "claim", resources: ["src/a.ts"] })

  const result = await mesh.waitForClaimFree("ses_self", "src/a.ts", 5_000, "/repo")
  assert.equal(result.reason, "timeout")
  assert.equal(result.holder, "ses_peer")
})

test("a failed injection is retried the next time the recipient acts", async () => {
  const { mesh, deliverer } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_peer"))
  deliverer.failFor.add("ses_peer")

  await mesh.send("ses_self", { to: "ses_peer", text: "cross-location" })
  assert.equal(mesh.pendingInjectionCount("ses_peer"), 1)

  deliverer.failFor.delete("ses_peer")
  const delivered = await mesh.flushPendingInjection("ses_peer")

  assert.equal(delivered, 1)
  assert.equal(mesh.pendingInjectionCount("ses_peer"), 0)
  assert.equal(deliverer.calls.length, 2, "the retry is a real second injection")
  assert.equal(mesh.mailbox.unreadCount("ses_peer"), 1, "the mailbox copy was never lost")
})

test("a retry that keeps failing stays queued, and stops on abort", async () => {
  const { mesh, deliverer } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_peer"))
  deliverer.failFor.add("ses_peer")
  await mesh.send("ses_self", { to: "ses_peer", text: "still failing" })

  assert.equal(await mesh.flushPendingInjection("ses_peer"), 0)
  assert.equal(mesh.pendingInjectionCount("ses_peer"), 1)

  const controller = new AbortController()
  controller.abort()
  assert.equal(await mesh.flushPendingInjection("ses_peer", controller.signal), 0)
  assert.equal(mesh.pendingInjectionCount("ses_peer"), 1, "an aborted retry is not an error")
})

test("a queued injection for a session that later disappears is held, not dropped", async () => {
  const { mesh, deliverer } = createTestMesh()
  mesh.applyEvent(createdEvent("mes_sender"))
  mesh.applyEvent(createdEvent("ses_ghost"))
  deliverer.failFor.add("ses_ghost")
  await mesh.send("mes_sender", { to: "ses_ghost", text: "anyone there?" })
  assert.equal(mesh.pendingInjectionCount("ses_ghost"), 1)

  // The session is deleted before the recipient ever acts, so there is nothing
  // to inject into — but the message must survive for the mailbox.
  mesh.applyEvent(event("session.deleted", { sessionID: "ses_ghost" }))
  const callsBefore = deliverer.calls.length
  assert.equal(await mesh.flushPendingInjection("ses_ghost"), 0)
  assert.equal(deliverer.calls.length, callsBefore, "no injection is attempted for a vanished session")
  assert.equal(mesh.pendingInjectionCount("ses_ghost"), 1)
})

test("an unknown target is refused before any message is recorded", async () => {
  const { mesh, deliverer } = createTestMesh()
  mesh.applyEvent(createdEvent("mes_sender"))
  const outcome = await mesh.send("mes_sender", { to: "ses_ghost", text: "anyone there?" })
  assert.match(outcome.skipped[0]?.reason ?? "", /unknown/)
  assert.equal(mesh.pendingInjectionCount("ses_ghost"), 0)
  assert.equal(mesh.mailbox.size, 0)
})

test("flushing an inbox with nothing queued does no work", async () => {
  const { mesh, deliverer } = createTestMesh()
  assert.equal(await mesh.flushPendingInjection("ses_never_seen"), 0)
  assert.equal(deliverer.calls.length, 0)
})

test("queued injections expire with the message TTL", async () => {
  const { mesh, clock, deliverer } = createTestMesh({ messageTtlMs: 1_000 })
  mesh.applyEvent(createdEvent("ses_self"))
  mesh.applyEvent(createdEvent("ses_peer"))
  deliverer.failFor.add("ses_peer")
  await mesh.send("ses_self", { to: "ses_peer", text: "short lived" })

  clock.advance(1_001)
  deliverer.failFor.delete("ses_peer")
  assert.equal(await mesh.flushPendingInjection("ses_peer"), 0, "an expired message is not injected late")
  assert.equal(mesh.pendingInjectionCount("ses_peer"), 0)
})

test("the pending queue is bounded", async () => {
  const { mesh, deliverer } = createTestMesh()
  mesh.applyEvent(createdEvent("mes_sender"))
  mesh.applyEvent(createdEvent("ses_peer"))
  deliverer.failFor.add("ses_peer")
  for (let index = 0; index < 60; index += 1) {
    await mesh.send("mes_sender", { to: "ses_peer", text: `message ${index}` })
  }
  assert.equal(mesh.pendingInjectionCount("ses_peer"), 50, "oldest queued injections are dropped first")
})

test("snapshot carries peers and claims but not messages", async () => {
  const { mesh } = createTestMesh()
  mesh.applyEvent(createdEvent("ses_self", { title: "one" }))
  mesh.applyEvent(createdEvent("ses_peer"))
  mesh.claim("ses_peer", { action: "claim", resources: ["src/a.ts"] })
  await mesh.send("ses_self", { to: "ses_peer", text: "secret plans" })

  const snapshot = mesh.snapshot()
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.peers.length, 2)
  assert.equal(snapshot.claims.length, 1)
  assert.equal(JSON.stringify(snapshot).includes("secret plans"), false)
})

test("restore fills gaps without clobbering live state", () => {
  const { mesh } = createTestMesh()
  const snapshot = {
    version: 1,
    savedAt: 0,
    peers: [
      { sessionID: "ses_live", status: "idle" as const, lastSeen: 1, title: "stale title" },
      { sessionID: "ses_restored", status: "running" as const, lastSeen: 2, title: "restored", agent: "plan" },
      { sessionID: "ses_expired_claim", status: "idle" as const, lastSeen: 3 },
      null,
    ],
    claims: [
      { key: "/repo/src/a.ts", raw: "src/a.ts", holder: "ses_restored", acquired: 0, expires: 9_999_999_999_999 },
      { key: "/repo/src/old.ts", raw: "src/old.ts", holder: "ses_restored", acquired: 0, expires: 1 },
      { key: "/repo/src/held.ts", raw: "src/held.ts", holder: "other", acquired: 0, expires: 9_999_999_999_999 },
    ],
  }

  mesh.applyEvent(createdEvent("ses_live"))
  mesh.claim("ses_live", { action: "claim", resources: ["/repo/src/held.ts"] })
  mesh.restore(snapshot as never)

  assert.equal(mesh.registry.get("ses_live")?.title, "session", "live event data wins")
  assert.equal(mesh.registry.get("ses_restored")?.agent, "plan")
  assert.deepEqual(mesh.claims.heldBy("ses_restored"), ["/repo/src/a.ts"])
  assert.deepEqual(mesh.claims.heldBy("ses_live"), ["/repo/src/held.ts"], "a live lease is not overwritten")
})

test("a snapshot round-trips through a second mesh", () => {
  const first = createTestMesh()
  first.mesh.applyEvent(createdEvent("ses_self", { title: "original" }))
  first.mesh.applyEvent(createdEvent("ses_peer", { title: "peer" }))
  first.mesh.claim("ses_peer", { action: "claim", resources: ["src/a.ts"] })
  const snapshot = first.mesh.snapshot()

  const second = createTestMesh()
  second.mesh.restore(snapshot)

  assert.equal(second.mesh.registry.get("ses_peer")?.title, "peer")
  assert.deepEqual(second.mesh.claims.heldBy("ses_peer"), ["/repo/src/a.ts"])
})

test("applyEvent evicts lapsed peers as it goes", () => {
  const clock = createManualClock()
  const mesh = new Mesh({
    options: meshOptions({ staleAfterMs: 1_000, evictAfterMs: 2_000 }),
    clock,
    defaults: { projectID: "p" },
  })
  mesh.applyEvent(createdEvent("ses_old", {}, clock.now()))
  clock.advance(2_001)
  mesh.applyEvent(event("session.idle", { sessionID: "ses_fresh" }, clock.now()))
  assert.equal(mesh.registry.get("ses_old"), undefined)
  assert.ok(mesh.registry.get("ses_fresh"))
})
