import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULTS, parseOptions } from "../src/config.ts"

test("absent options yield the documented defaults with no warnings", () => {
  for (const input of [undefined, null]) {
    const { options, warnings } = parseOptions(input)
    assert.deepEqual(options, DEFAULTS)
    assert.deepEqual(warnings, [])
  }
})

test("a non-object options value falls back to defaults with a warning", () => {
  for (const input of ["nope", 42, [1, 2]]) {
    const { options, warnings } = parseOptions(input)
    assert.deepEqual(options, DEFAULTS)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? "", /must be an object/)
  }
})

test("valid values pass through", () => {
  const { options, warnings } = parseOptions({
    namespace: "mesh",
    permission: "coord",
    codemode: true,
    scope: "server",
    staleAfterMs: 1_000,
    evictAfterMs: 10_000,
    maxMessages: 5,
    messageTtlMs: 2_000,
    claimTtlMs: 3_000,
    maxWaitMs: 4_000,
    pollMs: 500,
    heartbeatMs: 0,
    persist: false,
    storageKey: "mesh/v1",
    announce: false,
  })
  assert.deepEqual(warnings, [])
  assert.equal(options.namespace, "mesh")
  assert.equal(options.permission, "coord")
  assert.equal(options.codemode, true)
  assert.equal(options.scope, "server")
  assert.equal(options.maxMessages, 5)
  assert.equal(options.heartbeatMs, 0)
  assert.equal(options.persist, false)
  assert.equal(options.storageKey, "mesh/v1")
  assert.equal(options.announce, false)
})

test("unknown keys are reported but not fatal", () => {
  const { options, warnings } = parseOptions({ nonsense: true })
  assert.deepEqual(options, DEFAULTS)
  assert.match(warnings[0] ?? "", /unknown option "nonsense"/)
})

test("a bad scope is rejected in favour of the default", () => {
  const { options, warnings } = parseOptions({ scope: "galaxy" })
  assert.equal(options.scope, "project")
  assert.match(warnings[0] ?? "", /scope.*project, location, server/)
})

test("non-numeric durations fall back and warn", () => {
  const { options, warnings } = parseOptions({ maxWaitMs: "soon", pollMs: Number.NaN })
  assert.equal(options.maxWaitMs, DEFAULTS.maxWaitMs)
  assert.equal(options.pollMs, DEFAULTS.pollMs)
  assert.equal(warnings.length, 2)
})

test("durations are clamped to sane bounds", () => {
  const { options, warnings } = parseOptions({
    maxWaitMs: 10_000_000,
    pollMs: 1,
    maxMessages: 0,
    claimTtlMs: 999_999_999,
  })
  assert.equal(options.maxWaitMs, 600_000)
  assert.equal(options.pollMs, 50)
  assert.equal(options.maxMessages, 1)
  assert.equal(options.claimTtlMs, 86_400_000)
  assert.equal(warnings.length, 4)
})

test("eviction can never be more eager than the stale threshold", () => {
  const { options } = parseOptions({ staleAfterMs: 600_000, evictAfterMs: 1_000 })
  assert.equal(options.evictAfterMs, 600_000)
  assert.ok(options.evictAfterMs >= options.staleAfterMs)
})

test("booleans are validated", () => {
  assert.equal(parseOptions({ codemode: "yes" }).options.codemode, DEFAULTS.codemode)
  assert.match(parseOptions({ persist: 1 }).warnings[0] ?? "", /must be a boolean/)
})

test("names are validated against the characters the host accepts", () => {
  assert.equal(parseOptions({ namespace: "bad namespace" }).options.namespace, DEFAULTS.namespace)
  assert.equal(parseOptions({ namespace: "" }).options.namespace, DEFAULTS.namespace)
  assert.equal(parseOptions({ permission: "a.b" }).options.permission, DEFAULTS.permission)
  assert.equal(parseOptions({ storageKey: "a b" }).options.storageKey, DEFAULTS.storageKey)
  assert.equal(parseOptions({ namespace: "ok_name-1" }).options.namespace, "ok_name-1")
})

test("a namespace with characters the host rewrites is refused", () => {
  // Dots become underscores in the effective tool name, which would silently
  // desynchronize the permission resource from the tool.
  assert.equal(parseOptions({ namespace: "a.b" }).options.namespace, DEFAULTS.namespace)
})
