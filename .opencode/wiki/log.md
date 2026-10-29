# Wiki log

## [2026-10-29] seed | runtime, install, and coordination wall
Read `src/index.ts`, `src/core/mesh.ts`, `src/config.ts`, `scripts/setup.mjs`, the
README, and the test harness. Seeded the entity pages for the plugin entrypoint
and the mesh, plus the briefing, global-install, and communication-wall concepts.

## [2026-10-29] ingest | always-on session briefing
The `context` hook used to return early at zero peers and zero leases, so the
first session in a project never learned the channel existed and never declared
a name or role. It now always pushes a briefing: a compact declaration nudge
while alone, the full coordination text once a peer or lease exists. Tests
updated (`test/setup.test.ts`), README and AGENTS.md brought in line.

## [2026-10-29] release | v0.2.0
Bumped `package.json`/`package-lock.json` to 0.2.0, committed the always-on
briefing, tagged `v0.2.0`, pushed `main` + tag, and created the GitHub release.
npm publish is pending credentials (`npm whoami` → ENEEDAUTH); the tarball
dry-run is clean.

## [2026-10-29] release | npm 0.2.0 live and staged publishing workflow
`opencode-crosstalk@0.2.0` is live on npm and `latest` points at it; the
`0.0.0-stage` stub was the registry's first-publish placeholder and stays in the
version list. Added `.github/workflows/publish.yml`: `v*` tags run the check,
verify the tag against `package.json`, and stage with
`npm stage publish --provenance`; approval happens in the npm web UI with
browser 2FA. The workflow upgrades npm to 12 first (Node 22 ships npm 10, which
has no `stage`). `NPM_TOKEN` repository secret still has to be created.

## [2026-10-29] release | trusted publishing replaces the 7-day token
Deleted the `NPM_TOKEN` secret. `.github/workflows/publish.yml` now authenticates
with GitHub OIDC (`id-token: write`) and runs `npm stage publish --access public`
with no token at all. One-time setup on npmjs.com: package Settings → Trusted
publishing → GitHub Actions, `MrDoe` / `opencode-crosstalk` / `publish.yml`;
the config must complete its first publish within 2 days. `npm stage list` and
`npm stage approve` cannot use OIDC, so approval stays in the browser.
