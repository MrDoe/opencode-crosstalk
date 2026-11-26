---
title: Tool argument validation and error clarity
tags: [concept, tools, errors, validation]
sourceRefs: [src/tools/args.ts, src/tools/types.ts, src/tools/claim.ts, src/tools/wait.ts, AGENTS.md, test/tools.test.ts]
lastReviewed: 2026-11-05
---

# Tool argument validation and error clarity

A crosstalk tool call passes two validators before it does any work:

1. **The host checks the JSON Schema.** It runs before `execute`, and its
   failure is the generic block:

   ```text
   Invalid arguments for tool "crosstalk_claim":
   - action: Missing key

   Update the arguments and call the tool again.
   ```

   That message names the key but not its accepted values, and it never reaches
   the tool's own code.

2. **The executor narrows the input** through `readString`, `readNumber`,
   `readBoolean`, `readEnum`, and `readStringArray` (`src/tools/args.ts`). An
   `ArgError` becomes `crosstalk: …` content in `run()` (`src/tools/types.ts`),
   so the model can correct itself without a thrown stack trace.

## Rule: keep inferable fields out of `required`

Because the host rejects a missing required key before the executor can speak,
a field that the executor can infer should be optional in the schema. The
schema and executor must agree: if `required` omits a key, the executor has to
accept the omission.

| Tool | Optional field | Inference |
| --- | --- | --- |
| `crosstalk_claim` | `action` | non-empty `resources` → `claim`; otherwise → `list` |
| `crosstalk_wait` | `for` | only `sessionID` → `peer_idle`; only `resource` → `claim_free` |

`crosstalk_wait` refuses to guess when both `sessionID` and `resource` are set
and returns `give "for" …`; with neither it returns
`"for" is required — use "peer_idle" … or "claim_free" …`. Non-inferable
required fields (`send`'s `text`) stay in `required`, where the host's
`Missing key` is already the whole story.

## Errors carry the offending value

`readEnum` appends what it received:

```text
crosstalk: "action" must be one of: claim, renew, release, list (got "teleport")
```

Cross-field rules return a sentence with the next step instead of a code:
`action "claim" needs "resources" — the exact file paths or named resources you
mean (use action "list" to see what you hold)`.

## Invariants

- The JSON Schema is advisory; the executor is authoritative. Keep limits in
  both (`max`, `min`, `maxLength`).
- Bad input is returned as text, never thrown; any other error is a real bug.
- Tests assert the user-visible text (`test/tools.test.ts`), so wording changes
  are test changes.

## See also

- [[entities/mesh]] — what `claim` and `wait` do once the arguments arrive.
- [[concepts/communication-wall]] — the scope checks `crosstalk_wait` applies.
