# AGENTS.md

OpenCode plugin that lets sessions on one server discover each other, message each
other, and take exclusive leases on files. Ships as TypeScript source — the host
resolves the package directory through the root `index.ts` (a thin re-export of
`src/index.ts`), so there is no build step and no `dist/`.

## Commands

```sh
npm run check       # typecheck + test — this is the whole gate
npm run typecheck   # tsc --noEmit
npm test            # node --test test/*.test.ts — offline, no server, no network
npm run setup       # symlink the checkout into ~/.opencode/plugins/
npm run uninstall   # remove that link
```

Focused runs (the glob in `npm test` is shell-expanded, so pass files directly):

```sh
node --test test/mesh.test.ts
node --test --test-name-pattern="relative paths" test/claims.test.ts
npm run test:e2e    # spawns a real opencode + real model calls; see below
```

- Node **>= 22.18** is required (`engines`): the test script and the host both
  execute `.ts` via type stripping. Don't add a transpile step.
- There is **no lint or formatter config** (no eslint/biome/prettier, no
  pre-commit, no CI). `npm run check` is the only automated gate — match the
  surrounding style by hand.
- The repo is not currently under version control. Don't assume branch, commit,
  or PR conventions exist.

## Layout

| Path | Role |
| --- | --- |
| `index.ts` | Host directory entrypoint — re-exports `src/index.ts`. Required: the host resolves plugin directories by a root `index.ts`/`index.js` and ignores `package.json` `main`/`exports`; a directory without one is dropped silently. |
| `src/index.ts` | **Only** runtime importer of `@opencode/plugin` (`Plugin.define`). Wires mesh + event pump + tools + briefing hook, and returns the cleanup that undoes all of it. |
| `src/core/` | Host-free coordination logic. `mesh.ts` is the façade over `Registry` (presence), `Mailbox`, `ClaimTable`; also the package's `./core` export. |
| `src/tools/` | The six `crosstalk_*` tool definitions. `args.ts` is the input validator, `types.ts` the shared plumbing. |
| `src/config.ts` | `parseOptions` + `DEFAULTS`. |
| `src/events.ts`, `src/deliverer.ts`, `src/storage.ts` | Adapters over `ctx.event`, `ctx.session.synthetic`, `ctx.storage`, each behind a narrow structural interface. |
| `test/helpers/fakes.ts` | The entire test harness. |
| `scripts/setup.mjs` | Global installer (links into `~/.opencode/plugins/`). Plain JS, deliberately outside `tsconfig.json`'s `include`, so it is not typechecked. |

`src/core/**` must keep importing nothing from `@opencode/plugin`. Only
`src/index.ts` (runtime), `src/tools/types.ts`, and `src/tools/index.ts` (both
`import type`) touch the package. Keep the host behind `EventStream`,
`StorageLike`, `SessionLike`, and `Deliverer` — that is what makes core directly
testable.

## Tool calling

Six tools come from `toolFactories` in `src/tools/index.ts`. Each definition's
`name` is **bare** (`status`, `peers`, `send`, `inbox`, `claim`, `wait`); the
host composes the effective id as `<namespace>_<name>`, and that composed id is
what a model calls and what `editor.update` / `editor.remove` take.
`parseOptions` rejects dots in `namespace` outright, so the host's dot→`_` rewrite
never fires.

- **The JSON Schema is advisory; the executor is authoritative.** The schema
  tells the model what it may send; `readString` / `readNumber` / `readBoolean` /
  `readEnum` / `readStringArray` in `src/tools/args.ts` do the real narrowing and
  carry the real limits (`max`, `min`, `maxLength`). Keep the two in step — a
  schema that permits more than the validator accepts is a bug, and it stays
  invisible until a model trips it.
- **The tool surface is seconds, the mesh is milliseconds.** `ttlSeconds`,
  `timeoutSeconds`, and `inbox.wait` are converted in the tool, never in core.
  Every blocking call also goes through `clampWait`, so a requested timeout is
  capped by `options.maxWaitMs` and may return sooner than asked.
- **Identity comes from `context.sessionID`, never from input.** No tool takes a
  "who am I" argument. Keep it that way — it is what stops one session releasing
  another's leases or reading another's mail.
- **Bad input is returned, not thrown.** `run()` turns an `ArgError` into
  `crosstalk: …` content the model can correct itself from, and cross-field rules
  (`for: "peer_idle"` needs `sessionID`) are an early `return` of a message.
  Anything else propagating out of an executor is a genuine bug.
- **Blocking tools have a required shape:** `run(async …)`, then
  `startHeartbeat(context, …)` → `try { … } finally { stop() }`, with
  `context.signal` passed through to the mesh. Dropping the `finally` leaks a
  timer into the host.
- **`registerTools` wraps every executor** with
  `mesh.flushPendingInjection(context.sessionID, context.signal)` so mail whose
  injection failed is retried before anything else runs. Don't call it yourself
  and don't drop the wrapper.
- Everything a tool returns is plain text rendered by `src/core/format.ts`, and
  tests assert on that text — re-wording the output is a test change.

## Non-obvious constraints

- **Discovery is event-driven only.** The V2 plugin context exposes no
  `session.list()` / `session.active()`, so the presence registry is a reducer
  over `ctx.event.subscribe()` (`Registry.applyEvent`). Don't look for a place
  to add a listing call — it doesn't exist. Consequence: a session already
  mid-turn when the plugin loaded stays invisible until it emits something.
- **Options must never throw.** `parseOptions` validates, clamps, and degrades
  every bad value to a documented default plus a warning. A typo should not
  cost an agent its tools mid-session. Add new options to `DEFAULTS` and
  `CrosstalkOptions` together — unknown keys are warned about, not rejected.
- **`ctx.tool.transform`'s callback must stay synchronous and cheap.**
- **`setup` must return a cleanup function** that undoes everything: abort the
  controller, await the event pump, dispose the hook and the tool registration,
  and write a final snapshot. Tests assert on the disposal counts and that
  post-cleanup events are ignored.
- **Registration order in `toolFactories` is asserted verbatim**
  (`status, peers, send, inbox, claim, wait`) by `test/setup.test.ts`, so
  reordering or renaming a tool breaks a test on purpose.
- **Branded host ids are narrowed at the boundary.** The host brands
  `Session.ID` and friends; the mesh works in plain strings. The `as never`
  casts in `src/index.ts` and the test helpers are deliberate — don't spread
  them inward.
- **Mailboxes are intentionally not persisted.** Peers and leases survive a
  reload via `ctx.storage`; messages do not. Don't "fix" this.
- **Claim keys are exact normalized strings — no glob expansion.** The
  `crosstalk_claim` JSON Schema advertises `src/auth/**` as an example, but
  `normalizeResource` treats `**` as an ordinary path segment, so that string
  becomes a literal key and does not cover the subtree. `normalizeResource` also
  case-folds only Windows-looking paths, and resolves relative paths against the
  holder's directory so two worktrees don't shadow each other.

## TypeScript settings that will bite you

`tsconfig.json` targets type-stripped execution, so mistakes surface at runtime:

- Import specifiers must carry the literal `.ts` extension (`"./config.ts"`, not
  `"./config.js"`) — `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`.
- `erasableSyntaxOnly`: **no** enums, parameter properties, or namespaces.
- `verbatimModuleSyntax`: type-only imports must use `import type`.
- `noUncheckedIndexedAccess`: indexing yields `T | undefined`, hence the
  `?.` and explicit `!== undefined` checks throughout.
- `strict` plus `noImplicitOverride` and `noFallthroughCasesInSwitch`.

## Testing

- `node:test` + `node:assert/strict`. `test/helpers/fakes.ts` provides the manual
  clock, fake storage, push-driven event stream (`push()` then `await settle()`),
  recording deliverer, and fake tool editor. No test needs a running server.
- **Time is injected.** `createTestMesh()` uses a manual clock and `pollMs: 1`.
  Timeout paths need `realClock: true` — the barrier waits measure elapsed time
  with the injected clock while sleeping on real timers, so a manual clock never
  advances on its own and the timeout is unreachable without it.
- `toolOptions()` forces `heartbeatMs: 0`; keep it that way so no interval timer
  outlives the test.
- Always `await fake.cleanup()` after driving a fake plugin, or the event pump
  keeps running into later assertions.
- Assertions target user-visible tool text, so reworded output in
  `src/core/format.ts` breaks tests — update them together.
- The e2e test is excluded from `npm test`. `OPENCODE_E2E=1 npm run test:e2e`
  spawns real `opencode run` sessions against a temp project and **costs model
  calls**; it needs `opencode` on PATH, pins a model with `OPENCODE_E2E_MODEL`,
  and reports provider credit/credential problems as *skips* rather than
  failures. Never run it unprompted.

## Verifying a change against a real host

- `npm run setup` links this checkout into `~/.opencode/plugins/crosstalk`, which the
  host auto-discovers for every project and workspace. `npm run uninstall`
  reverses it. It deliberately does **not** edit the user's `opencode.jsonc` —
  discovery makes the config entry unnecessary, and that file is JSONC with
  comments the script would have to mangle. A stale or foreign entry at the link
  path is refused, not overwritten, and a missing root `index.ts`/`index.js`
  entrypoint fails the install instead of silently linking a directory the host
  would ignore.
- **Both `~/.opencode/plugins/` and `<config>/plugins/` are discovered** (verified
  on this machine, despite only the latter being documented). Install to exactly
  one — linking both loads the plugin twice per location. `CROSSTALK_PLUGINS_DIR`
  overrides the target.
- **A plugin directory needs a root entrypoint.** The host resolves it through
  `index.ts`/`index.js`; it does not read `package.json` `main`/`exports`, and a
  directory without one is dropped **silently**. That is what the root `index.ts`
  is for — keep it.
- **`plugins` config entries:** a bare name is an npm spec (an unpublished name
  fails with `NpmInstallFailedError … 404`, surfaced as "Plugin failed to load"
  with an `err_…` ref — `err_21864baa` was exactly this); a path entry must be a
  **directory** (a file is rejected with `WARN configured plugin path must be a
  directory`) and that directory still needs the root entry.
- Plugin loading is **per location**: the plugin loads when a session in that
  location activates, not at server start.
- Per project, point `opencode.jsonc` at the checkout with
  `"plugins": ["../opencode-crosstalk"]`, or symlink/copy the package into
  `<project>/.opencode/plugins/`.
- **A permission rule is not required to use the tools.** OpenCode's base policy
  opens with `{ "action": "*", "resource": "*", "effect": "allow" }`, so the
  `crosstalk` action already resolves to allow. The rule from the README exists to
  *control* the action: one `{ "action": "crosstalk", "resource": "*", ... }` rule
  covers all six tools (or six, if the `permission` option is changed so the action
  falls back to each effective tool name). A rule that *blocks* the action keeps the
  tools out of the catalog entirely, so the model never sees them; `ask` prompts.
- Plugin id is `opencode.crosstalk`; disable with `plugins: ["-opencode.crosstalk"]`.

### Confirming it actually loaded

- `opencode plugin list` shows loaded package plugins and, on 2.0.16, local ones
  too (`VERSION local`, `SOURCE` = the entry file) — but a plugin that failed to
  load is simply absent, so still confirm state against the registry.
- The server's own registry is the better instrument: `opencode api get /api/plugin`.
  Omitting `location` resolves to the **home** location, and that query param
  rejects both string and object encodings through `opencode api`
  (400 `Expected object | undefined`), so scoping it to one repo is awkward.
- **Plugin loading is logged at INFO** on 2.0.16:
  `msg="loading plugin" id=<resolved dir or package> entrypoint=file:///…`. The
  registry reports local plugins as
  `{"source":{"type":"local","path":"…/index.ts"},"state":{"status":"active"}}`.
  Grep the service log for `loading plugin` / `failed to load plugin`.
- **A long-lived service can predate a newly created global `plugins/` directory**
  and never rescan it. `opencode service restart` is the fix and it drops the
  current session — ask before running it.
- To separate "directory not discovered" from "this plugin's `setup` throws", drop a
  throwaway plugin in the same directory that appends to a marker file in `setup`.
  Direct `.js`/`.ts` files load, and package directories load only with a root
  `index.ts`/`index.js` — a directory without one is dropped without a warning.
  Marker hits can come from transient `opencode` CLI invocations rather than the
  long-lived service, so confirm against the registry.
- `scripts/setup.mjs` links the checkout but cannot make an already-running service
  notice it. Linking ≠ loaded.

- Option reference and design rationale live in `README.md` — keep that table in
  sync when adding an option.

<!-- opencode-crosstalk:begin -->
## OpenCode Crosstalk

This machine runs the `opencode-crosstalk` plugin (`opencode.crosstalk`): concurrent
OpenCode sessions in a workspace can see each other, message each other, and take
exclusive leases on files. It is installed **globally** — every project and workspace
gets it without a config edit.

**Install / verify.** `cd /home/christoph/code/opencode-crosstalk && npm run setup`
links the checkout into `~/.opencode/plugins/` (`npm run uninstall` reverses it). The
host resolves a plugin directory through a root `index.ts`/`index.js`, so keep
`/home/christoph/code/opencode-crosstalk/index.ts` in place. Verify with
`opencode api get /api/plugin` — expect `opencode.crosstalk` in state `active` with a
`local` source ending in `index.ts`; `opencode plugin list` shows it with
`VERSION local`. A `failed` state caused by `NpmInstallFailedError … 404` means a
`plugins` entry names an unpublished npm package — point it at the checkout directory
instead. Reload is automatic for watched config dirs; `opencode service restart` forces
it and drops the current session. Don't install it both globally and per project: it
would load twice. Disable in a workspace with `"plugins": ["-opencode.crosstalk"]`.

**Use.** Six tools: `crosstalk_status`, `crosstalk_peers`, `crosstalk_send`,
`crosstalk_inbox`, `crosstalk_claim`, `crosstalk_wait`.

- **Declare first.** `crosstalk_status` with `role`/`goal`/`workingOn` at the start of a
  task; `crosstalk_peers` lists who is active and what they have leased.
- **Lease before you edit.** `crosstalk_claim` (`action: "claim"`, `resources`, `note`,
  `ttlSeconds`) takes an exclusive expiring lease on files or named resources.
  `action: "renew"` if the work runs long, `action: "release"` when done. Resources are
  exact normalized paths — `**` is a literal segment, not a glob. If refused, message
  the holder or wait for `claim_free`.
- **Talk instead of retrying.** `crosstalk_send` a `topic` and a concrete ask
  (`kind: "request"`); read replies with `crosstalk_inbox` (`wait` blocks), or
  `crosstalk_wait` for `peer_idle` instead of polling.
- Identity comes from the session automatically — never pass a "who am I" argument.
  Blocking calls are capped by `maxWaitMs` and may return early; that is normal.

No permission rule is required (the base policy allows the `crosstalk` action). To gate
it use `{ "action": "crosstalk", "resource": "*", "effect": "ask" }`.
<!-- opencode-crosstalk:end -->
