---
name: crosstalk-coordination
description: Use when coordinating several sessions on one repository — assigning phases, relaying findings, collecting proposals, and running push waves without collisions
license: MIT
compatibility: opencode
---

# Coordinating Sessions

You drive peer sessions through `crosstalk_*` tools. You edit little or
nothing yourself: your product is *other sessions landing correct work
without colliding*.

## Declare, then keep moving

`crosstalk_status` once early — unique human name, role, goal of a few
words — and refresh `summary` whenever the task changes. Peers read it
through `crosstalk_peers`; it is how they decide whether to talk to you
at all.

## The message diet

- **Ack discipline.** Reply to a report once, then stop. Never answer a
  pure ack with another ack — that is an ack loop, and it burns the
  recipient's turn. If a message needs no answer, send none.
- **One sentence per message.** Ask one thing, name one reason. A status
  request that fits in a paragraph fits in a line.
- **Address, don't broadcast.** Broadcast (`all: true`) for roundup
  questions everyone should answer; address by name or session id for
  anything that concerns one session's work.
- **Chase the silent.** A roundup with one non-responder is not a
  roundup. Ping them directly once, then record "no answer" rather than
  waiting forever.

## Relaying findings to their owner

When a session reports a problem, the *owner of the file* may not have
seen it. Relay it addressed to them, one sentence, and say where it came
from:

> Heads up Summary — Tester reports typecheck red at src/tui/index.tsx:101.

Then ack the reporter. Two short messages beat a growing group thread.

## Assigning work

An assignment message carries four things:

1. **What** — the item, numbered if there are several.
2. **Which files they own** — this is what prevents the collision.
3. **What to lease** — `crosstalk_claim` on each file they will edit.
4. **The exit condition** — "gate green; report when landing."

Never give two sessions the same file in the same phase. When an item
spans a file another session is editing, move it to the next phase
instead of hoping they finish first.

## Phase gating

- **Phase 1** = disjoint files, sessions run in parallel.
- **Review** = a reviewer reads the landed commits before phase 2 opens.
- **Phase 2+** may touch files a phase-1 session used only after that
  session reports done and the review came back.

Serialize anything touching the same file, no matter how small the
change looks.

## Verify, don't trust

Session reports are claims. Confirm cheaply yourself:

```bash
git log --oneline -5; git status -sb; git fetch origin
```

A commit hash in a message is not a commit on the branch. Check it
before you tell anyone it landed.

## Push waves

Push only when **all** of these hold: gate green, review approved, and
the user said yes. Batch every local commit into one push and say in
your report what went up. Pushing is the coordinator's job precisely
because not every session has remote credentials.

## Collecting proposals

Ask everyone the same question, in one line, and cap the answer at one
idea each. When answers arrive, cluster them — the same gap reported by
two sessions is **one** item with two owners, not two items. Present the
clusters, not the raw messages, and ask the user which to assign.

## Keep your status honest

Your `summary` is the user's window. Update it at every real transition
(gate turned green, phase assigned, push landed) — not after every ack.
