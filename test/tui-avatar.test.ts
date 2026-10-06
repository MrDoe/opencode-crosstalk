import assert from "node:assert/strict"
import { test } from "node:test"
import { chooseAvatar, hash, poolHint, type AvatarEntry } from "../src/tui/avatar.ts"

const entries: AvatarEntry[] = [
  { file: "f-coder.png", pool: "female", role: "coder" },
  { file: "m-coder.png", pool: "male", role: "coder" },
  { file: "f-writer.png", pool: "female", role: "writer" },
  { file: "m-writer.png", pool: "male", role: "writer" },
]

test("poolHint reads the declared emoji", () => {
  assert.equal(poolHint("👩"), "female")
  assert.equal(poolHint("👨🏽"), "male")
  assert.equal(poolHint("🧑"), undefined)
  assert.equal(poolHint(undefined), undefined)
})

test("a matching role wins inside the hinted pool", () => {
  assert.equal(chooseAvatar(entries, { sessionID: "s1", role: "coder", avatar: "👩" })?.file, "f-coder.png")
  assert.equal(chooseAvatar(entries, { sessionID: "s1", role: "coder", avatar: "👨" })?.file, "m-coder.png")
})

test("without a hint a role match still wins", () => {
  const picked = chooseAvatar(entries, { sessionID: "s1", role: "writer" })
  assert.equal(picked?.role, "writer")
})

test("an unknown role falls back to a stable entry inside the pool", () => {
  const first = chooseAvatar(entries, { sessionID: "s1", name: "Rita", role: "gardener", avatar: "👩" })
  const second = chooseAvatar(entries, { sessionID: "s2", name: "Rita", role: "gardener", avatar: "👩" })
  assert.equal(first?.pool, "female")
  assert.equal(first?.file, second?.file, "same name and pool pick the same avatar")
})

test("the same name picks the same avatar across calls", () => {
  const a = chooseAvatar(entries, { sessionID: "s1", name: "Rita" })
  const b = chooseAvatar(entries, { sessionID: "s9", name: "Rita" })
  assert.equal(a?.file, b?.file)
})

test("no entries means no avatar", () => {
  assert.equal(chooseAvatar([], { sessionID: "s1" }), undefined)
})

test("hash is stable and unsigned", () => {
  assert.equal(hash("Rita"), hash("Rita"))
  assert.ok(hash("Rita") >= 0)
  assert.notEqual(hash("Rita"), hash("George"))
})
