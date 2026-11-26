---
title: OMO-Slim extension landing
tags: [concept, extensions, tools, roles]
sourceRefs: [README.md, AGENTS.md, src/tools/index.ts, src/core/mesh.ts, src/core/format.ts, src/config.ts, .opencode/skills/roles.md, .opencode/skills/brief-format.md]
lastReviewed: 2026-11-24
---

# OMO-Slim extension landing

The OMO-Slim assessment in the voxelforge wiki separated two things: its
multi-model routing machinery (not useful with one local model) and its
coordination discipline (worth borrowing). This page records what actually
landed in crosstalk and the invariants that came with it. See
`../../voxelforge/.opencode/wiki/sources/oh-my-opencode-slim.md` for the original
assessment.

## Tools: seven → nine

`crosstalk_reply { messageId, text }` resolves the recipient from the caller's
own inbox (`Mailbox.find`, `Mesh.findMessage`), so a reply cannot be redirected
by name reuse; the communication wall is still enforced by `mesh.send`. The
thread topic is inherited and `replyTo` travels in `meta`.

`crosstalk_continue { sessionID, prompt }` is an explicit exact-ID continuation
with queued delivery — reuse a peer's context instead of spawning a lane.

`kind: "decline"` is a first-class message intent: `renderDelivery` asks for no
answer, and `formatInbox` says "reroute instead". The loop guard stays off by
default (`loopGuard: false`); when on it warns on the third and blocks the sixth
byte-identical `send`/`reply`, counting input *and* result. `inbox`, leases,
status and waits are exempt so retrieval cannot deadlock.

## Evidence-bearing briefs

`send` gained `writeScope`, `validation` and `evidence`. They ride in
`meta.task` and render as a `brief:` line in the recipient's inbox. This is the
code hook the role templates use: an assignment is a card, not a paragraph.

## Self-check and doctor

`formatStatus`'s self-check line now carries `scope`, permission `action`,
`direct`/`code mode`, and pending injections, in addition to the snapshot key
and refused-load counter. The `crosstalk-doctor` skill tells a session to read
that line before touching config or restarting a shared service — the remedy
for the stale belief that the tools were not exposed in a harness session.

## Click-to-focus

A named peer in this TUI's directory or below it can be focused by clicking its
sidebar avatar. `src/tui/focus.ts` holds the pure policy (name declared, path in
place) and `src/tui/index.tsx` calls `context.ui.tabs.focus`. Same normalisation
as claims, so a worktree separator is not a different location.

## Roles as prompt assets

Roles are **not** a plugin registry: `crosstalk_status.role` is still a string
and `send { role: "tester" }` still routes by exact lowercase match. The kit is
prose under `.opencode/skills/`: `roles.md` (roster, openers), `brief-format.md`
(the shared card), and one skill each for doctor, tester, reviewer, scout and
integrator. Coordinator and Builder are the existing two skills, extended to
point at the shared card. Integrator exists because `README.md`, `AGENTS.md`,
config and `src/tools/index.ts` are touched by every lane.

## Verification

`npm run check` at landing: typecheck + 295 tests green. The test surface has
four hard-coded copies of the tool list (`test/tools.test.ts` ids,
`test/setup.test.ts` ids and `added.length` in five places, plus the AGENTS.md
snippet) — these all move together when a tool is added.
