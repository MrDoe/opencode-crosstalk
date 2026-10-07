/**
 * @fileoverview OpenCode plugin entry point.
 *
 * `setup` wires four things and returns the cleanup that undoes all of them:
 *
 * 1. a `Mesh` (presence registry, mailboxes, claim table) built on the plugin
 *    location, seeded from a persisted snapshot when one exists;
 * 2. a subscription to the server event stream, which is the only way a plugin
 *    learns that other sessions exist — the plugin context has no
 *    `session.list()`;
 * 3. the six `crosstalk_*` tools, registered under one namespace and one
 *    permission action;
 * 4. a `context` hook that tells the model the channel exists, so the tools get
 *    used without the user having to ask.
 *
 * The OpenCode-specific types are imported through the published package, but
 * only as types plus `Plugin.define`, keeping the core free of host coupling.
 */

import { readFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import { parseOptions } from "./config.ts"
import { type AvatarEntry } from "./core/avatar.ts"
import { systemClock } from "./core/clock.ts"
import { directoryPayload } from "./core/directory.ts"
import { Mesh } from "./core/mesh.ts"
import { createSessionDeliverer, type SessionLike } from "./deliverer.ts"
import { pumpEvents } from "./events.ts"
import { CrosstalkRpc } from "./rpc.ts"
import { MeshStore, type StorageLike } from "./storage.ts"
import { registerTools } from "./tools/index.ts"

/** Plugin identity. Also the `plugins: ["-opencode.crosstalk"]` disable key. */
export const id = "opencode.crosstalk"

/** Debounce window for snapshot writes triggered by event traffic. */
const PERSIST_DEBOUNCE_MS = 2_000

/** Debounce window for RPC directory pushes triggered by mesh mutations. */
const RPC_DEBOUNCE_MS = 500

/**
 * Bridge the real session domain to the narrow shape the deliverer needs.
 * `Session.ID` is a branded string and the metadata index signature is typed
 * as the server's `JsonValue`; the mesh works in plain strings and plain JSON,
 * so both are narrowed once, here, instead of throughout the plugin.
 */
function toSessionLike(session: Plugin.Context["session"]): SessionLike {
  return {
    synthetic: ({ sessionID, text, description, delivery, metadata }) =>
      session.synthetic({
        sessionID: sessionID as never,
        text,
        ...(description === undefined ? {} : { description }),
        ...(delivery === undefined ? {} : { delivery }),
        ...(metadata === undefined ? {} : { metadata: metadata as never }),
      }),
  }
}

function briefing(peers: number, claims: number): string {
  return [
    "Other OpenCode sessions can be working in this repository with you.",
    "Coordinate in English only and keep it token-tight: one short sentence per status, message, or claim.",
    "Declare once — briefly — then keep moving: `crosstalk_status` sets a unique human name (so the user can say",
    '"tell George…" and peers can address you) plus your role and a goal of a few words; `crosstalk_peers` shows',
    "active sessions and their leases, and work that does not overlap theirs needs no coordination.",
    "Talk before you collide — as a notice, not an essay: `crosstalk_send` one short precise sentence addressed by",
    "session id or name and continue elsewhere; replies are injected into live turns (`crosstalk_inbox` to catch up).",
    "Never force a claim. Lease what you are editing now with `crosstalk_claim` (it refuses if another session already",
    "holds it), renew if the work runs long, release when done. Only sessions in this project are reachable — peers",
    "marked not addressable cannot receive mail.",
    `Right now ${peers} other session${peers === 1 ? " is" : "s are"} on this channel` +
      (claims > 0 ? ` and ${claims} file${claims === 1 ? " is" : "s are"} already leased.` : "."),
  ].join(" ")
}

/** The session id an event is about, when it carries one. */
function eventSessionID(event: { data?: Readonly<Record<string, unknown>> }): string | undefined {
  const value = event.data?.sessionID
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** The bundled Personas pool; empty when the art is missing or unreadable. */
function loadAvatars(): AvatarEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(new URL("../assets/avatars/manifest.json", import.meta.url), "utf8")) as {
      entries?: AvatarEntry[]
    }
    return Array.isArray(parsed.entries) ? parsed.entries : []
  } catch {
    return []
  }
}

/**
 * Which setup instance owns each location. `globalThis` rather than a module
 * variable because the same plugin can be installed twice (a global link plus
 * a config path to the same checkout), and two loads can get two module
 * instances while sharing one process — the location guard must still see the
 * whole truth.
 */
interface CrosstalkGuard {
  owners: Map<string, symbol>
}

function crosstalkGuard(): CrosstalkGuard {
  const holder = globalThis as { __crosstalk?: CrosstalkGuard }
  holder.__crosstalk ??= { owners: new Map() }
  return holder.__crosstalk
}

export default Plugin.define({
  id,
  async setup(ctx) {
    const { options, warnings } = parseOptions(ctx.options)
    for (const warning of warnings) console.warn(`[crosstalk] ${warning}`)

    const projectID = ctx.location.project?.id
    const directory = ctx.location.directory

    // One live instance per location. The same plugin can be installed twice
    // (a global link plus a config path) and the host will happily load both;
    // two meshes would serve tools and RPC from split state while clobbering
    // one snapshot key. The first load owns the location, later ones stay
    // inert and say so.
    const place = directory ?? "__unknown__"
    const guard = crosstalkGuard()
    if (guard.owners.has(place)) {
      console.warn(
        `[crosstalk] ${id} is already loaded for ${place}; this copy registers nothing. Load the plugin from exactly one location.`,
      )
      return async () => {}
    }
    const ownerToken = Symbol(place)
    guard.owners.set(place, ownerToken)

    const mesh = new Mesh({
      options: {
        scope: options.scope,
        staleAfterMs: options.staleAfterMs,
        evictAfterMs: options.evictAfterMs,
        maxMessages: options.maxMessages,
        messageTtlMs: options.messageTtlMs,
        claimTtlMs: options.claimTtlMs,
        maxWaitMs: options.maxWaitMs,
        pollMs: options.pollMs,
      },
      clock: systemClock,
      deliverer: createSessionDeliverer(toSessionLike(ctx.session)),
      defaults: { ...(projectID ? { projectID } : {}), ...(directory ? { directory } : {}) },
      avatars: loadAvatars(),
    })

    // `ctx.storage` is JSON-typed; snapshots are plain JSON by construction,
    // and a round trip guarantees nothing unserializable reaches it.
    const storage: StorageLike = {
      get: (key) => ctx.storage.get(key),
      set: (key, value) => ctx.storage.set(key, JSON.parse(JSON.stringify(value))),
      remove: (key) => ctx.storage.remove(key),
      scan: async (query) => {
        const page = await ctx.storage.scan({ prefix: query.prefix, after: query.after, limit: query.limit })
        return { entries: page.entries, next: page.next }
      },
    }
    const store = options.persist ? new MeshStore(storage, { key: options.storageKey }) : undefined
    if (store) {
      const snapshot = await store.load(projectID)
      if (snapshot) mesh.restore(snapshot)
    }
    // Sessions that declared a task before the portrait feature existed (or
    // whose snapshot predates it) get one now — the only place a portrait is
    // assigned outside `declare`.
    mesh.assignPortraits()

    // Persist after quiet periods: the event stream is chatty and a write per
    // event would hammer storage for state that is identical.
    let persistTimer: ReturnType<typeof setTimeout> | undefined
    const schedulePersist = () => {
      if (!store || persistTimer) return
      persistTimer = setTimeout(() => {
        persistTimer = undefined
        void store.save(mesh.snapshot(), projectID).catch((error) => {
          console.warn(`[crosstalk] could not persist mesh state: ${String(error)}`)
        })
      }, PERSIST_DEBOUNCE_MS)
      persistTimer.unref?.()
    }

    const controller = new AbortController()

    // A session that started before the plugin loaded never emits
    // `session.created` at us, so its record would stay without a project and
    // be unaddressable under strict scope. Heal each such record once by
    // reading it from the host.
    const enrichAttempted = new Set<string>()
    const enrichSession = async (sessionID: string) => {
      try {
        const info = await ctx.session.get({ sessionID: sessionID as never })
        if (controller.signal.aborted) return
        mesh.registry.update(sessionID, {
          projectID: info.projectID,
          directory: info.location?.directory,
          title: info.title,
          agent: info.agent,
          parentID: info.parentID,
          created: info.time?.created,
        })
        schedulePersist()
        scheduleRpc()
      } catch {
        // A session owned by another location may not be readable; leave it.
      }
    }

    const streaming = pumpEvents(ctx.event, controller.signal, {
      onEvent: (event) => {
        mesh.applyEvent(event)
        schedulePersist()
        const sessionID = eventSessionID(event)
        if (
          sessionID !== undefined &&
          mesh.registry.get(sessionID)?.projectID === undefined &&
          !enrichAttempted.has(sessionID)
        ) {
          enrichAttempted.add(sessionID)
          void enrichSession(sessionID)
        }
      },
      onError: (error) => {
        console.warn(`[crosstalk] event stream: ${String(error)}`)
      },
    })

    // Declarations are rare but precious: snapshot them like event traffic
    // instead of waiting for the next event to happen by.
    const unsubscribePersist = mesh.subscribe(schedulePersist)

    const toolRegistration = await ctx.tool.transform((editor) => {
      registerTools(editor, { mesh, options })
    })

    const briefingRegistration = options.announce
      ? await ctx.session.hook("context", (event) => {
          const peers = mesh.peers(event.sessionID).length
          const claims = mesh.claims.list({ includeExpired: false }).length
          if (peers === 0 && claims === 0) return
          event.system.push({ type: "text", text: briefing(peers, claims) })
        })
      : undefined

    // The TUI plugin reads this directory over RPC. Pushes are debounced so a
    // chatty event stream does not become a chatty channel.
    const rpcRegistration = await ctx.rpc.register(CrosstalkRpc, {
      directory: async () => directoryPayload(mesh),
    })
    let rpcTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRpc = () => {
      if (rpcTimer) return
      rpcTimer = setTimeout(() => {
        rpcTimer = undefined
        void rpcRegistration.events.emit("changed", directoryPayload(mesh)).catch((error) => {
          console.warn(`[crosstalk] could not emit directory update: ${String(error)}`)
        })
      }, RPC_DEBOUNCE_MS)
      rpcTimer.unref?.()
    }
    const unsubscribeRpc = mesh.subscribe(scheduleRpc)

    return async () => {
      if (guard.owners.get(place) === ownerToken) guard.owners.delete(place)
      controller.abort()
      await streaming
      unsubscribeRpc()
      unsubscribePersist()
      if (rpcTimer) clearTimeout(rpcTimer)
      await briefingRegistration?.dispose()
      await rpcRegistration.dispose()
      await toolRegistration.dispose()
      if (persistTimer) clearTimeout(persistTimer)
      if (store) {
        await store.save(mesh.snapshot(), projectID).catch(() => {})
      }
    }
  },
})

export { parseOptions, DEFAULTS } from "./config.ts"
export { Mesh } from "./core/mesh.ts"
export { MeshStore } from "./storage.ts"
export { pumpEvents, asCrosstalkEvent } from "./events.ts"
export { createSessionDeliverer, renderDelivery } from "./deliverer.ts"
export { registerTools, toolFactories, NAMESPACE_DESCRIPTION } from "./tools/index.ts"
export type * from "./types.ts"
