# opencode-crosstalk

Let the OpenCode sessions on one server **see each other, talk to each other, and
lease the files they are editing**.

Two agents in the same repository have no way to discover each other, no way to
say "I'm in `src/auth/` right now", and no way to stop both of them rewriting the
same file. This plugin adds six tools that make all three ordinary.

```
crosstalk_status   declare your role and see who else is here
crosstalk_peers    who is running, what they declared, what they hold
crosstalk_send     message a peer, a role, or everyone
crosstalk_inbox    read replies, optionally blocking until one arrives
crosstalk_claim    take an exclusive, expiring lease on a file
crosstalk_wait     block until a peer is idle or a file is released
```

All six share one namespace and one permission action (`crosstalk`), so a project
can allow or deny coordination with a single rule.

## Install

```sh
git clone https://github.com/MrDoe/opencode-crosstalk
cd opencode-crosstalk && npm install
```

### Every project on your machine

```sh
npm run setup      # symlink this checkout into ~/.opencode/plugins/crosstalk
npm run uninstall  # remove the link again
```

The global `plugins/` directory is discovered automatically, so this needs no
config edit, and it activates the plugin for every project and workspace. It
links rather than copies, so your edits to `src/` are live after a reload. The
host resolves the linked directory through its root `index.ts`, so keep that
file in place. Verify with `opencode api get /api/plugin` (expect
`opencode.crosstalk` active); `opencode plugin list` shows it as `local`.

Install into exactly one global root — linking both loads the plugin twice per
location. `npm run setup` uses `~/.opencode/plugins/`; the root the V2 docs
name, `<config>/plugins/` (`~/.config/opencode/plugins/`), is honored as well.
Set `CROSSTALK_PLUGINS_DIR` to target another directory.

### One specific project

Point a project at it:

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["../opencode-crosstalk"]
}
```

Or drop the package into `.opencode/plugins/` and it is discovered with no
configuration at all:

```text
your-project/.opencode/plugins/crosstalk/   →  symlink or copy this package here
```

### Permissions

No permission rule is needed to *use* the tools: OpenCode's base policy allows
every action, so `crosstalk` already resolves to allow. Add a rule when you want
to control it rather than enable it — one rule covers all six tools:

```jsonc title="opencode.jsonc"
{
  "permissions": [{ "action": "crosstalk", "resource": "*", "effect": "deny" }]
}
```

No build step: the host resolves the plugin directory through the root `index.ts`,
a thin re-export of `src/index.ts`.

## Using it

An agent that knows other sessions exist uses this on its own — the plugin adds a
short briefing to the system prompt when there is at least one peer or one
active lease. A typical exchange:

```text
crosstalk_status { name: "Riley", role: "migrator", goal: "port auth off sessions",
                  summary: "moving the token handlers now" }
crosstalk_peers {}
→ crosstalk peers (scope project, 1 found, 1 running):
    - ses_9f2  (Alex)  running  role=reviewer  summary="checking the token flow"  "check my auth changes"  claims /repo/src/auth/session.ts

crosstalk_claim { action: "claim", resources: ["src/auth/session.ts"] }
→ crosstalk claim: refused — 1 resource already leased
    - src/auth/session.ts held by ses_9f2 (reviewing), free in 4m
  wait for them with crosstalk_wait, signal them with crosstalk_send, or pass force: true to steal.
  nothing was claimed (atomic request).

crosstalk_send { to: "Alex", kind: "request",
                 text: "I need to rewrite session.ts. Are you done?" }

crosstalk_wait { for: "peer_idle", sessionID: "ses_9f2", timeoutSeconds: 120 }
→ crosstalk wait: peer idle after 1.2s — ses_9f2
```

A message is stored in the recipient's mailbox and, when the session is live,
injected into its current turn — so the other agent finds out without anyone
having to poll.

### Talking to sessions by name

Names are there for the user, too. Once the sessions declare themselves, you can
route work in plain language — *"Talk to Ada about this first."* — and the agent
you are talking to will address that session by name with
`crosstalk_send { to: "Ada", … }`. A name is unique among the peers a session
can see (a taken one is refused), shows up in `crosstalk_peers` and in the
sidebar, and travels with every message, so the inbox always shows who is
speaking.

### TUI avatars

Sessions that declare themselves get a cartoon avatar in the OpenCode TUI
sidebar, with their name, their role, and their live status summary below it:

![A session in the TUI sidebar: the block-art avatar above the name "Pixel" and the role "avatar-integrator"](assets/screenshot.png)

The avatar is picked from a bundled pool of 92 characters (DiceBear *Personas*,
CC BY 4.0 — see [`assets/avatars/ATTRIBUTION.md`](assets/avatars/ATTRIBUTION.md);
browse the pool by opening `assets/avatars/index.html` in a browser):

- `crosstalk_status { name: "Rita", role: "coder", avatar: "👩" }` — the emoji is
  a hint: 👩/👨 pick the character pool, and the skin tone is baked into the art.
- `crosstalk_status { summary: "Rewriting the session store so a reload keeps its leases." }`
  — the live status line under the avatar: one or two short sentences (200
  characters) on what the session is doing *right now*. It is wrapped to the
  avatar's width, falls back to the declared goal until a summary is written,
  and lands in `crosstalk_peers` output for the other sessions. Because it is
  pushed to the TUI on every declaration (the same debounced `changed` event,
  see below), refreshing it with the next `crosstalk_status` call updates the
  sidebar within a second — keep it current as your task moves.
- An avatar appears when the session has a task: the first `crosstalk_status`
  that carries a role or a goal freezes one portrait onto the session, and
  nothing changes it afterwards — a later role, name, or avatar hint cannot
  move the artwork. A session with only a name, or nothing at all, shows no
  avatar.
- The declared role picks the character when it matches a pool seed (`coder`,
  `reviewer`, `explorer`, …); otherwise the name hashes to a stable one. The
  portrait is stored on the session record, so it survives reloads and
  restarts.
- Every avatar also carries an **emoticon** — one curated glyph for its role
  (`coder` → 💻, `librarian` → 📚, 46 roles), chosen from tools, objects, and
  people and never a smiley. It is derived from the manifest entry, so the same
  character always shows the same glyph.
- That glyph is shown beside the avatar's name in the sidebar **and** written
  into the session title, because the tab header has no slot a plugin can render
  into — its label *is* the title. `💻 Refactor the session store`.

The title write is deliberately narrow: only a session that declared a name, and
only one in the TUI's own directory or below it, is retitled; the write is
idempotent (a title already carrying its glyph is left alone, so the
`session.renamed` event it causes is a no-op), a stale glyph is replaced rather
than stacked, and an emoji you typed yourself is never stripped. Renames are
durable server state, so a decorated title outlives the TUI that wrote it.

The server plugin exposes the session directory over RPC (a `directory` method
plus a debounced `changed` event); the CLI plugin in `tui.ts` / `src/tui/`
renders it, location-scoped, into `sidebar.content`. The image uses OpenTUI's
**block** renderer on purpose: `sidebar.content` sits inside a scrollbox and the
terminal we target (VS Code) announces sixel support but never paints the
payload. On a kitty-graphics terminal, switching `protocol` in
`src/tui/index.tsx` from `blocks` to `auto` gives crisp pixels.

### Drop-in AGENTS.md snippet

Copy this block into a project's `AGENTS.md` to teach its sessions how to
coordinate without stalling. The `<!-- … -->` markers make it easy to find and
replace later.

```markdown
<!-- opencode-crosstalk:begin -->
## OpenCode Crosstalk

Other OpenCode sessions in this workspace are reachable through the
`opencode-crosstalk` plugin: `crosstalk_status`, `crosstalk_peers`,
`crosstalk_send`, `crosstalk_inbox`, `crosstalk_claim`, `crosstalk_wait`.
Write in **English only** and keep everything token-tight: one short sentence
per status, message, or claim note (who, what, where) — no reports, no
summaries, no pleasantries. Keep working; only stop for coordination that
prevents a real collision.

- **Declare once — briefly — then keep moving.** `crosstalk_status` sets a unique
  human name (so the user can say "tell George…" and peers can address you), your
  role, and a goal of a few words; `crosstalk_peers` shows active sessions and
  their leases. Work that does not overlap theirs needs no coordination.
- **Keep a live summary under your avatar.** `crosstalk_status { summary: … }` —
  one or two short sentences on what you are doing right now — is shown under
  your avatar in the sidebar and read by peers through `crosstalk_peers`, so
  refresh it whenever your task changes.
- **Talk before you collide — as a notice, not an essay.** If you need something a
  peer holds, `crosstalk_send` one short precise sentence (`to: "George"` or a
  session id) and continue elsewhere; replies are injected into live turns (use
  `crosstalk_inbox` to catch up). Never force a claim.
- **Lease what you are editing now.** `crosstalk_claim` takes an exclusive
  expiring lease on exact paths — no globs (`resources`, `note`, `ttlSeconds`);
  keep the note to a few words. `renew` if the work runs long, `release` when
  done; a refusal names the holder.
- **Only sessions in this project are reachable** — peers marked "not addressable"
  (location unknown or a different project) cannot receive mail, so do not try.

Installed globally — `opencode api get /api/plugin` shows `opencode.crosstalk`
active.
<!-- opencode-crosstalk:end -->
```

## Design notes

**Discovery is event-driven.** The V2 plugin context exposes a narrow slice of
the session API: no `session.list()`, no `session.active()`. `ctx.event.subscribe()`
is the only way a plugin learns that other sessions exist, so the presence
registry is a reducer over `session.created`, `session.status`,
`session.execution.*`, `session.idle`, `session.renamed`, `session.moved`,
`session.forked`, and `session.deleted`. One consequence worth knowing: a
session that was already mid-turn when the plugin loaded stays invisible until
it emits something, and it shows up on its next event.

**Delivery is retried, not just queued.** A plugin instance belongs to one
location, so injecting into a session owned by another location can fail. The
message stays in the recipient's mailbox, and every crosstalk tool first retries
any injection that is still outstanding for the calling session — so a peer
recovers the moment it does anything at all, without anyone polling. Retries are
bounded (50 per session) and expire with the message TTL.

**Liveness has two thresholds.** An agent can sit inside one model call for
minutes without emitting anything, so a peer is only flagged *stale* after
`staleAfterMs` (10 min) and only *evicted* after `evictAfterMs` (1 h).

**A claim is a hard lease, not a note.** Paths are normalized
(`./src/a.ts` = `src//a.ts`, and relative paths resolve against the holder's
directory so two worktrees do not shadow each other), leases expire, and a batch
request is atomic: one busy file means nothing is taken.

**A claim key is an exact path, not a glob.** There is no pattern matching:
`src/auth/**` is stored as the literal key `/repo/src/auth/**` and protects
nothing underneath it, so list the files you mean — or claim the directory
itself and accept that it is one key, not a subtree.

**Messages are not persisted.** Peers and leases survive a plugin reload through
`ctx.storage`; mailboxes do not. Replaying stale mail after a restart is worse
than an empty inbox.

**Sessions carry a human name, but identity stays the session id.** A session
may give itself a unique nickname with `crosstalk_status { name: "George" }` so
the user can say "tell George…" and peers can address it by name in
`crosstalk_send`. Names are case-insensitively unique among visible peers — a
taken name is refused and names the holder — and travel with each message
(`fromName`), so the inbox shows who is talking even mid-session.

**The channel is walled to sessions provably in your project.** `scope` still
controls what a *listing* shows, but communication is stricter: a peer is
addressable only when its project (or directory, under `scope: "location"`) is
provably equal to yours. Unknown locations stay listed — marked
"not addressable" — but sends, role/`all` broadcasts, `crosstalk_wait`, and
injection retries all refuse them, so a session in another project folder can
neither be messaged nor have mail injected into it.

## Options

All optional; set them with the object form of `plugins`:

```jsonc
{
  "plugins": [
    {
      "package": "../opencode-crosstalk",
      "options": {
        "scope": "project",
        "claimTtlMs": 300000,
        "codemode": false
      }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `namespace` | `crosstalk` | Tool namespace. Dots are rejected: the host rewrites them to `_`. |
| `permission` | `crosstalk` | Permission action for all six tools. |
| `codemode` | `false` | Expose the tools through Code Mode instead of directly. |
| `scope` | `project` | Peer visibility: `project`, `location`, or `server`. |
| `staleAfterMs` | `600000` | Silence after which a peer is flagged stale. |
| `evictAfterMs` | `3600000` | Silence after which a peer is dropped. Never below `staleAfterMs`. |
| `maxMessages` | `100` | Retained messages per mailbox. |
| `messageTtlMs` | `86400000` | Message lifetime. |
| `claimTtlMs` | `300000` | Default lease duration. |
| `maxWaitMs` | `120000` | Ceiling on any blocking call. |
| `pollMs` | `1000` | Poll interval for the barrier waits. |
| `heartbeatMs` | `10000` | Progress heartbeat while blocked; `0` disables. |
| `persist` | `true` | Persist peers and leases through `ctx.storage`. |
| `storageKey` | `crosstalk` | Storage key prefix. |
| `announce` | `true` | Add the coordination briefing to the system prompt. |

Bad values degrade to the default with a warning; a typo never costs an agent
its tools mid-session.

### How the permission action and `codemode` are used

Both were confirmed against the host's own tool snapshot, which reads roughly
`tool.options?.permission ?? <effective tool name>` when it filters the catalog,
and splits tools on `options.codemode === false` (direct) versus everything else
(Code Mode catalog). So:

- `permission: "crosstalk"` makes the action that gates all six tools. Without
  it, the action would fall back to the effective tool name — `crosstalk_status`,
  `crosstalk_claim`, and so on — needing six rules instead of one.
- `codemode: false` is what makes the tools directly callable. Setting it to
  `true` moves them into the Code Mode catalog only, where they are reached
  through `execute` rather than called by name. That adds a second gate: the
  `execute` action with resource `*` decides whether Code Mode is available at
  all, so blocking either one is enough to make the tools unreachable.
- A rule that *blocks* the action keeps the tools out of the catalog entirely,
  so the model never sees them. `ask` behaves as usual and prompts.

## Development

```sh
npm install
npm test          # 224 unit tests, no network, no server
npm run typecheck
npm run test:e2e  # live smoke test, needs OPENCODE_E2E=1 and a usable model
npm run setup     # link the plugin in globally
```

The e2e test skips with a reason — rather than failing — when the configured
provider cannot serve the request, so a credits problem never looks like a
plugin regression. Point it at a specific model with `OPENCODE_E2E_MODEL`.

`src/core` imports nothing from OpenCode: the presence registry, mailboxes, and
claim table take an injected clock and are tested directly. `src/index.ts`
(server) and `src/tui/index.tsx` (CLI) are the only places that talk to the
host; `src/rpc.ts` is the shared contract and imports only types. `scripts/setup.mjs`
is plain JavaScript and sits outside `tsconfig.json`, so it is not part of the
typecheck.

## License

MIT © 2026 Christoph Döllinger — see [LICENSE](LICENSE).
