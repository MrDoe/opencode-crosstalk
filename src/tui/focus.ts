/**
 * @fileoverview Pure click-to-focus policy for peer avatars.
 *
 * The TUI plugin asks the host to focus a tab only for a peer this sidebar is
 * allowed to touch: one that declared a name and sits in this TUI's directory
 * or below it, compared with the same normalisation claims use so a Windows
 * worktree does not look like a different place because of a separator.
 */

import type { DirectoryEntry } from "../core/directory.ts"
import { normalizeResource } from "../core/claims.ts"

export interface TabsLike {
  focus(sessionID: string): boolean
}

/** Whether a session sits in `home` or below it. */
export function inPlace(candidate: string | undefined, home: string | undefined): boolean {
  if (candidate === undefined || home === undefined) return false
  const base = normalizeResource(home)
  const other = normalizeResource(candidate)
  return other === base || other.startsWith(`${base}/`)
}

/** Focus a declared peer in this TUI's place; false means "not ours to focus". */
export function focusPeer(
  tabs: TabsLike,
  sessionID: string,
  home: string | undefined,
  entry: DirectoryEntry | undefined,
): boolean {
  if (entry === undefined || entry.name === undefined || !inPlace(entry.directory, home)) return false
  return tabs.focus(sessionID)
}
