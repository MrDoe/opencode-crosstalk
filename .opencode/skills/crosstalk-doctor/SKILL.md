---
name: crosstalk-doctor
description: Diagnose whether crosstalk tools are visible, scoped, and loaded once — from crosstalk_status instead of guessing
license: MIT
compatibility: opencode
---

# Diagnosing Crosstalk

The single cheapest instrument is `crosstalk_status` itself. Its output ends in
a self-check line naming the snapshot format, storage key, communication scope,
permission action, direct-vs-Code-Mode exposure and how many plugin locations
this process owns. Read it before touching config or restarting a service.

## What the self-check tells you

- `snapshot vN` — the format the store writes and restores. An older session may
  report the code that was loaded when it activated, not what is on disk now.
- `scope project|location|server` — the communication wall. Peers outside it are
  listed but "not addressable"; `crosstalk_send` refuses them. This is by design.
- `action crosstalk` — the permission action. A rule that *blocks* it removes
  the tools from the model's catalog entirely (no prompt, no fallback).
- `direct` vs `code mode` — direct tools are callable by name; Code Mode tools
  are reachable only inside `execute`, which has its own permission gate.
- `N locations owned`, `N refused loads` — the instance guard. A non-zero
  refused count means a duplicate install was turned away; check both
  `~/.opencode/plugins/` and `<config>/plugins/` and link only one.
- `N pending injection` — mail whose delivery failed and will retry on the
  recipient's next crosstalk tool call; the mailbox remains authoritative.

## Tool not in your catalog?

Do not restart the shared `opencode serve` or flip global config just to get a
tool back — that disrupts other sessions. In order:

1. Call `crosstalk_status` and read the self-check. If it works, the tools are
   present; a previous memory of them being absent is stale.
2. If it fails, the plugin was not loaded in this location. `npm run setup`
   links this checkout into the global plugin directory, but a long-lived
   service that predates a newly created `plugins/` directory will not rescan
   it. Ask before `opencode service restart`.
3. Check for a blocking permission rule; an `ask` rule prompts instead.
4. Check `opencode plugin list` and `opencode api get /api/plugin` — a plugin
   that failed to load is simply absent from the list.

State the finding in one sentence to the user; do not "fix" by broadcasting or
forcing a claim.
