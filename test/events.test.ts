import assert from "node:assert/strict"
import { test } from "node:test"
import { asCrosstalkEvent, pumpEvents } from "../src/events.ts"
import { createEventStream } from "./helpers/fakes.ts"

test("asCrosstalkEvent narrows a well-formed event", () => {
  const event = asCrosstalkEvent({
    type: "session.created",
    created: 42,
    data: { sessionID: "ses_a" },
    location: { directory: "/repo" },
  })
  assert.deepEqual(event, {
    type: "session.created",
    created: 42,
    data: { sessionID: "ses_a" },
    location: { directory: "/repo" },
  })
})

test("asCrosstalkEvent rejects anything the reducer cannot use", () => {
  assert.equal(asCrosstalkEvent(undefined), undefined)
  assert.equal(asCrosstalkEvent("session.created"), undefined)
  assert.equal(asCrosstalkEvent({ data: { sessionID: "ses_a" } }), undefined)
  // A usable type with unusable data is still a real event; the registry simply
  // finds no sessionID in it.
  assert.deepEqual(asCrosstalkEvent({ type: "x", data: [] }), { type: "x" })
  assert.deepEqual(asCrosstalkEvent({ type: "x", data: "nope" }), { type: "x" })
})

test("asCrosstalkEvent keeps a valueless event usable", () => {
  const event = asCrosstalkEvent({ type: "server.connected" })
  assert.deepEqual(event, { type: "server.connected" })
})

test("pumpEvents feeds every event to the sink", async () => {
  const stream = createEventStream()
  const controller = new AbortController()
  const seen: string[] = []
  const pumping = pumpEvents(stream, controller.signal, { onEvent: (event) => seen.push(event.type) })

  stream.push({ type: "session.created", data: { sessionID: "ses_a" } })
  stream.push({ type: "session.idle", data: { sessionID: "ses_a" } })
  await stream.settle()
  stream.close()
  await pumping

  assert.deepEqual(seen, ["session.created", "session.idle"])
})

test("pumpEvents skips unusable items without stopping", async () => {
  const stream = createEventStream()
  const controller = new AbortController()
  const seen: string[] = []
  const pumping = pumpEvents(stream, controller.signal, { onEvent: (event) => seen.push(event.type) })

  stream.push("garbage")
  stream.push({ noType: true })
  stream.push({ type: "session.idle", data: { sessionID: "ses_a" } })
  await stream.settle()
  stream.close()
  await pumping

  assert.deepEqual(seen, ["session.idle"])
})

test("a throwing sink is reported and the stream continues", async () => {
  const stream = createEventStream()
  const controller = new AbortController()
  const seen: string[] = []
  const errors: unknown[] = []
  const pumping = pumpEvents(stream, controller.signal, {
    onEvent: (event) => {
      seen.push(event.type)
      if (event.type === "session.created") throw new Error("boom")
    },
    onError: (error) => errors.push(error),
  })

  stream.push({ type: "session.created", data: { sessionID: "ses_a" } })
  stream.push({ type: "session.idle", data: { sessionID: "ses_a" } })
  await stream.settle()
  stream.close()
  await pumping

  assert.deepEqual(seen, ["session.created", "session.idle"])
  assert.equal(errors.length, 1)
  assert.match(String(errors[0]), /boom/)
})

test("a stream error is reported once and does not throw out of the pump", async () => {
  const errors: unknown[] = []
  const failing = {
    subscribe() {
      return {
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          yield { type: "session.created", data: { sessionID: "ses_a" } }
          throw new Error("socket closed")
        },
      }
    },
  }
  const seen: string[] = []
  await pumpEvents(failing, new AbortController().signal, {
    onEvent: (event) => seen.push(event.type),
    onError: (error) => errors.push(error),
  })
  assert.deepEqual(seen, ["session.created"])
  assert.match(String(errors[0]), /socket closed/)
})

test("aborting stops the pump and drops later events", async () => {
  const stream = createEventStream()
  const controller = new AbortController()
  const seen: string[] = []
  const pumping = pumpEvents(stream, controller.signal, { onEvent: (event) => seen.push(event.type) })

  stream.push({ type: "session.created", data: { sessionID: "ses_a" } })
  await stream.settle(1)
  controller.abort()
  stream.push({ type: "session.idle", data: { sessionID: "ses_a" } })
  await pumping

  assert.deepEqual(seen, ["session.created"], "no events are applied after abort")
})

test("the abort signal is forwarded to the stream", async () => {
  let received: AbortSignal | undefined
  const stream = {
    subscribe(options?: { signal?: AbortSignal }) {
      received = options?.signal
      return { async *[Symbol.asyncIterator]() {} }
    },
  }
  const controller = new AbortController()
  await pumpEvents(stream, controller.signal, { onEvent: () => {} })
  assert.equal(received, controller.signal)
})
