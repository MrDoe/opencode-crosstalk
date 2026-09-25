/**
 * @fileoverview Host directory entrypoint.
 *
 * OpenCode resolves a plugin directory through a root `index.ts`/`index.js`
 * file — it does not read `package.json` `main`/`exports` for plugin
 * directories. `src/index.ts` remains the real entry; installed directories
 * (the `npm run setup` symlink, or a copy under `.opencode/plugins/`) reach it
 * through this re-export.
 */

export { default } from "./src/index.ts"
