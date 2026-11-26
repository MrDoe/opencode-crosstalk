/**
 * @fileoverview CLI (TUI) plugin: the session avatar in the sidebar, with the
 * session's live status summary under it.
 *
 * The server plugin owns the directory (who declared what); this side renders
 * it. The RPC contract is shared as a plain object, so that no runtime plugin
 * module has to resolve in the TUI process.
 */

import { readFileSync } from "node:fs"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { Show, createMemo, createSignal } from "solid-js"
import { TextAttributes } from "@opentui/core"
import type { DirectoryEntry, DirectoryPayload } from "../core/directory.ts"
import { CrosstalkRpc } from "../rpc.ts"
import { focusPeer, inPlace } from "./focus.ts"
import { emoticonFor, entryForPortrait, isSummaryStale, summaryText, titleWithEmoticon, type AvatarEntry } from "./avatar.ts"

const manifestUrl = new URL("../../assets/avatars/manifest.json", import.meta.url)

/** Width of the avatar art, and so of the column the summary wraps inside. */
const AVATAR_WIDTH = 29

/**
 * How often the sidebar re-checks whether a summary went stale - and refetches
 * the directory. The directory is normally pushed by the server on mesh
 * mutations, but a missed push (restart, dropped event, location mismatch)
 * would otherwise freeze the sidebar until the TUI restarts; this tick makes
 * the sidebar self-healing. Without the tick an untouched summary could also
 * stay undimmed forever, because the directory is only rebuilt on mutations.
 */
const SUMMARY_TICK_MS = 30_000

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

function AvatarLine(props: {
  sessionID: string
  directory: () => DirectoryPayload
  entries: readonly AvatarEntry[]
  /** This TUI's location; only peers inside it may be focused. */
  home: string | undefined
  /** Starts a fresh staleness evaluation; see `SUMMARY_TICK_MS`. */
  tick: () => number
}) {
  const context = usePlugin()
  const [failed, setFailed] = createSignal(false)
  const session = () => props.directory().sessions.find((entry) => entry.sessionID === props.sessionID)
  // The live status line under the art: one or two short sentences on what the
  // session is doing right now, re-read from the directory so every refreshed
  // declaration shows up without a reload.
  const summary = () => summaryText(session())
  // Dimmed once the summary stops being refreshed: read on the tick so the dim
  // arrives on its own, without waiting for the next directory push.
  const stale = createMemo(() => {
    props.tick()
    return isSummaryStale(session()?.summaryAt, Date.now())
  })
  // The server froze the portrait when the session first declared a task;
  // a session without one has no task and shows no avatar. A portrait whose
  // art left the manifest is not swapped for another — it shows nothing.
  const picked = createMemo(() => entryForPortrait(props.entries, session()?.portrait))
  // Stable source: a fresh URL on every directory update would make the
  // renderable re-decode the PNG on each change event.
  const source = createMemo(() => {
    const entry = picked()
    return entry ? sourceFor(entry) : undefined
  })

  return (
    <Show when={picked()}>
      {() => (
        <box
          flexDirection="column"
          alignItems="center"
          gap={0}
          onMouseDown={() => {
            focusPeer(context.ui.tabs, props.sessionID, props.home, session())
          }}
        >
          {/*
            Blocks on purpose: the sidebar sits in a scrollbox and the terminal
            we target (VS Code) announces sixel but does not paint it, so cell
            drawing is the portable path. On kitty-graphics terminals this can
            be switched to "auto".
          */}
          <image
            source={source()}
            width={AVATAR_WIDTH}
            height={15}
            fit="cover"
            protocol="blocks"
            onError={() => setFailed(true)}
          />
          <text fg={context.theme.text.base}>{`${emoticonFor(picked())} ${session()?.name ?? "crosstalk"}`}</text>
          <text fg={context.theme.text.muted}>{session()?.role ?? ""}</text>
          <Show when={summary()}>
            {() => (
              <text
                fg={context.theme.text.muted}
                width={AVATAR_WIDTH}
                wrapMode="word"
                attributes={stale() ? TextAttributes.DIM : TextAttributes.NONE}
              >
                {summary()}
              </text>
            )}
          </Show>
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
    const [tick, setTick] = createSignal(0)
    const rpc = context.client.rpc(CrosstalkRpc)
    const location = context.location ?? context.data.location.default()

    /**
     * The tab header has no slot a plugin can render into — its label is the
     * session title — so the emoticon is written there instead.
     *
     * Deliberately narrow: only a session that declared a crosstalk name, and
     * only one in this TUI's directory or below it, may be renamed; `titleWithEmoticon`
     * returns nothing to write once the title already carries the glyph, so the
     * `session.renamed` event this triggers comes back as a no-op instead of a
     * loop. Anything the user titled themselves is left as they wrote it.
     */
    const written = new Map<string, string>()
    async function decorate(payload: DirectoryPayload): Promise<void> {
      const home = location?.directory
      if (home === undefined) return
      for (const entry of payload.sessions) {
        if (entry.name === undefined || !inPlace(entry.directory, home)) continue
        // The glyph freezes with the portrait: a later role change never
        // silently rewrites the user's tab title.
        const portrait = entryForPortrait(entries, entry.portrait)
        if (portrait === undefined) continue
        const wanted = titleWithEmoticon(entry.title, emoticonFor(portrait), entry.name)
        if (wanted === undefined || written.get(entry.sessionID) === wanted) continue
        written.set(entry.sessionID, wanted)
        try {
          await context.client.session.update({ sessionID: entry.sessionID, title: wanted })
        } catch {
          // Gone, or not ours to rename: forget the attempt and let the next
          // directory update retry it.
          written.delete(entry.sessionID)
        }
      }
    }

    const apply = (payload: unknown) => {
      const next = asPayload(payload)
      setDirectory(next)
      void decorate(next)
    }

    /**
     * Whether a `changed` push belongs to this TUI's location. Compared
     * through `normalizeResource` so a Windows path is not rejected for a
     * separator or a letter case, and an untagged push is accepted: every
     * server instance mirrors the same project mesh, so a foreign push is
     * still this directory - refusing it is what left the sidebar frozen.
     */
    const forHere = (eventDirectory: string | undefined): boolean => {
      if (location?.directory === undefined) return true
      if (eventDirectory === undefined) return true
      return normalizeResource(eventDirectory) === normalizeResource(location.directory)
    }

    const refetch = (): void => {
      rpc
        .directory({}, { location })
        .then(apply)
        .catch(() => {
          // Keep the last known directory; the next tick retries.
        })
    }

    // Slow tick for the summary's staleness dim and the directory refetch;
    // see `SUMMARY_TICK_MS`.
    const summaryClock = setInterval(() => {
      setTick((value) => value + 1)
      refetch()
    }, SUMMARY_TICK_MS)
    summaryClock.unref?.()

    try {
      apply(await rpc.directory({}, { location }))
    } catch {
      // The sidebar stays empty until the next push - or the next refetch tick.
    }
    const unsubscribe = rpc.events.on("changed", (event) => {
      if (!forHere((event as { location?: { directory?: string } }).location?.directory)) return
      apply(event.data)
    })

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <AvatarLine
          sessionID={input.sessionID}
          directory={directory}
          entries={entries}
          home={location?.directory}
          tick={tick}
        />
      ),
    })

    return () => {
      unsubscribe()
      unregister()
      clearInterval(summaryClock)
    }
  },
})
