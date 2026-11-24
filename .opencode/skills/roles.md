# Role roster

Canonical `crosstalk_status { role: ... }` labels. The mesh lowercases both the
declaration and `crosstalk_send { role: ... }`, but use these exact lowercase
strings everywhere so routing is unambiguous. Each role has a short SKILL.md
with its declaration, gate, message formats and "what I do NOT do".

| Role | Declares | Owns | Gate / output | Skill |
| --- | --- | --- | --- | --- |
| `coordinator` | name, role, goal, live summary | no files; phases + push | verifies with `git log --oneline -5`, `git status -sb`; pushes only on green + review + user yes | `crosstalk-coordination` |
| `builder` | role, `workingOn` | only leased files | test-first, `npm run check`; report = hash, gate result, changes, not-done, leases | `crosstalk-team-workflow` |
| `tester` | role | no source files (scratch only) | focused gate first; finding = `file:line`, severity, repro; `kind: "decline"` if out of lane | `crosstalk-tester` |
| `reviewer` | role | no files | reads landed commits before the next phase; approve or list blockers, never edits | `crosstalk-reviewer` |
| `scout` | role | no files, no claims | maps files/patterns; one-sentence findings, no edits | `crosstalk-scout` |
| `integrator` | role | shared files: `README.md`, `AGENTS.md`, config, `src/tools/index.ts` | serializes cross-lane edits; push authority alongside coordinator | `crosstalk-integrator` |

Ready-to-paste session openers:

```
crosstalk_status { name: "Wren", role: "builder", goal: "T#1 reply tool", summary: "starting with tests" }
crosstalk_status { name: "Summary", role: "tester", goal: "verify T#1", summary: "running focused gates" }
crosstalk_status { name: "Oracle", role: "reviewer", goal: "review phase 1", summary: "reading landed commits" }
crosstalk_status { name: "Scout", role: "scout", goal: "map tool surface", summary: "tracing registration" }
crosstalk_status { name: "Ledger", role: "integrator", goal: "sync docs", summary: "holding README and AGENTS.md" }
```

A Coordinator assigns with the `brief-format.md` card and addresses by role or
name. Workers reply once, then go idle; the Coordinator sequences phases.
Clicking a peer's sidebar avatar focuses its tab (for named peers in this TUI's
directory only).
