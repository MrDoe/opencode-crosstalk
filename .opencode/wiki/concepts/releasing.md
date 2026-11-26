---
title: Releasing (staged publishing)
tags: [concept, release, ci, npm]
sourceRefs: [.github/workflows/publish.yml, package.json, README.md]
lastReviewed: 2026-11-26
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

`opencode-crosstalk@0.4.0` (2026-11-26) was cut after repairing merge `7dffd80`,
which had committed unresolved conflict markers in `src/config.ts`. The
`autoDeclare`/`loopGuard` conflict resolved by keeping both — each option drives
live code on its own side. The same merge had dropped the
`normalizeResource` import in `src/tui/index.tsx`, so a clean typecheck needs
both fixes. A tidy `git status` is no proof the committed tree parses: run the
check gate (`npm run check`) before versioning. Staged by run 45793715041
(stage id `70a3e9d1-79bd-4752-8b46-8e52290f5c37`, tag `latest`); browser
approval pending as of this writing.

`opencode-crosstalk@0.3.0` added reply/continue, evidence briefs, the doctor
self-check and the role skill kit. It was cut with `npm version minor` from
`main` after the feature commit, then `git push --follow-tags`.

The first tag run failed at `npm stage publish` with E401 "authentication token
seems to be invalid". The tarball, check and tag verification all passed; the
cause was `actions/setup-node@v4`, which writes a dummy `NODE_AUTH_TOKEN` into
`.npmrc` when no token is configured — npm sent that dummy token instead of
using OIDC. Two distinct failures had to be separated, which is why staging now runs with
`--loglevel=verbose`:

1. E401 "authentication token seems to be invalid" — `setup-node@v4` wrote a
   dummy `NODE_AUTH_TOKEN` into `.npmrc`. Fixed with `actions/checkout@v7`,
   `actions/setup-node@v7`, Node 24, `package-manager-cache: false`, no
   `cache: npm`, and finally removing `registry-url` entirely (public installs
   need no auth, and `registry-url` leaves an `_authToken` line even in v7).
2. ENEEDAUTH with `POST/-/npm/v1/oidc/token/exchange/package/opencode-crosstalk`
   → **404 "package not found"**. GitHub's OIDC token request succeeds (200,
   audience `npm:registry.npmjs.org`); npm rejects the exchange. The trusted
   publisher was configured 2026-10-29 but never used — 0.2.0 was published
   with a short-lived token — and npm expires an unvalidated configuration
   after 2 days. This one needs a human at npmjs.com: delete the expired
   trusted publisher, add a new GitHub Actions one
   (`MrDoe` / `opencode-crosstalk` / `publish.yml`, stage-publish allowed), then
   re-run the tag workflow. Approval of the staged tarball still needs browser
   2FA. No 0.3.0 tarball was published or staged.

`opencode-crosstalk@0.2.0` was the first publish (2026-10-29), made directly
with a short-lived 2FA-bypass token before trusted publishing was configured.
The registry exposed a `0.0.0-stage` stub while the first publish was being
processed; `latest` moved to `0.2.0` once it completed. The token was replaced
by OIDC trusted publishing, which is why the workflow needs no secret at all.
