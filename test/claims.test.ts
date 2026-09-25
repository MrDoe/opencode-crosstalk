import assert from "node:assert/strict"
import { test } from "node:test"
import { ClaimTable, normalizeResource } from "../src/core/claims.ts"
import { createManualClock } from "./helpers/fakes.ts"

function table(overrides: { defaultTtlMs?: number } = {}) {
  const clock = createManualClock()
  return {
    clock,
    claims: new ClaimTable({ now: () => clock.now(), defaultTtlMs: overrides.defaultTtlMs ?? 300_000 }),
  }
}

test("normalization collapses the ways one path can be written", () => {
  assert.equal(normalizeResource("src/a.ts"), "src/a.ts")
  assert.equal(normalizeResource("./src/a.ts"), "src/a.ts")
  assert.equal(normalizeResource("src//a.ts"), "src/a.ts")
  assert.equal(normalizeResource("src/b/../a.ts"), "src/a.ts")
  assert.equal(normalizeResource("  src/a.ts  "), "src/a.ts")
  assert.equal(normalizeResource("/repo/src/a.ts"), "/repo/src/a.ts")
  assert.equal(normalizeResource("/repo/./src//a.ts"), "/repo/src/a.ts")
  assert.equal(normalizeResource("/repo/x/../a.ts"), "/repo/a.ts")
  assert.equal(normalizeResource("src\\a.ts"), "src/a.ts", "backslashes become slashes")
  assert.equal(normalizeResource(""), "")
})

test("POSIX paths keep their case, Windows paths do not", () => {
  assert.equal(normalizeResource("src/Auth.ts"), "src/Auth.ts")
  assert.equal(normalizeResource("src\\Auth.ts"), "src/auth.ts")
  assert.equal(normalizeResource("C:\\Repo\\A.ts"), "c:/repo/a.ts")
})

test("relative paths resolve against the holder's directory", () => {
  assert.equal(normalizeResource("src/a.ts", "/repo/wt-1"), "/repo/wt-1/src/a.ts")
  assert.equal(normalizeResource("src/a.ts", "/repo/wt-2"), "/repo/wt-2/src/a.ts")
  assert.notEqual(normalizeResource("src/a.ts", "/repo/wt-1"), normalizeResource("src/a.ts", "/repo/wt-2"))
  assert.equal(normalizeResource("../shared.ts", "/repo/wt-1"), "/repo/shared.ts")
})

test("two spellings of one path collide on a claim", () => {
  const { claims } = table()
  claims.claim({ holder: "ses_a", resources: ["./src/a.ts"], baseDir: "/repo" })
  const outcome = claims.claim({ holder: "ses_b", resources: ["src//a.ts"], baseDir: "/repo" })
  assert.equal(outcome.conflicts.length, 1)
  assert.equal(outcome.conflicts[0]?.key, "/repo/src/a.ts")
  assert.equal(outcome.conflicts[0]?.holder, "ses_a")
})

test("a batch claim is atomic: one conflict takes nothing", () => {
  const { claims } = table()
  claims.claim({ holder: "ses_a", resources: ["src/free.ts"] })

  const outcome = claims.claim({
    holder: "ses_b",
    resources: ["src/one.ts", "src/free.ts", "src/two.ts"],
  })

  assert.equal(outcome.rolledBack, true)
  assert.deepEqual(outcome.conflicts.map((c) => c.key), ["src/free.ts"])
  assert.deepEqual(outcome.claimed, [])
  assert.equal(claims.isFree("src/one.ts"), true, "the free file was not taken either")
  assert.equal(claims.isFree("src/two.ts"), true)
})

test("atomic: false claims whatever is free and reports the rest", () => {
  const { claims } = table()
  claims.claim({ holder: "ses_a", resources: ["src/busy.ts"] })

  const outcome = claims.claim({
    holder: "ses_b",
    resources: ["src/busy.ts", "src/free.ts"],
    atomic: false,
  })

  assert.equal(outcome.rolledBack, false)
  assert.deepEqual(outcome.claimed, ["src/free.ts"])
  assert.deepEqual(outcome.conflicts.map((c) => c.key), ["src/busy.ts"])
})

test("re-claiming a resource you already hold renews instead of conflicting", () => {
  const { clock, claims } = table({ defaultTtlMs: 1_000 })
  claims.claim({ holder: "ses_a", resources: ["src/a.ts"] })
  clock.advance(500)

  const outcome = claims.claim({ holder: "ses_a", resources: ["src/a.ts"], ttlMs: 1_000, note: "still going" })
  assert.deepEqual(outcome.renewed, ["src/a.ts"])
  assert.deepEqual(outcome.claimed, [])
  assert.equal(claims.list({ holder: "ses_a" })[0]?.expires, clock.now() + 1_000)
  assert.equal(claims.list({ holder: "ses_a" })[0]?.note, "still going")
})

test("duplicates and blanks inside one request collapse", () => {
  const { claims } = table()
  const outcome = claims.claim({ holder: "ses_a", resources: ["src/a.ts", "./src/a.ts", "  ", "src/a.ts"] })
  assert.deepEqual(outcome.claimed, ["src/a.ts"])
})

test("an expired lease is free for the taking", () => {
  const { clock, claims } = table({ defaultTtlMs: 1_000 })
  claims.claim({ holder: "ses_a", resources: ["src/a.ts"] })
  clock.advance(1_001)

  assert.equal(claims.isFree("src/a.ts"), true)
  const outcome = claims.claim({ holder: "ses_b", resources: ["src/a.ts"] })
  assert.deepEqual(outcome.claimed, ["src/a.ts"])
  assert.deepEqual(outcome.conflicts, [])
})

test("force steals a live lease and records it", () => {
  const { claims } = table()
  claims.claim({ holder: "ses_a", resources: ["src/a.ts"], note: "refactor" })
  const outcome = claims.claim({ holder: "ses_b", resources: ["src/a.ts"], force: true })

  assert.deepEqual(outcome.stolen, ["src/a.ts"])
  assert.deepEqual(outcome.claimed, ["src/a.ts"])
  assert.equal(claims.heldBy("ses_a").length, 0)
  assert.equal(claims.heldBy("ses_b").length, 1)
})

test("release frees a lease, but only for its holder unless forced", () => {
  const { claims } = table()
  claims.claim({ holder: "ses_a", resources: ["src/a.ts"] })

  const refused = claims.release({ holder: "ses_b", resources: ["src/a.ts"] })
  assert.deepEqual(refused.conflicts.map((c) => c.holder), ["ses_a"])
  assert.equal(claims.isFree("src/a.ts"), false)

  const forced = claims.release({ holder: "ses_b", resources: ["src/a.ts"], force: true })
  assert.deepEqual(forced.stolen, ["src/a.ts"])
  assert.deepEqual(forced.released, ["src/a.ts"])
  assert.equal(claims.isFree("src/a.ts"), true)
})

test("releasing something unheld is a no-op, not an error", () => {
  const { claims } = table()
  const outcome = claims.release({ holder: "ses_a", resources: ["src/never.ts", ""] })
  assert.deepEqual(outcome.released, [])
  assert.deepEqual(outcome.conflicts, [])
})

test("renew extends only leases the caller holds", () => {
  const { clock, claims } = table({ defaultTtlMs: 1_000 })
  claims.claim({ holder: "ses_a", resources: ["src/a.ts"] })
  claims.claim({ holder: "ses_b", resources: ["src/b.ts"] })

  const refused = claims.renew({ holder: "ses_a", resources: ["src/b.ts"] })
  assert.equal(refused.rolledBack, true)
  assert.deepEqual(refused.conflicts.map((c) => c.holder), ["ses_b"])

  const ok = claims.renew({ holder: "ses_a", resources: ["src/a.ts"] })
  assert.deepEqual(ok.renewed, ["src/a.ts"])
  assert.equal(claims.list({ holder: "ses_a" })[0]?.expires, clock.now() + 1_000)
})

test("renew reports a lapsed lease as a conflict, naming its last holder", () => {
  const { clock, claims } = table({ defaultTtlMs: 100 })
  claims.claim({ holder: "ses_a", resources: ["src/a.ts"] })
  clock.advance(200)
  const outcome = claims.renew({ holder: "ses_a", resources: ["src/a.ts"] })
  assert.equal(outcome.rolledBack, true)
  assert.equal(outcome.conflicts[0]?.holder, "ses_a")
  assert.deepEqual(outcome.renewed, [])
})

test("list filters by holder and resource, and hides lapsed leases by default", () => {
  const { clock, claims } = table({ defaultTtlMs: 1_000 })
  claims.claim({ holder: "ses_a", resources: ["src/a.ts"], note: "note-a" })
  claims.claim({ holder: "ses_b", resources: ["src/b.ts"] })
  clock.advance(1_001)

  assert.equal(claims.list().length, 0, "lapsed leases are hidden by default")
  assert.equal(claims.list({ includeExpired: true }).length, 2)
  assert.equal(claims.list({ holder: "ses_a", includeExpired: true }).length, 1)
  assert.equal(claims.list({ resource: "src/b.ts", includeExpired: true }).length, 1)
  assert.equal(claims.list({ resource: "src/b.ts", holder: "ses_a", includeExpired: true }).length, 0)
})

test("list output is sorted by key", () => {
  const { claims } = table()
  claims.claim({ holder: "ses_a", resources: ["src/z.ts", "src/a.ts", "src/m.ts"] })
  assert.deepEqual(
    claims.list().map((c) => c.key),
    ["src/a.ts", "src/m.ts", "src/z.ts"],
  )
})

test("prune deletes lapsed leases and reports the count", () => {
  const { clock, claims } = table({ defaultTtlMs: 1_000 })
  claims.claim({ holder: "ses_a", resources: ["src/a.ts", "src/b.ts"] })
  clock.advance(1_001)
  assert.equal(claims.prune(), 2)
  assert.equal(claims.size, 0)
})

test("adopt re-inserts a claim verbatim, as snapshot restore does", () => {
  const { claims } = table()
  claims.adopt({ key: "src/a.ts", raw: "./src/a.ts", holder: "ses_a", acquired: 1, expires: 2_000_000_000_000 })
  assert.equal(claims.heldBy("ses_a")[0], "src/a.ts")
})

test("named resources need no path handling", () => {
  const { claims } = table()
  claims.claim({ holder: "ses_a", resources: ["db:migrate"] })
  const outcome = claims.claim({ holder: "ses_b", resources: ["db:migrate"] })
  assert.equal(outcome.conflicts[0]?.key, "db:migrate")
})
