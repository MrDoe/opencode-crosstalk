import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import {
  chooseAvatar,
  EMOTICONS,
  emoticonFor,
  entryForPortrait,
  hash,
  isSummaryStale,
  poolHint,
  stripEmoticon,
  summaryText,
  titleWithEmoticon,
  STALE_SUMMARY_MS,
  SUMMARY_MAX,
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

test("titleWithEmoticon strips a managed glyph and is idempotent", () => {
  assert.equal(titleWithEmoticon("💻 Talk to other sessions", "💻", undefined), "Talk to other sessions", "glyph stripped")
  assert.equal(titleWithEmoticon("Talk to other sessions", "💻", undefined), undefined, "already stripped: nothing to write")
  assert.equal(titleWithEmoticon("💼 Talk", "💻", undefined), "Talk", "a stale managed glyph is removed")
  assert.equal(titleWithEmoticon(undefined, "💻", undefined), undefined, "no title yet: leave the host to name it")
  assert.equal(titleWithEmoticon("💻", "💻", undefined), undefined, "nothing left but the glyph")
  assert.equal(titleWithEmoticon("Talk", undefined, undefined), undefined, "no glyph: nothing to do")
})

test("titleWithEmoticon includes the declared name", () => {
  assert.equal(titleWithEmoticon("Talk", "💻", "Ada"), "Ada: Talk")
  assert.equal(titleWithEmoticon("Ada: Talk", "💻", "Ada"), undefined, "already decorated: nothing to write")
  assert.equal(titleWithEmoticon("💻 Talk", "💻", "Ada"), "Ada: Talk", "glyph stripped, name added")
  assert.equal(titleWithEmoticon("Ada: 💻 Talk", "💻", "Ada"), "Ada: Talk", "name kept, glyph stripped")
  assert.equal(titleWithEmoticon("Bob: Talk", "💻", "Ada"), "Ada: Bob: Talk", "a foreign name prefix is kept")
  assert.equal(titleWithEmoticon("Talk", "💻", undefined), undefined, "no name, nothing to strip: nothing to write")
  assert.equal(titleWithEmoticon("Talk", "💻", ""), undefined, "empty name, nothing to strip: nothing to write")
  assert.equal(titleWithEmoticon("Ada:", "💻", "Ada"), undefined, "nothing left but the name prefix")
})

// ── status summary ────────────────────────────────────────────────────────────

test("summaryText prefers the summary and falls back to the goal", () => {
  assert.equal(summaryText({ summary: "Rewriting the session store" }), "Rewriting the session store")
  assert.equal(summaryText({ summary: "now", goal: "the overall goal" }), "now", "the summary wins")
  assert.equal(
    summaryText({ goal: "port auth" }),
    "port auth",
    "a session that never wrote a summary still says something",
  )
})

test("summaryText flattens whitespace and clips long text", () => {
  assert.equal(summaryText({ summary: "line one\nline  two" }), "line one line two")
  assert.equal(summaryText({ summary: "x".repeat(SUMMARY_MAX + 10) }), `${"x".repeat(SUMMARY_MAX - 1)}…`)
  assert.equal(SUMMARY_MAX, 200, "the display budget matches the tool's write limit")
})

test("summaryText reports nothing when there is nothing to show", () => {
  assert.equal(summaryText({}), undefined)
  assert.equal(summaryText(undefined), undefined)
  assert.equal(summaryText({ summary: "  \n " }), undefined, "whitespace is not a summary")
  assert.equal(summaryText({ goal: "" }), undefined)
})

// ── summary staleness ────────────────────────────────────────────────────────

test("isSummaryStale dims only summaries past the window", () => {
  const now = 1_000_000_000
  assert.equal(isSummaryStale(now - STALE_SUMMARY_MS - 1, now), true, "past the window dims")
  assert.equal(isSummaryStale(now - STALE_SUMMARY_MS + 1, now), false, "just inside it stays bright")
  assert.equal(isSummaryStale(now, now), false, "a current one stays bright")
})

test("isSummaryStale never dims a summary it cannot date", () => {
  assert.equal(isSummaryStale(undefined, Date.now()), false, "no timestamp: no evidence, no dim")
  assert.equal(isSummaryStale(Date.now() + 60_000, Date.now()), false, "a future one stays bright")
  assert.equal(STALE_SUMMARY_MS, 15 * 60_000, "a quarter hour, matching the coordinator's assignment")
})
