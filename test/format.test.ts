import assert from "node:assert/strict"
import { test } from "node:test"
import {
  ellipsis,
  formatClaims,
  formatInbox,
  formatMessage,
  formatPeers,
  formatSend,
  formatStatus,
  formatWait,
  relativeAge,
} from "../src/core/format.ts"
import type { ClaimOutcome, PeerView } from "../src/types.ts"
import { message } from "./helpers/fakes.ts"

const NOW = 1_700_000_000_000

function peer(overrides: Partial<PeerView> = {}): PeerView {
  return {
    sessionID: "ses_a",
    status: "running",
    lastSeen: NOW - 4_000,
    isSelf: false,
    stale: false,
    unread: 0,
    claims: [],
    addressable: true,
    ...overrides,
  }
}

function outcome(overrides: Partial<ClaimOutcome> = {}): ClaimOutcome {
  return { claimed: [], renewed: [], released: [], stolen: [], conflicts: [], rolledBack: false, ...overrides }
}

test("relativeAge renders compact units", () => {
  assert.equal(relativeAge(NOW, NOW), "0s")
  assert.equal(relativeAge(NOW - 4_000, NOW), "4s")
  assert.equal(relativeAge(NOW - 59_000, NOW), "59s")
  assert.equal(relativeAge(NOW - 60_000, NOW), "1m")
  assert.equal(relativeAge(NOW - 3_600_000, NOW), "1h")
  assert.equal(relativeAge(NOW - 172_800_000, NOW), "2d")
  assert.equal(relativeAge(NOW + 5_000, NOW), "0s", "a future timestamp never goes negative")
})

test("ellipsis flattens whitespace and truncates with one character", () => {
  assert.equal(ellipsis("a  b\nc", 10), "a b c")
  assert.equal(ellipsis("short", 10), "short")
  assert.equal(ellipsis("0123456789", 5), "0123…")
})

test("formatStatus renders identity, declaration, and the peer list", () => {
  const output = formatStatus({
    self: peer({
      sessionID: "ses_self",
      isSelf: true,
      agent: "build",
      title: "Refactor auth",
      declared: {
        name: "George",
        role: "migrator",
        goal: "move auth off sessions",
        summary: "half the handlers are moved",
        workingOn: ["src/auth/session.ts"],
      },
      claims: ["/repo/src/auth/session.ts"],
    }),
    peers: [
      peer({
        sessionID: "ses_b",
        title: "Fix login",
        agent: "plan",
        declared: { summary: "checking the login flow against the new store" },
        claims: ["/repo/src/db.ts"],
      }),
    ],
    scope: "project",
    now: NOW,
    hints: ["you have 1 unread message(s) — crosstalk_inbox"],
  })

  assert.equal(
    output,
    [
      "crosstalk: you are ses_self (George) (build) running",
      "  session: Refactor auth",
      "  role: migrator",
      "  goal: move auth off sessions",
      "  summary: half the handlers are moved",
      "  working on: src/auth/session.ts",
      "  your claims: /repo/src/auth/session.ts",
      "  peers on this channel (project): 1 peer, 1 running, 0 idle",
      '    - ses_b  running  summary="checking the login flow against the new store"  "Fix login"  plan  active 4s ago  claims /repo/src/db.ts',
      "  you have 1 unread message(s) — crosstalk_inbox",
    ].join("\n"),
  )
})

test("formatStatus ellipsizes a peer's summary so the line stays readable", () => {
  const output = formatStatus({
    self: peer({ sessionID: "ses_self", isSelf: true }),
    peers: [peer({ sessionID: "ses_b", declared: { summary: "s".repeat(80) } })],
    scope: "project",
    now: NOW,
  })
  assert.match(output, new RegExp(`summary="${"s".repeat(59)}…"`), "the summary is clipped, not wrapped")
  assert.doesNotMatch(output, /summary="s{60}"/, "nothing longer than the budget survives")
})

test("formatStatus shows a peer's goal and its summary, in that order", () => {
  const output = formatStatus({
    self: peer({ sessionID: "ses_self", isSelf: true }),
    peers: [peer({ sessionID: "ses_b", declared: { goal: "port auth", summary: "handlers half done" } })],
    scope: "project",
    now: NOW,
  })
  assert.match(output, /goal="port auth" {2}summary="handlers half done"/)
})

test("formatStatus annotates a summary's age only once it stops being fresh", () => {
  const output = formatStatus({
    self: peer({ sessionID: "ses_self", isSelf: true }),
    peers: [
      peer({ sessionID: "ses_stale", declared: { summary: "porting handlers", summaryAt: NOW - 14 * 60_000 } }),
      peer({ sessionID: "ses_fresh", declared: { summary: "porting handlers", summaryAt: NOW - 60_000 } }),
      peer({ sessionID: "ses_undated", declared: { summary: "porting handlers" } }),
      peer({ sessionID: "ses_future", declared: { summary: "porting handlers", summaryAt: NOW + 60_000 } }),
    ],
    scope: "project",
    now: NOW,
  })
  assert.match(output, /- ses_stale {2}running {2}summary="porting handlers" \(14m ago\)/, "an aging summary says how old it is")
  assert.match(output, /- ses_fresh {2}running {2}summary="porting handlers" {2}/, "a fresh summary needs no timestamp")
  assert.match(output, /- ses_undated {2}running {2}summary="porting handlers" {2}/, "an undated summary is not annotated")
  assert.match(output, /- ses_future {2}running {2}summary="porting handlers" {2}/, "a clock-skewed one stays unannotated")
})

test("a summary that only ever lived in the self view has no peer-line shape yet", () => {
  const output = formatStatus({
    self: peer({ sessionID: "ses_self", isSelf: true, declared: { summary: "reading auth handlers" } }),
    peers: [],
    scope: "project",
    now: NOW,
  })
  assert.match(output, / {2}summary: reading auth handlers/, "the self block prints the full text, unellipsized")
})

test("formatStatus says so when the session is alone", () => {
  const output = formatStatus({ self: peer({ sessionID: "ses_self", isSelf: true }), peers: [], scope: "server", now: NOW })
  assert.match(output, /0 peers, 0 running, 0 idle/)
  assert.match(output, /only session here/)
})

test("formatStatus flags stale peers and a stale self", () => {
  const output = formatStatus({
    self: peer({ sessionID: "ses_self", isSelf: true, status: "running", stale: true }),
    peers: [peer({ sessionID: "ses_b", status: "idle", stale: true })],
    scope: "project",
    now: NOW,
  })
  assert.match(output, /you are ses_self running\?/)
  assert.match(output, /1 stale/)
  assert.match(output, /- ses_b  idle\?/)
})

test("formatStatus reports unread counts on peers", () => {
  const output = formatStatus({
    self: peer({ sessionID: "ses_self", isSelf: true }),
    peers: [peer({ sessionID: "ses_b", unread: 2 })],
    scope: "project",
    now: NOW,
  })
  assert.match(output, /unread 2/)
})

test("formatPeers explains an empty channel instead of printing nothing", () => {
  const output = formatPeers({ self: peer({ sessionID: "ses_self", isSelf: true }), peers: [], scope: "project", now: NOW })
  assert.equal(
    output,
    [
      "crosstalk: no other sessions on this channel (scope project).",
      "Nobody is competing for files right now; you do not need to claim anything.",
    ].join("\n"),
  )
})

test("formatPeers lists the caller separately and counts the running ones", () => {
  const output = formatPeers({
    self: peer({ sessionID: "ses_self", isSelf: true, status: "idle", declared: { role: "reviewer" } }),
    peers: [peer({ sessionID: "ses_b" }), peer({ sessionID: "ses_c", status: "idle", agent: "plan" })],
    scope: "server",
    now: NOW,
  })
  assert.equal(
    output,
    [
      "crosstalk peers (scope server, 2 found, 1 running):",
      "  you: ses_self  idle  role=reviewer",
      "  - ses_b  running  active 4s ago",
      "  - ses_c  idle  plan  active 4s ago",
    ].join("\n"),
  )
})

test("formatPeers marks an undeclared role so peers know to ask", () => {
  const output = formatPeers({
    self: peer({ sessionID: "ses_self", isSelf: true }),
    peers: [peer({ sessionID: "ses_b" })],
    scope: "project",
    now: NOW,
  })
  assert.match(output, /role=undeclared/)
})

test("formatPeers shows declared human names", () => {
  const output = formatPeers({
    self: peer({ sessionID: "ses_self", isSelf: true, declared: { name: "George", role: "reviewer" } }),
    peers: [peer({ sessionID: "ses_b", declared: { name: "Alex" } })],
    scope: "project",
    now: NOW,
  })
  assert.match(output, /you: ses_self {2}\(George\) {2}running {2}role=reviewer/)
  assert.match(output, /- ses_b {2}\(Alex\) {2}running {2}active 4s ago/)
})

test("formatPeers marks peers outside the communication wall", () => {
  const output = formatPeers({
    self: peer({ sessionID: "ses_self", isSelf: true }),
    peers: [
      peer({ sessionID: "ses_unknown", addressable: false }),
      peer({ sessionID: "ses_other", projectID: "proj-9", directory: "/elsewhere", addressable: false }),
    ],
    scope: "project",
    now: NOW,
  })
  assert.match(output, /ses_unknown.*location unknown — not addressable/)
  assert.match(output, /ses_other.*outside the project scope — not addressable/)
})

test("formatMessage summarises sender, kind, topic, and age", () => {
  assert.equal(
    formatMessage({ message: message({ fromRole: "reviewer", kind: "request", topic: "auth" }), now: NOW }),
    "from ses_sender (reviewer) · request · topic auth · 0s ago",
  )
  assert.equal(formatMessage({ message: message(), now: NOW }), "from ses_sender · message · 0s ago")
})

test("formatMessage shows the sender's declared name when it has one", () => {
  assert.equal(
    formatMessage({ message: message({ fromName: "George", fromRole: "reviewer", kind: "request" }), now: NOW }),
    "from ses_sender (George) (reviewer) · request · 0s ago",
  )
})

test("formatInbox renders each message body indented under its header", () => {
  const output = formatInbox({
    self: peer({ sessionID: "ses_self", isSelf: true }),
    messages: [message({ id: "m1", text: "line one\nline two", kind: "request", fromName: "Ada" })],
    marked: 1,
    unread: 1,
    now: NOW,
    reason: "messages",
  })
  assert.equal(
    output,
    [
      "crosstalk inbox for ses_self: 1 message (1 unread)",
      "  [m1] from ses_sender (Ada) · request · 0s ago",
      "      line one",
      "      line two",
      "      ↳ answer with crosstalk_send to Ada",
      "  marked 1 message read",
    ].join("\n"),
  )
})

test("formatInbox hints no reply for plain messages, even role-addressed ones", () => {
  const output = formatInbox({
    self: peer({ sessionID: "ses_self", isSelf: true }),
    messages: [message({ id: "m2", text: "pure ack", meta: { requested: "coordinator" } })],
    marked: 0,
    unread: 1,
    now: NOW,
    reason: "messages",
  })
  assert.equal(output.includes("↳"), false, "a note is not a reply demand")
})

test("formatInbox explains each way of coming back empty-handed", () => {
  const base = { self: peer({ sessionID: "ses_self", isSelf: true }), messages: [], marked: 0, now: NOW }
  assert.match(formatInbox({ ...base, reason: "timeout" }), /nothing arrived before the wait expired/)
  assert.match(formatInbox({ ...base, reason: "aborted" }), /wait cancelled/)
  assert.match(formatInbox({ ...base, reason: "immediate" }), /empty/)
})

test("formatInbox notes that a truncated list is truncated", () => {
  const output = formatInbox({
    self: peer({ sessionID: "ses_self", isSelf: true }),
    messages: [message()],
    marked: 0,
    unread: 0,
    now: NOW,
    reason: "immediate",
    limit: 1,
  })
  assert.match(output, /showing the most recent 1/)
})

test("formatSend distinguishes delivered from queued", () => {
  const output = formatSend({
    self: peer({ sessionID: "ses_self", isSelf: true }),
    recipients: [
      { sessionID: "ses_b", delivered: true },
      { sessionID: "ses_c", delivered: false, reason: "session is busy" },
    ],
    skipped: [{ target: "ses_d", reason: "session unknown" }],
    text: "handing over the auth work",
    now: NOW,
  })
  assert.equal(
    output,
    [
      "crosstalk: signalled 2 sessions (1 delivered now, 1 queued in mailbox)",
      "  ✓ ses_b",
      "  · ses_c — queued only: session is busy",
      "  - ses_d: session unknown",
      "  message: handing over the auth work",
    ].join("\n"),
  )
})

test("formatSend points at the peer list when nobody matched", () => {
  const output = formatSend({
    self: peer({ sessionID: "ses_self", isSelf: true }),
    recipients: [],
    skipped: [],
    text: "anyone?",
    now: NOW,
  })
  assert.match(output, /signalled 0 sessions/)
  assert.match(output, /check crosstalk_peers/)
})

test("formatClaims reports a refusal with the holder, note, and time to live", () => {
  const output = formatClaims({
    self: peer({ sessionID: "ses_self", isSelf: true }),
    outcome: outcome({
      conflicts: [{ key: "/repo/src/a.ts", raw: "src/a.ts", holder: "ses_b", note: "migrating", expires: NOW + 30_000 }],
      rolledBack: true,
    }),
    ttlMs: 300_000,
    now: NOW,
    held: [],
  })
  assert.equal(
    output,
    [
      "crosstalk claim: refused — 1 resource already leased",
      "  - src/a.ts held by ses_b (migrating), free in 30s",
      "  wait for them with crosstalk_wait, signal them with crosstalk_send, or pass force: true to steal.",
      "  nothing was claimed (atomic request).",
    ].join("\n"),
  )
})

test("formatClaims omits the rollback note for a partial request", () => {
  const output = formatClaims({
    self: peer(),
    outcome: outcome({ conflicts: [{ key: "k", raw: "a.ts", holder: "ses_b", expires: 0 }] }),
    ttlMs: 300_000,
    now: NOW,
    held: [],
  })
  assert.match(output, /held by ses_b/)
  assert.doesNotMatch(output, /free in/, "an unknown expiry must not print a bogus duration")
  assert.doesNotMatch(output, /nothing was claimed/)
})

test("formatClaims summarises each kind of change and the resulting holdings", () => {
  const output = formatClaims({
    self: peer({ sessionID: "ses_self", isSelf: true }),
    outcome: outcome({ claimed: ["/repo/a.ts"], renewed: ["/repo/b.ts"], released: ["/repo/c.ts"], stolen: ["/repo/d.ts"] }),
    ttlMs: 300_000,
    now: NOW,
    held: [{ key: "/repo/a.ts", expires: NOW + 300_000, note: "migrating" }],
  })
  assert.equal(
    output,
    [
      "crosstalk claim: 1 claimed, 1 renewed, 1 released, 1 stolen from another session",
      "  + /repo/a.ts  (lease 300s)",
      "  ~ /repo/b.ts",
      "  - /repo/c.ts  released",
      "  you currently hold:",
      "    /repo/a.ts  expires in 5m (migrating)",
    ].join("\n"),
  )
})

test("formatClaims reports an empty request and an empty inventory", () => {
  const output = formatClaims({ self: peer(), outcome: outcome(), ttlMs: 300_000, now: NOW, held: [] })
  assert.equal(output, ["crosstalk claim: nothing to do", "  you hold no leases"].join("\n"))
})

test("formatWait covers every outcome", () => {
  assert.equal(
    formatWait({ forWhat: "peer_idle", reason: "done", elapsedMs: 1_234, detail: "ses_b" }),
    "crosstalk wait: peer idle after 1.2s — ses_b",
  )
  assert.equal(
    formatWait({ forWhat: "claim_free", reason: "gone", elapsedMs: 5_000 }),
    "crosstalk wait: target is gone after 5s",
  )
  assert.equal(
    formatWait({ forWhat: "peer_idle", reason: "outside", elapsedMs: 0, detail: "ses_b is outside the project scope" }),
    "crosstalk wait: ses_b is outside the project scope after 0s",
  )
  assert.equal(
    formatWait({ forWhat: "peer_idle", reason: "aborted", elapsedMs: 2_000 }),
    "crosstalk wait: cancelled after 2s while waiting for peer idle",
  )
  assert.equal(
    formatWait({ forWhat: "claim_free", reason: "timeout", elapsedMs: 30_000 }),
    "crosstalk wait: timed out after 30s waiting for claim free",
  )
})
