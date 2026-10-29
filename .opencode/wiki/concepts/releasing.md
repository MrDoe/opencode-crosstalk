---
title: Releasing (staged publishing)
tags: [concept, release, ci, npm]
sourceRefs: [.github/workflows/publish.yml, package.json, README.md]
lastReviewed: 2026-10-29
---

# Releasing (staged publishing)

Releases are staged by CI and approved by a human, because npm's proof-of-presence
(2FA) cannot be answered in a non-interactive terminal. Staging requires no 2FA;
approving always does.

## Flow

```sh
npm version minor        # bumps package.json + package-lock.json, commits, tags
git push --follow-tags   # v* tag triggers .github/workflows/publish.yml
```

The workflow:

1. upgrades npm to 12 (Node 22 bundles npm 10, which has no `stage` command),
2. runs `npm ci` and `npm run check`,
3. on tag refs, asserts `v<package.json version>` equals the tag,
4. runs `npm stage publish --access public --provenance` with `NODE_AUTH_TOKEN`,
5. lists staged versions and points the job summary at the npm page.

Approval happens in the npm web UI (browser 2FA), or via
`npm stage list` / `npm stage approve <stage-id>` where an OTP works.

## Setup

- Repository secret `NPM_TOKEN`: a granular token with read/write package
  access. It does **not** need 2FA bypass, because staging never prompts.
- `workflow_dispatch` stages whatever version is in `package.json` (no tag
  check); useful for re-staging.

## History

`opencode-crosstalk@0.2.0` was the first publish (2026-10-29), made directly
with a 2FA-bypass token before the workflow existed. The registry exposed a
`0.0.0-stage` stub while the first publish was being processed; `latest` moved
to `0.2.0` once it completed. npm now warns that bypass tokens are being
restricted for direct publishing, which is why automation stages instead.
