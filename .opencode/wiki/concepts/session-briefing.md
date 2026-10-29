---
title: Session briefing (always on)
tags: [concept, prompting, context-hook]
sourceRefs: [src/index.ts, src/config.ts, test/setup.test.ts, README.md]
lastReviewed: 2026-10-29
---

# Session briefing (always on)

The `context` hook is how a model learns crosstalk exists; the tools alone are
invisible unless the model goes looking. `announce: true` (default) registers
it. `announce: false` is the only way to remove the briefing.

## Two texts, one rule

- **Alone** (`peers === 0 && claims === 0`): a compact paragraph —
  "Crosstalk is installed… declare once with `crosstalk_status` (name, role,
  goal, summary)… no other session is on this channel right now."
- **Anything to coordinate** (a peer or an active lease): the full briefing —
  English-only, token-tight rules, sending/claiming etiquette, and live counts.

`briefing(peers, claims)` selects; `soloBriefing()` is the lone variant.

## Why the lone session still gets briefed

The first session in a project always starts alone. Under the old zero-peer
early return it never heard about the channel, so it never declared a name or
role. `crosstalk_claim` keys and identity are fine, but an undeclared session is
hard to address by name and invisible in the mesh's declared view. A session
that is mid-turn when the plugin loads also stays invisible until it emits an
event, so waiting for "there is a peer" delays the handshake further. Briefing
unconditionally makes every session self-seeding: it declares early, and peers
that arrive later can address it.

The cost is one short paragraph per context build while alone; the full briefing
already repeats per turn whenever peers exist.

## Invariants

- The hook never stays silent when `announce` is on.
- `peers` counts *other* sessions; `claims` counts live leases.
- Output is plain text pushed to `event.system` (type `text`).

Tests: `test/setup.test.ts` — "every session is briefed, compact while it is
alone" and "a lease without a peer still gets the full briefing".
