import assert from "node:assert/strict"
import { test } from "node:test"
import { Mailbox } from "../src/core/mailbox.ts"
import { createManualClock } from "./helpers/fakes.ts"

function mailbox(overrides: { maxPerSession?: number; ttlMs?: number } = {}) {
  const clock = createManualClock()
  const box = new Mailbox({
    now: () => clock.now(),
    maxPerSession: overrides.maxPerSession ?? 100,
    ttlMs: overrides.ttlMs ?? 86_400_000,
    idFactory: (seq) => `m${seq}`,
  })
  return { clock, box }
}

test("send appends one copy per recipient in order", () => {
  const { box } = mailbox()
  const sent = box.send({ from: "ses_a", to: ["ses_b", "ses_c"], text: "hello" })

  assert.equal(sent.length, 2)
  assert.deepEqual(
    sent.map((m) => m.to),
    ["ses_b", "ses_c"],
  )
  assert.deepEqual(
    sent.map((m) => m.id),
    ["m1", "m2"],
  )
  assert.equal(box.list("ses_b").length, 1)
  assert.equal(box.list("ses_c").length, 1)
  assert.equal(box.list("ses_a").length, 0, "the sender keeps no copy")
})

test("message fields default sensibly and carry overrides", () => {
  const { box } = mailbox()
  const sent = box.send({
    from: "ses_a",
    fromRole: "reviewer",
    to: ["ses_b"],
    text: "please stop",
    topic: "auth",
    kind: "request",
    delivery: "queue",
    meta: { requested: "reviewer" },
  })
  const msg = sent[0]
  assert.ok(msg, "one message should have been recorded")

  assert.equal(msg.kind, "request")
  assert.equal(msg.delivery, "queue")
  assert.equal(msg.topic, "auth")
  assert.equal(msg.fromRole, "reviewer")
  assert.deepEqual(msg.meta, { requested: "reviewer" })

  const plain = box.send({ from: "ses_a", to: ["ses_c"], text: "hi" })[0]
  assert.ok(plain)
  assert.equal(plain.kind, "message")
  assert.equal(plain.delivery, "steer")
  assert.equal(plain.readAt, undefined)
})

test("unread counting and markRead transitions", () => {
  const { box } = mailbox()
  box.send({ from: "ses_a", to: ["ses_b"], text: "one" })
  box.send({ from: "ses_a", to: ["ses_b"], text: "two" })
  assert.equal(box.unreadCount("ses_b"), 2)

  assert.equal(box.markRead("ses_b", ["m1"]), 1)
  assert.equal(box.unreadCount("ses_b"), 1)
  assert.equal(box.markRead("ses_b", ["m1"]), 0, "already-read messages are not counted twice")

  assert.equal(box.markRead("ses_b"), 1)
  assert.equal(box.unreadCount("ses_b"), 0)
  assert.equal(box.markRead("ses_unknown"), 0)
})

test("list filters by unread, topic, cursor, and limit", () => {
  const { box } = mailbox()
  box.send({ from: "ses_a", to: ["ses_b"], text: "one", topic: "auth" })
  box.send({ from: "ses_a", to: ["ses_b"], text: "two", topic: "db" })
  box.send({ from: "ses_a", to: ["ses_b"], text: "three", topic: "auth" })

  assert.equal(box.list("ses_b", { topic: "auth" }).length, 2)
  assert.deepEqual(
    box.list("ses_b", { since: "m1" }).map((m) => m.text),
    ["two", "three"],
  )
  assert.deepEqual(
    box.list("ses_b", { since: "does-not-exist" }).map((m) => m.text),
    ["one", "two", "three"],
    "an unknown cursor returns everything rather than nothing",
  )
  assert.deepEqual(
    box.list("ses_b", { limit: 1 }).map((m) => m.text),
    ["three"],
  )

  box.markRead("ses_b")
  assert.equal(box.list("ses_b", { unreadOnly: true }).length, 0)
})

test("the cap evicts read messages before unread ones", () => {
  const { box } = mailbox({ maxPerSession: 3 })
  box.send({ from: "ses_a", to: ["ses_b"], text: "1" })
  box.send({ from: "ses_a", to: ["ses_b"], text: "2" })
  box.markRead("ses_b")
  box.send({ from: "ses_a", to: ["ses_b"], text: "3" })
  box.send({ from: "ses_a", to: ["ses_b"], text: "4" })

  const kept = box.list("ses_b").map((m) => m.text)
  assert.deepEqual(kept, ["2", "3", "4"], "the read pair was sacrificed before the unread new mail")
  assert.equal(box.unreadCount("ses_b"), 2)
})

test("the cap falls back to dropping the oldest when everything is unread", () => {
  const { box } = mailbox({ maxPerSession: 2 })
  box.send({ from: "ses_a", to: ["ses_b"], text: "1" })
  box.send({ from: "ses_a", to: ["ses_b"], text: "2" })
  box.send({ from: "ses_a", to: ["ses_b"], text: "3" })
  assert.deepEqual(
    box.list("ses_b").map((m) => m.text),
    ["2", "3"],
  )
})

test("expired messages are pruned on read and by prune()", () => {
  const { box, clock } = mailbox({ ttlMs: 1_000 })
  box.send({ from: "ses_a", to: ["ses_b"], text: "old" })
  clock.advance(1_001)
  assert.equal(box.list("ses_b").length, 0)
  assert.equal(box.unreadCount("ses_b"), 0)

  box.send({ from: "ses_a", to: ["ses_b"], text: "new" })
  clock.advance(1_001)
  assert.equal(box.prune(), 1)
  assert.equal(box.size, 0)
})

test("wait returns immediately when mail is already waiting", async () => {
  const { box } = mailbox()
  box.send({ from: "ses_a", to: ["ses_b"], text: "already here" })
  const result = await box.wait("ses_b", 60_000)
  assert.equal(result.reason, "messages")
  assert.deepEqual(
    result.messages.map((m) => m.text),
    ["already here"],
  )
})

test("wait times out with no mail", async () => {
  const { box } = mailbox()
  const result = await box.wait("ses_b", 20)
  assert.equal(result.reason, "timeout")
  assert.deepEqual(result.messages, [])
})

test("a send wakes a blocked waiter", async () => {
  const { box } = mailbox()
  const waiting = box.wait("ses_b", 60_000)
  box.send({ from: "ses_a", to: ["ses_b"], text: "wake up" })
  const result = await waiting
  assert.equal(result.reason, "messages")
  assert.deepEqual(
    result.messages.map((m) => m.text),
    ["wake up"],
  )
})

test("several waiters on one mailbox are all released", async () => {
  const { box } = mailbox()
  const first = box.wait("ses_b", 60_000)
  const second = box.wait("ses_b", 60_000)
  box.send({ from: "ses_a", to: ["ses_b"], text: "broadcast" })

  const results = await Promise.all([first, second])
  for (const result of results) {
    assert.equal(result.reason, "messages")
    assert.equal(result.messages.length, 1)
  }
})

test("a send to another mailbox does not wake this one", async () => {
  const { box } = mailbox()
  const waiting = box.wait("ses_b", 30)
  box.send({ from: "ses_a", to: ["ses_c"], text: "elsewhere" })
  assert.equal((await waiting).reason, "timeout")
})

test("abort resolves a blocked wait instead of throwing", async () => {
  const { box } = mailbox()
  const controller = new AbortController()
  const waiting = box.wait("ses_b", 60_000, controller.signal)
  controller.abort()
  const result = await waiting
  assert.equal(result.reason, "aborted")
  assert.deepEqual(result.messages, [])
})

test("a wait on an already-aborted signal resolves immediately", async () => {
  const { box } = mailbox()
  const controller = new AbortController()
  controller.abort()
  assert.equal((await box.wait("ses_b", 60_000, controller.signal)).reason, "aborted")
})

test("a timed-out waiter is deregistered and does not leak", async () => {
  const { box } = mailbox()
  await box.wait("ses_b", 10)
  assert.equal(box.size, 0)
  // A later send must not try to resolve a finished waiter.
  assert.doesNotThrow(() => box.send({ from: "ses_a", to: ["ses_b"], text: "after" }))
})

test("clear drops a mailbox entirely", () => {
  const { box } = mailbox()
  box.send({ from: "ses_a", to: ["ses_b"], text: "x" })
  box.clear("ses_b")
  assert.equal(box.size, 0)
  assert.equal(box.unreadCount("ses_b"), 0)
})
