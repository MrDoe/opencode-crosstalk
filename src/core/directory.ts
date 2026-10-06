/**
 * @fileoverview The session directory the TUI plugin reads over RPC.
 *
 * Host-free: built straight from the mesh registry so it is unit-testable and
 * stays in step with what `crosstalk_peers` sees.
 */

import type { Mesh } from "./mesh.ts"

/** One session as the TUI needs it: identity, declared hints, location. */
export type DirectoryEntry = {
  sessionID: string
  status: "running" | "idle" | "unknown"
  title?: string
  name?: string
  role?: string
  goal?: string
  avatar?: string
  directory?: string
  projectID?: string
  /** Frozen portrait (`pool/file` inside `assets/avatars/`); absent before the first task. */
  portrait?: string
}

export type DirectoryPayload = { sessions: DirectoryEntry[] }

/** Every session the mesh has seen, with the fields a TUI needs. */
export function directoryPayload(mesh: Mesh): DirectoryPayload {
  const sessions = mesh.registry.list().map((peer) => {
    const entry: DirectoryEntry = { sessionID: peer.sessionID, status: peer.status }
    if (peer.title !== undefined) entry.title = peer.title
    if (peer.declared?.name !== undefined) entry.name = peer.declared.name
    if (peer.declared?.role !== undefined) entry.role = peer.declared.role
    if (peer.declared?.goal !== undefined) entry.goal = peer.declared.goal
    if (peer.declared?.avatar !== undefined) entry.avatar = peer.declared.avatar
    if (peer.directory !== undefined) entry.directory = peer.directory
    if (peer.projectID !== undefined) entry.projectID = peer.projectID
    if (peer.portrait !== undefined) entry.portrait = peer.portrait
    return entry
  })
  return { sessions }
}
