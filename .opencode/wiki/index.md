---
title: opencode-crosstalk wiki
tags: [index]
sourceRefs: [README.md, AGENTS.md]
lastReviewed: 2026-10-29
---

# opencode-crosstalk wiki

Synthesis of the plugin's runtime, its install surface, and the decisions that
keep coordination working across every OpenCode session.

## Entities

- [[entities/plugin-entrypoint]] — `src/index.ts`: what `setup` wires and what its cleanup undoes.
- [[entities/mesh]] — `src/core/mesh.ts`: the host-free façade over presence, mailboxes, and leases.

## Concepts

- [[concepts/session-briefing]] — how the model learns crosstalk exists, including when it is alone.
- [[concepts/global-installation]] — global discovery, the symlink installer, and how to verify a load.
- [[concepts/communication-wall]] — listing is permissive; sending is walled to a provable project.
- [[concepts/releasing]] — tag-triggered staging, browser approval, and the `NPM_TOKEN` secret.
