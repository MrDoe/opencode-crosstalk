import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import {
  chooseAvatar,
  EMOTICONS,
  emoticonFor,
  entryForPortrait,
  hash,
  poolHint,
  stripEmoticon,
  titleWithEmoticon,
  type AvatarEntry,
} from "../src/tui/avatar.ts"

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

test("entryForPortrait resolves the frozen path, or nothing", () => {
  assert.equal(entryForPortrait(entries, "female/f-coder.png")?.file, "f-coder.png")
  assert.equal(entryForPortrait(entries, "male/f-coder.png"), undefined, "the pool is part of the key")
  assert.equal(entryForPortrait(entries, "female/gone.png"), undefined, "art that left the manifest has no entry")
  assert.equal(entryForPortrait(entries, undefined), undefined, "no portrait: no avatar")
})

test("hash is stable and unsigned", () => {
  assert.equal(hash("Rita"), hash("Rita"))
  assert.ok(hash("Rita") >= 0)
  assert.notEqual(hash("Rita"), hash("George"))
})

// ── emoticons ────────────────────────────────────────────────────────────────

const manifest = JSON.parse(
  readFileSync(new URL("../assets/avatars/manifest.json", import.meta.url), "utf8"),
) as { entries: AvatarEntry[] }

test("every shipped avatar role has a curated emoticon", () => {
  const roles = new Set(manifest.entries.map((entry) => entry.role))
  assert.ok(roles.size > 0, "the manifest has entries")
  for (const role of roles) assert.ok(EMOTICONS[role], `role "${role}" is missing from EMOTICONS`)
})

test("a role's emoticons are things or persons, never a smiley", () => {
  const glyphs = new Set([...Object.values(EMOTICONS).flat()])
  for (const glyph of glyphs) {
    for (const char of glyph) {
      const cp = char.codePointAt(0) ?? 0
      // The Emoticons block is the yellow faces; ☹ ☺ ☻ are the text smileys.
      const smiley = (cp >= 0x1f600 && cp <= 0x1f64f) || cp === 0x2639 || cp === 0x263a || cp === 0x263b
      assert.ok(!smiley, `"${glyph}" is a smiley`)
    }
  }
})

test("each role leads with an emoticon of its own", () => {
  const primaries = Object.values(EMOTICONS).map((candidates) => candidates[0])
  assert.equal(new Set(primaries).size, primaries.length, "no two roles share a primary emoticon")
})

test("an avatar's emoticon is stable, and an unknown role still gets one", () => {
  const coder: AvatarEntry = { file: "03-coder-92594b.png", pool: "female", role: "coder" }
  assert.equal(emoticonFor(coder), emoticonFor({ ...coder, skin: "000000" }), "only the file decides the alternate")
  assert.ok(emoticonFor({ file: "99-novel-abcdef.png", pool: "female", role: "glassblower" }).length > 0)
  assert.ok(emoticonFor(undefined).length > 0)
})

test("avatars are spread over more than one emoticon", () => {
  const glyphs = new Set(manifest.entries.map((entry) => emoticonFor(entry)))
  assert.ok(glyphs.size >= manifest.entries.length / 2, `${glyphs.size} glyphs for ${manifest.entries.length} avatars`)
})

test("stripEmoticon only removes a managed lead glyph", () => {
  assert.equal(stripEmoticon("💻 Talk to other sessions"), "Talk to other sessions")
  assert.equal(stripEmoticon("💻  Talk"), "Talk", "the separator space goes with it")
  assert.equal(stripEmoticon("🎉 party"), "🎉 party", "a glyph the user typed stays")
  assert.equal(stripEmoticon("fix 💻 bug"), "fix 💻 bug", "only the lead is managed")
})

test("titleWithEmoticon is idempotent and does not invent a title", () => {
  assert.equal(titleWithEmoticon("Talk to other sessions", "💻"), "💻 Talk to other sessions")
  assert.equal(titleWithEmoticon("💻 Talk to other sessions", "💻"), undefined, "already decorated: nothing to write")
  assert.equal(titleWithEmoticon("💼 Talk", "💻"), "💻 Talk", "a stale managed glyph is replaced")
  assert.equal(titleWithEmoticon(undefined, "💻"), undefined, "no title yet: leave the host to name it")
  assert.equal(titleWithEmoticon("💻", "💻"), undefined, "nothing left but the glyph")
  assert.equal(titleWithEmoticon("Talk", undefined), undefined)
})
