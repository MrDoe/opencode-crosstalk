/**
 * @fileoverview How a frozen portrait is shown: the emoticon that belongs to
 * the Persona it was given, the title that emoticon is written into, and the
 * status summary shown under the avatar.
 *
 * The selection itself lives in `src/core/avatar.ts`: the server freezes one
 * portrait per session when a task is first declared, so this side only maps a
 * portrait path back to its manifest entry and decorates it. Pure and
 * host-free so it is unit-testable.
 */

import { hash, type AvatarEntry } from "../core/avatar.ts"
import { ellipsis } from "../core/format.ts"

export {
  chooseAvatar,
  hasTask,
  hash,
  poolHint,
  portraitFor,
  type AvatarEntry,
  type AvatarPool,
  type AvatarSession,
} from "../core/avatar.ts"

/** The manifest entry a frozen portrait (`pool/file`) refers to. */
export function entryForPortrait(
  entries: readonly AvatarEntry[],
  portrait: string | undefined,
): AvatarEntry | undefined {
  if (portrait === undefined) return undefined
  return entries.find((entry) => `${entry.pool}/${entry.file}` === portrait)
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
 * Drop a leading `Name: ` prefix this plugin manages.
 *
 * Only a prefix matching the declared name counts, so a name the user typed
 * into a title themselves is left alone.
 */
function stripNamePrefix(title: string, name: string): string {
  const lead = title.replace(/^\s+/, "")
  const prefix = `${name}:`
  if (lead.startsWith(prefix)) return lead.slice(prefix.length).replace(/^[\s\u00a0]+/, "")
  return title
}

/**
 * The tab-header title for one session, or `undefined` when nothing should be
 * written — either there is no title to decorate or it is already correct, so a
 * caller can compare instead of guessing and the write stays idempotent.
 *
 * With a declared name the title becomes `Name: base`; without one it stays
 * `base`, so sessions that never declared a name are unchanged.
 */
export function titleWithEmoticon(
  title: string | undefined,
  glyph: string | undefined,
  name: string | undefined,
): string | undefined {
  if (title === undefined || glyph === undefined) return undefined
  let base = title
  if (name !== undefined && name.length > 0) base = stripNamePrefix(base, name)
  base = stripEmoticon(base)
  if (base.length === 0) return undefined
  const wanted = name !== undefined && name.length > 0 ? `${name}: ${base}` : base
  return wanted === title ? undefined : wanted
}

/** Widest status summary the sidebar shows; matches the tool's write limit. */
export const SUMMARY_MAX = 200

/**
 * The status summary under one avatar: what the session says it is doing right
 * now, flattened onto a single line so the renderer wraps it itself. The
 * declared summary wins; a session that never wrote one falls back to its goal,
 * so a declaration made before the summary existed still says something.
 * Undefined when neither is there — the avatar block then shows only the name
 * and the role, and the caller renders nothing.
 */
export function summaryText(entry: { summary?: string; goal?: string } | undefined): string | undefined {
  const raw = entry?.summary ?? entry?.goal
  if (raw === undefined) return undefined
  const flat = ellipsis(raw, SUMMARY_MAX)
  return flat.length === 0 ? undefined : flat
}
