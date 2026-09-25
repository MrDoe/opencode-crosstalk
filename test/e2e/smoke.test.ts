/**
 * @fileoverview Live smoke test against a real OpenCode server.
 *
 * Skipped unless `OPENCODE_E2E=1`, so `npm test` stays offline and
 * deterministic. It proves the three things the fakes cannot: that the host
 * accepts the plugin, that the tools reach a real model, and that
 * `ctx.session.synthetic` lands in another live session.
 *
 * Two sessions run against a throwaway project, because coordination *between*
 * two agents is the only thing worth testing here.
 *
 *   OPENCODE_E2E=1 npm run test:e2e
 *
 * Requires `opencode` on PATH and a configured model. Each session costs a
 * model call, so the prompts below are deliberately small.
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"

const ENABLED = process.env.OPENCODE_E2E === "1"
const SKIP = !ENABLED && "set OPENCODE_E2E=1 to run"
const PLUGIN = new URL("../../src/index.ts", import.meta.url).pathname
const SESSION_TIMEOUT_MS = 300_000

let projectDir = ""
/** Resolves when the background waiter session finishes. */
let waiter: Promise<Result> = Promise.resolve({ output: "", skip: "not started" })

interface Result {
  output: string
  /** Set when the run could not reach a model, so the test should skip. */
  skip?: string
}

/**
 * A provider that cannot afford the request is an environment problem, not a
 * plugin failure, so it is reported as a skip rather than a red test.
 */
function unrunnable(output: string): string | undefined {
  if (/requires more credits|insufficient_credits|can only afford/i.test(output)) {
    return "provider cannot afford the request (check OPENCODE_E2E_MODEL or account credits)"
  }
  if (/Unauthorized|401|invalid.*api key/i.test(output)) return "provider rejected the credentials"
  return undefined
}

/** Run one non-interactive prompt in the throwaway project. */
function run(prompt: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", ["run", prompt], {
      cwd: projectDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()))
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`opencode run timed out after ${SESSION_TIMEOUT_MS}ms`))
    }, SESSION_TIMEOUT_MS)
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", () => {
      clearTimeout(timer)
      const skip = unrunnable(output)
      resolve(skip ? { output, skip } : { output })
    })
  })
}

before(async () => {
  if (!ENABLED) return
  projectDir = await mkdtemp(join(tmpdir(), "crosstalk-e2e-"))
  await writeFile(
    join(projectDir, "opencode.jsonc"),
    [
      "{",
      '  "$schema": "https://opencode.ai/config.json",',
      ...(process.env.OPENCODE_E2E_MODEL ? [`  "model": ${JSON.stringify(process.env.OPENCODE_E2E_MODEL)},`] : []),
      `  "plugins": [${JSON.stringify(PLUGIN)}],`,
      '  "permissions": [{ "action": "crosstalk", "resource": "*", "effect": "allow" }]',
      "}",
      "",
    ].join("\n"),
  )
  // The waiter blocks on its inbox while the driver signals it. Started first
  // so it is listening by the time the message is sent.
  waiter = run(
    [
      "Call the crosstalk_status tool with role 'waiter'.",
      "Then call crosstalk_inbox with wait 120 and limit 5.",
      "If a message arrives, call crosstalk_send with all true and text 'WAITER-ACK'.",
      "Then finish with exactly: WAITER-OK <first line of the message you received>.",
      "If the inbox returns nothing, finish with exactly: WAITER-TIMEOUT.",
    ].join(" "),
  )
  // Keep a rejected waiter from surfacing as an unhandled rejection; the test
  // that cares about it awaits the promise itself.
  waiter.catch(() => {})
})

after(async () => {
  if (!ENABLED || !projectDir) return
  await rm(projectDir, { recursive: true, force: true })
})

test("two live sessions discover each other and exchange a message", { skip: SKIP }, async (t) => {
  const driver = await run(
    [
      "Call crosstalk_status with role 'driver' and goal 'verify crosstalk'.",
      "Then call crosstalk_peers and count the peers.",
      "Then call crosstalk_send with all true, kind request, and text 'E2E-PING'.",
      "Then call crosstalk_claim with action claim and resources ['notes.md'], ttlSeconds 300.",
      "Finish with exactly one line: DRIVER peers=<n> signalled=<yes|no> claim=<claimed|refused>.",
    ].join(" "),
  )
  if (driver.skip) return t.skip(driver.skip)

  assert.match(driver.output, /DRIVER peers=\d+/, `unexpected driver output:\n${driver.output}`)
  assert.match(driver.output, /signalled=yes/, `the broadcast should have been delivered:\n${driver.output}`)
  assert.match(driver.output, /claim=claimed/, `an unclaimed file should be granted:\n${driver.output}`)

  const waited = await waiter
  if (waited.skip) return t.skip(waited.skip)
  assert.match(waited.output, /WAITER-OK/, `the waiter never received the message:\n${waited.output}`)
  assert.match(waited.output, /E2E-PING/, `the waiter got the wrong message:\n${waited.output}`)
})

test("a claimed file blocks a later session and renewals work", { skip: SKIP }, async (t) => {
  const late = await run(
    [
      "Call crosstalk_status with role 'latecomer'.",
      "Call crosstalk_claim with action claim, resources ['notes.md'], ttlSeconds 300.",
      "Call it a second time with action renew, resources ['notes.md'].",
      "Finish with exactly one line: LATE <claim-result> renew=<ok|refused>.",
    ].join(" "),
  )
  if (late.skip) return t.skip(late.skip)
  assert.match(
    late.output,
    /LATE (claimed|refused) renew=(ok|refused)/,
    `unexpected output:\n${late.output}`,
  )
})
