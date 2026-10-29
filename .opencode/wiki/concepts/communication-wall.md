---
title: Communication wall (`#inScope`)
tags: [concept, scope, security]
sourceRefs: [src/core/mesh.ts, README.md, AGENTS.md]
lastReviewed: 2026-10-29
---

# Communication wall (`#inScope`)

`Mesh.#inScope(selfID, peer)` is the single choke point that decides whether a
session may *communicate* with a peer. Listing is deliberately more permissive
than talking.

## Matrix

| Operation | Filter | Unknown location |
| --- | --- | --- |
| `peers` / `status` listing | `ListFilter` + `scope` | still listed, marked "not addressable" |
| `send` (id, name, role, `all`) | strict `#inScope` | refused |
| `claim`-independent mail injection / retries | strict `#inScope` | refused |
| `waitForPeerIdle` / `waitForClaimFree` | strict `#inScope` | refused with reason `outside` |

## Scope values

- `project` (default): peer `projectID` must equal the caller's project, and
  both must be known (`projectID !== undefined`).
- `location`: exact directory equality.
- `server`: no wall.

A peer whose project/directory is unknown is a refusal, not a maybe — that is
what stops a session in one project from mailing another. `ensureSelf` fills the
caller's own project/directory from `ctx.location`, and `enrichSession` heals
peers that missed `session.created`.

## See also

- [[entities/mesh]] — where the wall lives.
- [[concepts/global-installation]] — why one global install still yields
  per-location meshes.
