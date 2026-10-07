import assert from "node:assert/strict"
import { test } from "node:test"
import { MeshStore } from "../src/storage.ts"
import { SNAPSHOT_VERSION } from "../src/core/mesh.ts"
import type { MeshSnapshot } from "../src/types.ts"
import { createFakeStorage } from "./helpers/fakes.ts"

function snapshot(overrides: Partial<MeshSnapshot> = {}): MeshSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    savedAt: 1_700_000_000_000,
    peers: [{ sessionID: "ses_a", status: "running", lastSeen: 1_700_000_000_000, title: "one" }],
    claims: [{ key: "/repo/a.ts", raw: "a.ts", holder: "ses_a", acquired: 1, expires: 2 }],
    ...overrides,
  }
}

test("keys are namespaced per project", () => {
  const store = new MeshStore(createFakeStorage(), { key: "crosstalk" })
  assert.equal(store.keyFor("proj-1"), "crosstalk/proj-1")
  assert.equal(store.keyFor(undefined), "crosstalk/global")
  assert.equal(new MeshStore(createFakeStorage(), { key: "mesh" }).keyFor("p"), "mesh/p")
})

test("save then load round-trips the snapshot", async () => {
  const storage = createFakeStorage()
  const store = new MeshStore(storage, { key: "crosstalk" })
  const original = snapshot()

  await store.save(original, "proj-1")
  assert.ok(storage.data.has("crosstalk/proj-1"))

  const loaded = await store.load("proj-1")
  assert.deepEqual(loaded, original)
})

test("projects are isolated from one another", async () => {
  const store = new MeshStore(createFakeStorage(), { key: "crosstalk" })
  await store.save(snapshot({ peers: [] }), "proj-1")
  await store.save(snapshot({ peers: [{ sessionID: "ses_b", status: "idle", lastSeen: 5 }] }), "proj-2")

  assert.deepEqual((await store.load("proj-1"))?.peers, [])
  assert.equal((await store.load("proj-2"))?.peers.length, 1)
})

test("load tolerates a missing key", async () => {
  const store = new MeshStore(createFakeStorage(), { key: "crosstalk" })
  assert.equal(await store.load("proj-1"), undefined)
})

test("load tolerates a storage read failure", async () => {
  const storage = createFakeStorage()
  storage.failNextGet()
  const store = new MeshStore(storage, { key: "crosstalk" })
  assert.equal(await store.load("proj-1"), undefined)
})

test("load rejects payloads that are not snapshots", async () => {
  for (const bad of [
    null,
    42,
    "text",
    [],
    { version: SNAPSHOT_VERSION },
    { version: SNAPSHOT_VERSION, peers: [], claims: [] },
  ]) {
    const store = new MeshStore(createFakeStorage({ "crosstalk/proj-1": bad }), { key: "crosstalk" })
    assert.equal(await store.load("proj-1"), undefined, `payload ${JSON.stringify(bad)} must be rejected`)
  }
})

test("load rejects a snapshot from another version", async () => {
  const store = new MeshStore(createFakeStorage({ "crosstalk/proj-1": snapshot({ version: 99 }) }), {
    key: "crosstalk",
  })
  assert.equal(await store.load("proj-1"), undefined)
})

test("load drops individual malformed entries but keeps the snapshot", async () => {
  const store = new MeshStore(
    createFakeStorage({
      "crosstalk/proj-1": {
        version: SNAPSHOT_VERSION,
        savedAt: 7,
        peers: [{ sessionID: "ses_a" }, "garbage", null],
        claims: [{ key: "/a" }, 5],
      },
    }),
    { key: "crosstalk" },
  )
  const loaded = await store.load("proj-1")
  assert.equal(loaded?.peers.length, 1)
  assert.equal(loaded?.claims.length, 1)
  assert.equal(loaded?.savedAt, 7)
})

test("remove deletes the key and tolerates a missing one", async () => {
  const storage = createFakeStorage()
  const store = new MeshStore(storage, { key: "crosstalk" })
  await store.save(snapshot(), "proj-1")
  await store.remove("proj-1")
  assert.equal(storage.data.has("crosstalk/proj-1"), false)
  await assert.doesNotReject(() => store.remove("proj-1"))
})

test("listProjectKeys enumerates stored projects", async () => {
  const store = new MeshStore(createFakeStorage(), { key: "crosstalk" })
  await store.save(snapshot(), "proj-1")
  await store.save(snapshot(), "proj-2")
  await store.save(snapshot())
  assert.deepEqual((await store.listProjectKeys()).sort(), ["global", "proj-1", "proj-2"])
})

test("listProjectKeys returns nothing when the scan fails", async () => {
  const storage = createFakeStorage()
  storage.scan = async () => {
    throw new Error("scan unavailable")
  }
  assert.deepEqual(await new MeshStore(storage, { key: "crosstalk" }).listProjectKeys(), [])
})
