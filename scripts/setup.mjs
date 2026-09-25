#!/usr/bin/env node
/**
 * @fileoverview Global installer for opencode-crosstalk.
 *
 * OpenCode discovers "immediate plugin package directories" under every
 * `plugins/` directory it finds, and it honours more than one global root —
 * `~/.opencode/plugins/` and `<config>/plugins/`
 * (`opencode debug paths config`) were both verified to load on this machine.
 * We target `~/.opencode/plugins/` because that is the requested location, and
 * deliberately install to exactly one root: linking both would load the plugin
 * twice per location.
 *
 * Symlinking this checkout there activates the plugin for every project and
 * workspace with no config edit and no build step. The host resolves the linked
 * directory through its root `index.ts` (a thin re-export of `src/index.ts`), so
 * edits still take effect on reload.
 *
 *   node scripts/setup.mjs            install (default)
 *   node scripts/setup.mjs uninstall  remove the link
 *
 * `CROSSTALK_PLUGINS_DIR` overrides the resolved plugins directory.
 */

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const PLUGIN_ID = "opencode.crosstalk"
const LINK_NAME = "crosstalk"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const mode = process.argv[2] === "uninstall" ? "uninstall" : "install"
const say = (line = "") => console.log(line)

/** The global `plugins/` directory the link goes in. */
function resolvePluginsDir() {
  const override = process.env.CROSSTALK_PLUGINS_DIR
  if (override) return { dir: resolve(override), source: "CROSSTALK_PLUGINS_DIR" }
  return { dir: join(homedir(), ".opencode", "plugins"), source: "default" }
}

const { dir: pluginsDir, source } = resolvePluginsDir()
const linkPath = join(pluginsDir, LINK_NAME)

/** True when `path` is a symlink pointing exactly at `target`. */
async function linksTo(path, target) {
  const stats = await lstat(path).catch(() => undefined)
  if (!stats?.isSymbolicLink()) return false
  const current = await readlink(path)
  return isAbsolute(current) ? current === target : resolve(dirname(path), current) === target
}

/** Best guess at the global config file. Only used for the advice text. */
function configFile() {
  try {
    const out = execFileSync("opencode", ["debug", "paths", "config"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (out) return out.endsWith(".json") || out.endsWith(".jsonc") ? out : join(out, "opencode.jsonc")
  } catch {
    // opencode is not on PATH; fall through to the documented default.
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(base, "opencode", "opencode.jsonc")
}

async function ensureDependencies() {
  if (existsSync(join(root, "node_modules", "@opencode", "plugin"))) return
  say("→ installing dependencies")
  execFileSync("npm", ["install"], { cwd: root, stdio: "inherit" })
}

async function install() {
  // A plugin directory without a root entrypoint is ignored by the host
  // without an error, so refuse to install one.
  const entrypoint = ["index.ts", "index.js"].map((name) => join(root, name)).find((path) => existsSync(path))
  if (!entrypoint) {
    say(`✗ no index.ts/index.js entrypoint in ${root} — the host silently ignores plugin directories without one.`)
    process.exitCode = 1
    return false
  }
  await ensureDependencies()
  await mkdir(pluginsDir, { recursive: true })

  if (await linksTo(linkPath, root)) {
    say(`✓ already linked → ${linkPath}`)
    return true
  }

  const existing = await lstat(linkPath).catch(() => undefined)
  if (existing) {
    // Never clobber something we did not create.
    if (existing.isDirectory() && !existing.isSymbolicLink()) {
      say(`✗ ${linkPath} already exists and is a real directory — leaving it alone.`)
      say("  Move it aside, or add the plugin by path instead:")
      say(`    "plugins": [${JSON.stringify(root)}]   // in ${configFile()}`)
      process.exitCode = 1
      return false
    }
    say(`→ replacing existing link at ${linkPath}`)
    await rm(linkPath, { recursive: true, force: true })
  }

  try {
    await symlink(root, linkPath, "dir")
  } catch (error) {
    say(`✗ could not create a symlink: ${String(error)}`)
    say("  Symlinks need developer mode on Windows. Either enable it, or add the plugin by path:")
    say(`    "plugins": [${JSON.stringify(root)}]   // in ${configFile()}`)
    process.exitCode = 1
    return false
  }

  say(`✓ linked ${linkPath} → ${root}`)
  return true
}

async function uninstall() {
  if (!(await linksTo(linkPath, root))) {
    const existing = await lstat(linkPath).catch(() => undefined)
    if (!existing) {
      say(`· nothing installed at ${linkPath}`)
      return
    }
    if (existing.isDirectory() && !existing.isSymbolicLink()) {
      say(`✗ ${linkPath} is a real directory, not our link — leaving it alone.`)
      process.exitCode = 1
      return
    }
  }
  await rm(linkPath, { recursive: true, force: true })
  say(`✓ removed ${linkPath}`)
}

say(`opencode-crosstalk ${mode} · plugins dir: ${pluginsDir} (${source})`)
if (mode === "uninstall") {
  await uninstall()
} else if (await install()) {
  say()
  say(`Plugin id: ${PLUGIN_ID}  (disable with "plugins": ["-${PLUGIN_ID}"])`)
  say(`Verify:     opencode plugin list`)
  say(`Reload:     opencode service restart   # or just wait for config auto-reload`)
  say()
  say("The six crosstalk tools are allowed by the default `*` policy, so nothing else is")
  say("required. To lock coordination down (or scope it to specific resources), add to")
  say(`${configFile()}:`)
  say('  "permissions": [{ "action": "crosstalk", "resource": "*", "effect": "deny" }]')
}
