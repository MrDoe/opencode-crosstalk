# Avatar pool scripts

The sidebar avatars in `assets/avatars/` are DiceBear **Personas** renders
(CC BY 4.0 — see [`../../assets/avatars/ATTRIBUTION.md`](../../assets/avatars/ATTRIBUTION.md)).
These scripts regenerate them.

| Script | Purpose |
| --- | --- |
| `generate.ps1` | Generate the base female/male pools (50 role seeds each) into `assets/avatars/`. |
| `regenerate.ps1` | Reproduce the curated pool file by file from `pool.json` — keeps the hand-sorted folders. |
| `sheet.ps1` | Rebuild `assets/avatars/index.html`, a browsable contact sheet. |

`pool.json` records, for every curated file, the pool it was generated with
(`from` — not necessarily its current folder after curation), the role seed, and
the skin tone. The resolved DiceBear options per file live in
`assets/avatars/manifest.json`.

Requirements: PowerShell with internet access (the DiceBear HTTP API). Images are
256 px — the API caps PNG output there. Generation is deterministic, so the same
`pool.json` reproduces byte-identical files.
