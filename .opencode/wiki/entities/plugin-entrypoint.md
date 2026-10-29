---
title: Plugin entrypoint (`src/index.ts`)
tags: [entity, plugin, setup]
sourceRefs: [src/index.ts, src/config.ts, scripts/setup.mjs]
lastReviewed: 2026-10-29
---

# Plugin entrypoint (`src/index.ts`)

`Plugin.define({ id: "opencode.crosstalk", setup })` is the only server-side
runtime import of `@opencode/plugin`. The root `index.ts` re-exports it because
the host resolves plugin directories by a root entrypoint and ignores
`package.json` `main`/`exports` — a directory without one is dropped silently.

## What `setup(ctx)` wires

1. **Mesh** — presence, mailboxes, claims; seeded from `ctx.storage` unless
   `persist: false`. One live instance per location, enforced by a
   `globalThis` guard that counts refused duplicate loads (surfaced in the
   `crosstalk_status` self-check).
2. **Event pump** — `ctx.event.subscribe()` is the only discovery channel; there
   is no `session.list()`. `enrichSession` heals records that missed
   `session.created` by reading `ctx.session.get`.
3. **Tools** — `ctx.tool.transform` registers the seven `crosstalk_*` tools
   through `registerTools`, each wrapped with pending-injection flushes.
4. **Briefing hook** — `ctx.session.hook("context")` pushes the model-facing
   briefing into `event.system`; see [[concepts/session-briefing]].
5. **RPC** — the `crosstalk` domain (`directory` method + debounced `changed`
   event) that the TUI plugin consumes; see [[concepts/global-installation]].

`setup` returns a cleanup that aborts the controller, awaits the pump, disposes
the hook/RPC/tools, clears timers, releases the location guard, and writes a
final snapshot. Tests assert the disposal counts.

## Boundaries

- `src/core/**` imports nothing from `@opencode/plugin`; host types are narrowed
  at this file (`toSessionLike`, `as never` casts for branded ids).
- `parseOptions` never throws: bad values degrade to `DEFAULTS` with warnings.
- Option identity is `ctx.location`, not input; `sessionID` always comes from
  the tool context.
