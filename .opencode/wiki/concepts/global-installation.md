---
title: Global installation and discovery
tags: [concept, install, discovery]
sourceRefs: [scripts/setup.mjs, README.md, AGENTS.md, src/index.ts]
lastReviewed: 2026-10-29
---

# Global installation and discovery

`npm run setup` symlinks this checkout to `~/.opencode/plugins/crosstalk`
(override with `CROSSTALK_PLUGINS_DIR`). The host auto-discovers that directory
for every project and workspace: no `opencode.jsonc` entry, no npm publish, no
build step. `npm run uninstall` removes only that link.

## Rules the host enforces

- A plugin directory needs a root `index.ts`/`index.js`; without one it is
  dropped **silently**. The root `index.ts` re-exports `src/index.ts` for this.
- Install into exactly **one** global root. Both `~/.opencode/plugins/` and
  `<config>/plugins/` are discovered; linking both loads the plugin twice per
  location. The `globalThis` guard in `setup` makes the second load inert
  (warn + refuse), and the `crosstalk_status` self-check surfaces the count.
- Plugin loading is **per location**, on session activation — not at server
  start. A long-lived service that predates a new `plugins/` directory does not
  rescan; `opencode service restart` fixes that (it drops the current session).
- A config path entry must be a *directory*; a bare name is treated as an npm
  spec and fails with a 404 if unpublished.

## Verifying a load

- `crosstalk_status` ends with
  `self-check: snapshot v2 · storage crosstalk/… · N locations owned`.
  A `2 refused loads` tail means a duplicate install.
- `opencode api get /api/plugin` reports local plugins as
  `{"source":{"type":"local","path":"…/index.ts"},"state":{"status":"active"}}`.
- `opencode plugin list` shows loaded package plugins, including local ones;
  a failed load is simply absent.
- Logs at INFO: `msg="loading plugin" id=… entrypoint=file://…`.

## Relation to per-session use

Discovery makes the tools and the [[concepts/session-briefing]] available to
every session in every location. It does not force an already-running session
to pick up new code; reload or restart for that.
