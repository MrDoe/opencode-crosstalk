import assert from "node:assert/strict"
import { test } from "node:test"
import type { DirectoryEntry } from "../src/core/directory.ts"
import { focusPeer } from "../src/tui/focus.ts"

function tabsFake() {
  const focused: string[] = []
  return {
    focused,
    focus(sessionID: string) {
      focused.push(sessionID)
      return true
    },
  }
}

function entry(overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    sessionID: "ses_peer",
    status: "idle",
    title: "peer",
    name: "Wren",
    role: "builder",
    directory: "/repo",
    projectID: "proj-1",
    ...overrides,
  }
}

test("clicking an avatar focuses a named peer in this TUI's place", () => {
  const tabs = tabsFake()
  assert.equal(focusPeer(tabs, "ses_peer", "/repo", entry()), true)
  assert.deepEqual(tabs.focused, ["ses_peer"])
})

test("focus refuses a peer in another worktree", () => {
  const tabs = tabsFake()
  assert.equal(focusPeer(tabs, "ses_peer", "/repo", entry({ directory: "/other" })), false)
  assert.deepEqual(tabs.focused, [])
})

test("focus refuses a peer that never declared a name", () => {
  const tabs = tabsFake()
  assert.equal(focusPeer(tabs, "ses_peer", "/repo", entry({ name: undefined })), false)
  assert.deepEqual(tabs.focused, [])
})

test("focus refuses a peer outside the session's own directory", () => {
  const tabs = tabsFake()
  assert.equal(focusPeer(tabs, "ses_peer", "/repo", entry({ directory: "/repo-other" })), false)
  assert.deepEqual(tabs.focused, [])
})
