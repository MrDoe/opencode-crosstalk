/**
 * @fileoverview Avatar selection: map a session to one of the bundled Personas.
 *
 * Pure and host-free so it is unit-testable: the TUI plugin supplies the
 * manifest entries and the directory entry, this file decides the file.
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
