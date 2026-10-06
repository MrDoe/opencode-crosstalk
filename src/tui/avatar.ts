/**
 * @fileoverview Avatar selection: map a session to one of the bundled Personas,
 * and give each Persona the emoticon it is shown by.
 *
 * Pure and host-free so it is unit-testable: the TUI plugin supplies the
 * manifest entries and the directory entry, this file decides the file, the
 * emoticon, and the title the emoticon is written into.
 *
 * An emoticon belongs to the avatar, not the session: it is derived from the
 * manifest entry, so a session shows the glyph of the Persona it was handed and
 * two TUI processes agree without negotiating. The glyph set is curated —
 * tools, objects, and people only, never a smiley — because it has to read at a
 * glance in a tab header as well as beside the portrait.
 */

import type { DirectoryEntry } from "../core/directory.ts"

/** One entry of `assets/avatars/manifest.json`. */
export interface AvatarEntry {
  file: string
  pool: string
  role: string
  skin?: string
  mouth?: string
  hair?: string
  eyes?: string
  clothes?: string
  nose?: string
  hairColor?: string
  clothingColor?: string
}

export type AvatarPool = "female" | "male"

/**
 * Gender hint from the declared avatar emoji. Personas are hand-curated into
 * two pools, so the emoji only steers the pool; the tone is baked into the art.
 */
export function poolHint(avatar: string | undefined): AvatarPool | undefined {
  if (!avatar) return undefined
  if (avatar.includes("👩") || avatar.includes("👧") || avatar.includes("👵")) return "female"
  if (avatar.includes("👨") || avatar.includes("👦") || avatar.includes("👴") || avatar.includes("🧔")) return "male"
  return undefined
}

/** FNV-1a, so a session's avatar is stable across reloads and processes. */
export function hash(input: string): number {
  let value = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

/**
 * Pick the avatar for one session:
 *
 * 1. the declared emoji picks a pool when it names a gender;
 * 2. a role that matches a seed wins inside that pool;
 * 3. otherwise the name (or session id) hashes to a stable entry.
 */
export function chooseAvatar(
  entries: readonly AvatarEntry[],
  session: Pick<DirectoryEntry, "sessionID" | "name" | "role" | "avatar">,
): AvatarEntry | undefined {
  if (entries.length === 0) return undefined
  const pool = poolHint(session.avatar)
  const pooled = pool ? entries.filter((entry) => entry.pool === pool) : entries
  const role = session.role?.toLowerCase()
  const byRole = role ? pooled.filter((entry) => entry.role.toLowerCase() === role) : []
  const candidates = byRole.length > 0 ? byRole : pooled.length > 0 ? pooled : entries
  return candidates[hash(session.name ?? session.sessionID) % candidates.length]
}

/**
 * One emoticon per Persona role, curated from tools, objects, and people.
 *
 * Roles with several entries in the same pool carry alternates so two sessions
 * wearing the same trade do not collapse into one glyph; which alternate an
 * avatar gets is decided by its file name, so it never changes between renders.
 * A role missing from this table falls back to `FALLBACK_EMOTICONS`, which keeps
 * a regenerated manifest working before anyone curates the new roles.
 */
export const EMOTICONS: Record<string, readonly string[]> = {
  analyst: ["📊", "📉"],
  architect: ["🏛️", "📐"],
  auditor: ["🧮", "🧾"],
  builder: ["🧱", "🪚"],
  coder: ["💻", "⌨️", "🖥️"],
  compiler: ["🛠️", "🗜️"],
  coordinator: ["📡", "🧭"],
  debugger: ["🪛", "🔦"],
  deployer: ["🚀", "📤"],
  designer: ["🎨", "📐"],
  editor: ["📓", "✂️"],
  explorer: ["🧭", "🗺️"],
  fixer: ["🔧", "🩹"],
  formatter: ["📐", "📏"],
  gardener: ["🪴", "🧤"],
  guardian: ["🛡️", "🔒"],
  hacker: ["🕶️", "💻"],
  integrator: ["🔗", "🧲"],
  librarian: ["📚", "🗃️"],
  linter: ["🧹", "🚨"],
  maintainer: ["🛢️", "🔧"],
  manager: ["💼", "🗂️"],
  mentor: ["🎓", "📖"],
  migrator: ["🚚", "🧳"],
  operator: ["🎛️", "🕹️"],
  optimizer: ["⚙️", "🛢️"],
  parser: ["🧩", "🔤"],
  patcher: ["🩹", "🧵"],
  pioneer: ["🏔️", "⛺"],
  planner: ["📅", "🗒️"],
  profiler: ["📈", "⏱️"],
  refactorer: ["🔨", "🏗️"],
  researcher: ["🔬", "📜"],
  reviewer: ["🔍", "🧐"],
  scout: ["🔭", "📡"],
  sentinel: ["🚨", "📹"],
  shipper: ["📦", "🛳️"],
  shepherd: ["🧶", "🪢"],
  simplifier: ["✂️", "🧹"],
  strategist: ["🎯", "♟️"],
  steward: ["🗂️", "🧾"],
  tester: ["🧪", "🧫"],
  tinkerer: ["🔩", "🪛"],
  tracker: ["📍", "📌"],
  wrangler: ["🎣", "🪝"],
  writer: ["✒️", "📝"],
}

/** For manifest roles this table has not caught up with yet. */
export const FALLBACK_EMOTICONS: readonly string[] = ["🧰", "🧩", "📦", "🧭"]

const MANAGED_GLYPHS: readonly string[] = [
  ...new Set([...Object.values(EMOTICONS).flat(), ...FALLBACK_EMOTICONS]),
].sort((a, b) => b.length - a.length)

/** The emoticon one avatar was given. Always defined: an unknown role degrades. */
export function emoticonFor(entry: AvatarEntry | undefined): string {
  const candidates = entry ? (EMOTICONS[entry.role.toLowerCase()] ?? FALLBACK_EMOTICONS) : FALLBACK_EMOTICONS
  return candidates[hash(entry?.file ?? "crosstalk") % candidates.length] ?? FALLBACK_EMOTICONS[0]!
}

/**
 * Drop a leading emoticon this plugin manages.
 *
 * Only glyphs from the curated table count, so a glyph the user typed into a
 * title themselves is left alone.
 */
export function stripEmoticon(title: string): string {
  const lead = title.replace(/^\s+/, "")
  for (const glyph of MANAGED_GLYPHS) {
    if (lead.startsWith(glyph)) return lead.slice(glyph.length).replace(/^[\s\u00a0]+/, "")
  }
  return title
}

/**
 * The tab-header title for one session, or `undefined` when nothing should be
 * written — either there is no title to decorate or it is already correct, so a
 * caller can compare instead of guessing and the write stays idempotent.
 */
export function titleWithEmoticon(title: string | undefined, glyph: string | undefined): string | undefined {
  if (title === undefined || glyph === undefined) return undefined
  const base = stripEmoticon(title)
  if (base.length === 0) return undefined
  const wanted = `${glyph} ${base}`
  return wanted === title ? undefined : wanted
}
