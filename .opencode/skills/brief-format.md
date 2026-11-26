# Task brief format

One shared card so a Coordinator's assignment and a worker's landing report
carry the same facts. The card maps straight onto `crosstalk_send` fields:
`topic` = the task id, `writeScope` / `validation` / `evidence` = the brief,
`kind: "request"` for an assignment, `kind: "answer"` for a report,
`kind: "decline"` when the work is outside the role.

```
T#<id> | phase <n> | owner <role/name>
files: <exact paths>
lease: crosstalk_claim on each file above
gate:  <command, e.g. npm run check; docs-only = none>
evidence: <commit hash + gate result + what changed + what was NOT done>
report-to: <coordinator name> | topic: T#<id>
```

Rules that make the card work:

- One file, one owner, one phase. Exact paths only: a directory lease covers
  nothing inside it and `**` is an ordinary path segment.
- The gate is a command, not "looks fine". Docs-only changes say `gate: none`
  explicitly instead of omitting it.
- `evidence` is what the recipient must show, not a claim that it happened. A
  commit hash in a message is a claim; the Coordinator checks `git log`.
- "What I did NOT do" is part of the evidence: deferred items, out-of-scope
  observations, anything noticed and left alone.
- Ack once per report. Never answer an ack with an ack.
- Reroute a decline; do not resend the same unchanged work to a different role
  without changing the brief.

Canonical role labels are lowercase so `crosstalk_send { role: "tester" }`
matches exactly. See `roles.md`.
