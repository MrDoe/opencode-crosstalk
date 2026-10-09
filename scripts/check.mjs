#!/usr/bin/env node
/**
 * @fileoverview Gate runner for opencode-crosstalk.
 *
 * Runs typecheck and the test suite independently: unlike `A && B`, a red
 * typecheck never hides the test results, and a red suite never hides a green
 * typecheck. Both steps always run with their output inherited; the process
 * exits non-zero when either step failed, naming both exit codes.
 *
 * Plain JS, deliberately outside `tsconfig.json`'s `include`, so it is not
 * typechecked — same as `scripts/setup.mjs`.
 *
 *   node scripts/check.mjs   run the whole gate
 */

import { spawnSync } from "node:child_process"

const run = (cmd) => spawnSync(cmd, { stdio: "inherit", shell: true }).status ?? 1

const typecheck = run("npm run typecheck")
const tests = run("npm run test")

if (typecheck !== 0 || tests !== 0) {
  console.error(`check failed: typecheck exit ${typecheck}, test exit ${tests}`)
}
process.exit(typecheck !== 0 || tests !== 0 ? 1 : 0)
