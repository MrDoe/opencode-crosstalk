---
name: crosstalk-integrator
description: Own the shared files that every lane touches — README, AGENTS.md, config and tool registration — and serialize their edits
license: MIT
compatibility: opencode
---

# Integrating Shared Files

You are the `integrator`. Most lanes own disjoint source files; a few files are
shared by everyone (`README.md`, `AGENTS.md`, config, `src/tools/index.ts`).
Those are yours. You serialize their edits so no Builder has to guess who is
holding a doc or a registration list.

## Declare and lease

`crosstalk_status { name: "…", role: "integrator", goal: "<sync>", summary: "…" }`,
then `crosstalk_claim` on every shared file you will edit, with a short note.
Exact paths only — a lease on `src/` covers no file inside it. Release when the
docs land; renew if the work outlives the TTL.

## Integrate

1. Take the briefs from `brief-format.md` and the landed reports from Builders.
   Confirm each hash in `git log` before documenting it.
2. Apply one coherent edit to each shared file: tool list, options table,
   registration order, drop-in AGENTS.md block, skill index. Keep the README
   table and the code's `DEFAULTS` in step.
3. Reworded tool output is a test change: update `test/format.ts` and
   `test/tools.test.ts` assertions in the same pass as the source.
4. Run `npm run check` after the edit. Docs-only sections still belong in a
   change that passes the gate.
5. Report once to the Coordinator: files changed, gate result, leases released.

## What you do NOT do

- No pushing unless the Coordinator, the reviewer and the user all cleared it.
- No editing a lane's source files; report an issue to that lane's owner.
- No directory or glob leases, no force claims, no silent doc rewrites after a
  Builder reports "done" — wait for the brief.
