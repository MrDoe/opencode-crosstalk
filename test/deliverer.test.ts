import assert from "node:assert/strict"
import { test } from "node:test"
import { renderDelivery } from "../src/deliverer.ts"
import type { CrosstalkMessage } from "../src/types.ts"

function message(overrides: Partial<CrosstalkMessage> = {}): CrosstalkMessage {
  return {
    id: "msg_1",
    seq: 1,
    from: "ses_sender",
    to: "ses_self",
    text: "plain note",
    kind: "message",
    delivery: "steer",
    created: 1_700_000_000_000,
    meta: { requested: "coordinator" },
    ...overrides,
  }
}

test("a plain message is not steered into replying", () => {
  const text = renderDelivery(message())
  assert.equal(text.includes("Acknowledge"), false, "a note carries no reply demand")
  assert.match(text, /Read it with crosstalk_inbox/)
})

test("a request steers an answer addressed to its sender by name", () => {
  const text = renderDelivery(message({ kind: "request", fromName: "Ada", text: "hold src/a.ts" }))
  assert.match(text, /answer with crosstalk_send addressed to Ada/)
})

test("a request without a declared name falls back to the session id", () => {
  const text = renderDelivery(message({ kind: "request", text: "rename your session" }))
  assert.match(text, /answer with crosstalk_send addressed to ses_sender/)
})
