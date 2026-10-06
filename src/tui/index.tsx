/**
 * @fileoverview CLI (TUI) plugin: the session avatar in the sidebar.
 *
 * The server plugin owns the directory (who declared what); this side renders
 * it. The RPC contract is shared as a plain object, so that no runtime plugin
 * module has to resolve in the TUI process.
 */

import { readFileSync } from "node:fs"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { Show, createMemo, createSignal } from "solid-js"
import type { DirectoryEntry, DirectoryPayload } from "../core/directory.ts"
import { CrosstalkRpc } from "../rpc.ts"
import { chooseAvatar, type AvatarEntry } from "./avatar.ts"

const manifestUrl = new URL("../../assets/avatars/manifest.json", import.meta.url)

function loadEntries(): AvatarEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(manifestUrl, "utf8")) as { entries?: AvatarEntry[] }
    return Array.isArray(parsed.entries) ? parsed.entries : []
  } catch {
    return []
  }
}

const sourceCache = new Map<string, URL>()

function sourceFor(entry: AvatarEntry): URL {
  const key = `${entry.pool}/${entry.file}`
  let url = sourceCache.get(key)
  if (!url) {
    url = new URL(`../../assets/avatars/${key}`, import.meta.url)
    sourceCache.set(key, url)
  }
  return url
}

function asPayload(value: unknown): DirectoryPayload {
  const sessions = (value as { sessions?: unknown } | undefined)?.sessions
  return { sessions: Array.isArray(sessions) ? (sessions as DirectoryEntry[]) : [] }
}

function AvatarLine(props: { sessionID: string; directory: () => DirectoryPayload; entries: readonly AvatarEntry[] }) {
  const context = usePlugin()
  const [failed, setFailed] = createSignal(false)
  const session = () => props.directory().sessions.find((entry) => entry.sessionID === props.sessionID)
  const picked = () => {
    const current = session()
    return current ? chooseAvatar(props.entries, current) : undefined
  }
  // Stable source: a fresh URL on every directory update would make the
  // renderable re-decode the PNG on each change event.
  const source = createMemo(() => {
    const entry = picked()
    return entry ? sourceFor(entry) : undefined
  })

  return (
    <Show when={picked()}>
      {() => (
        <box flexDirection="column" alignItems="center" gap={0}>
          {/*
            Blocks on purpose: the sidebar sits in a scrollbox and the terminal
            we target (VS Code) announces sixel but does not paint it, so cell
            drawing is the portable path. On kitty-graphics terminals this can
            be switched to "auto".
          */}
          <image
            source={source()}
            width={29}
            height={15}
            fit="cover"
            protocol="blocks"
            onError={() => setFailed(true)}
          />
          <text fg={context.theme.text.base}>{session()?.name ?? "crosstalk"}</text>
          <text fg={context.theme.text.muted}>{session()?.role ?? ""}</text>
          <Show when={failed()}>
            <text fg={context.theme.text.muted}>[image failed]</text>
          </Show>
        </box>
      )}
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.crosstalk.tui",
  async setup(context) {
    const entries = loadEntries()
    const [directory, setDirectory] = createSignal<DirectoryPayload>({ sessions: [] })
    const apply = (payload: unknown) => {
      setDirectory(asPayload(payload))
    }

    const rpc = context.client.rpc(CrosstalkRpc)
    const location = context.location ?? context.data.location.default()
    try {
      apply(await rpc.directory({}, { location }))
    } catch {
      // The sidebar stays empty until the next change event arrives.
    }
    const unsubscribe = rpc.events.on("changed", (event) => {
      const eventDirectory = (event as { location?: { directory?: string } }).location?.directory
      if (location?.directory !== undefined && eventDirectory !== location.directory) return
      apply(event.data)
    })

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input) => <AvatarLine sessionID={input.sessionID} directory={directory} entries={entries} />,
    })

    return () => {
      unsubscribe()
      unregister()
    }
  },
})
