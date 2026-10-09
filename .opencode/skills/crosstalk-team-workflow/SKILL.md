---
name: crosstalk-team-workflow
description: Use when a coordinator assigns you work in a multi-session repository — claiming leases, landing a green gate, and reporting results honestly
license: MIT
compatibility: opencode
---

# Landing Assigned Work

You were given a slice of work alongside other sessions on the same
checkout. Three duties: don't collide, land green, report honestly.

## 1. Lease what you edit

Take `crosstalk_claim` on every file you are about to change, with a
short note. Leases are exact paths — no globs, and a directory lease
does not cover its children. If a refusal names another holder, that is
the system working: work elsewhere, or send them one sentence asking
when they'll be done. Never force a claim.

Release when you land. Renew if the work outlives the TTL.

## 2. Stay inside your lane

Your assignment names the files you own. Touching a file outside that
list is how two sessions rewrite each other's work in the same minute.
If you discover work that belongs to someone else's file, **report it to
the coordinator instead of fixing it** — one sentence, file and line.

## 3. Land green

The gate is `npm run check`: typecheck and tests both run, and both must
pass. Run it before you report done, not after.

- **Test-first when you write code.** Watch the test fail for the right
  reason before making it pass. A test that never failed proves nothing.
- **Assertions must be honest.** If a test fails, classify it before
  touching anything: is the *source* wrong or is the *expectation*
  wrong? An over-precise expectation (a specific hash, an unstated
  precondition) is a test bug, and fixing it is not "making the gate
  green by weakening it" — but say out loud which one you changed.
- **Docs-only changes** need no gate. Say so instead of running it.

## 4. Report like this

When you land, the coordinator needs to act on your message without
following up. Include:

- **Commit hash** — short form is fine.
- **Gate result** — the number, e.g. `249/249`.
- **What changed**, one clause per item.
- **What you did NOT do** — deferred items, out-of-scope observations,
  anything you noticed but left alone. This is the part people forget,
  and the part the coordinator most needs.
- **Leases** — "released" or "still holding X because Y".

Keep it to a few sentences. The coordinator verifies your hash against
`git log` anyway; give it the hash so that check is trivial.

## 5. Nothing else from you

If your assignment is complete and nothing blocks you, say so in one
line and go idle. Do not start unassigned work: the coordinator sequences
phases, and an eager session that begins phase-2 work early is a
collision waiting to happen. Send your ideas when asked, one sentence
each.
