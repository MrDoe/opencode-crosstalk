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
  mesh.declare("ses_self", { role: "reviewer", goal: "audit auth" })
  clock.advance(60_000)

  const merged = mesh.declare("ses_self", { goal: "audit auth + sessions" })
  assert.equal(merged.declared?.role, "reviewer", "role survives a partial update")
  assert.equal(merged.declared?.goal, "audit auth + sessions")
  assert.equal(merged.lastSeen, clock.now(), "declaring counts as activity")
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
