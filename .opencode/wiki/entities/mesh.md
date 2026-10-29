---
title: Mesh (`src/core/mesh.ts`)
tags: [entity, core, coordination]
sourceRefs: [src/core/mesh.ts, src/core/registry.ts, src/core/mailbox.ts, src/core/claims.ts]
lastReviewed: 2026-10-29
---

# Mesh (`src/core/mesh.ts`)

Host-free façade over three collaborators: `Registry` (presence and
declarations), `Mailbox` (messages per session), and `ClaimTable` (exact-path
leases). Everything is injected — clock, deliverer, avatars — so the core is
directly testable without a server.

## Surfaces

- `applyEvent` folds a server event into the registry and evicts lapsed peers.
- `ensureSelf` guarantees a record for a session that never emitted
  `session.created`; `peers` / `view` decorate records with unread counts,
  leases, and `addressable`.
- `declare` merges name/role/goal/summary; names are unique
  case-insensitively among visible peers and portraits freeze on the first
  task-bearing declaration.
- `send` resolves a session id, a declared name, a role, or `all`; delivery
  failures stay queued and are retried by `flushPendingInjection`.
- `claim` is all-or-nothing for a batch, expires, and normalizes exact paths —
  no glob expansion, relative paths resolve against the holder's directory.
- `waitForPeerIdle` / `waitForClaimFree` poll the injected clock and honor an
  abort signal up to `maxWaitMs`.
- `snapshot` / `restore` persist peers and claims, never mail.

## See also

- [[concepts/communication-wall]] — `#inScope`, the single choke point.
- [[entities/plugin-entrypoint]] — who constructs and drives the mesh.
