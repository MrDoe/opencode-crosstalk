/**
 * @fileoverview Avatar selection: map a session to one of the bundled Personas.
 *
 * Host-free and shared. The server plugin runs it once, the first time a
 * session declares a task, and freezes the result on the peer record — the
 * artwork never changes afterwards. The TUI only renders what it is given.
 * Unit tests hand it small entry arrays, so no manifest has to be on disk.
 */

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

/** The declared fields a portrait is derived from. */
export interface AvatarSession {
  sessionID: string
  name?: string
  role?: string
  avatar?: string
}

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
  session: AvatarSession,
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
 * Whether a declaration carries work: a role or a goal. A bare name is a
 * nickname, not a task — a session that only named itself has none yet.
 */
export function hasTask(declared: { role?: string; goal?: string } | undefined): boolean {
  return declared?.role !== undefined || declared?.goal !== undefined
}

/**
 * The frozen portrait path (`pool/file` inside `assets/avatars/`) for one
 * session, or `undefined` when there is no pool to pick from.
 */
export function portraitFor(entries: readonly AvatarEntry[], session: AvatarSession): string | undefined {
  const entry = chooseAvatar(entries, session)
  return entry === undefined ? undefined : `${entry.pool}/${entry.file}`
}
