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
