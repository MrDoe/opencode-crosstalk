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

1. upgrades npm to 12 (Node 22 bundles npm 10, which has no `stage` command
   and no OIDC trusted publishing),
2. runs `npm ci` and `npm run check`,
3. on tag refs, asserts `v<package.json version>` equals the tag,
4. runs `npm stage publish --access public` — authentication is the GitHub OIDC
   token, not a secret,
5. points the job summary at the npm page for approval.

Approval happens in the npm web UI (browser 2FA). `npm stage list` and
`npm stage approve` require interactive authentication and cannot use an OIDC
token, so they are not workflow steps.

## Setup

- On npmjs.com → package Settings → Trusted publishing → GitHub Actions:
  `MrDoe` / `opencode-crosstalk` / `publish.yml`. Staged publishing is always
  allowed for a trusted publisher; direct `npm publish` is a separate opt-in.
- No `NPM_TOKEN` secret. Nothing expires or needs rotation. The workflow has
  `id-token: write` and `contents: read`.
- A newly created trusted publisher must complete its first publish within
  2 days or the configuration expires.
- Provenance is generated automatically for trusted publishing from a public
  repository; no `--provenance` flag.

## History

`opencode-crosstalk@0.2.0` was the first publish (2026-10-29), made directly
with a short-lived 2FA-bypass token before trusted publishing was configured.
The registry exposed a `0.0.0-stage` stub while the first publish was being
processed; `latest` moved to `0.2.0` once it completed. The token was replaced
by OIDC trusted publishing, which is why the workflow needs no secret at all.
