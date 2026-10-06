/**
 * @fileoverview Host entrypoint for the CLI (TUI) plugin.
 *
 * The host discovers a TUI entrypoint beside the server entrypoint (`index.ts`),
 * so this file only re-exports the implementation.
 */

export { default } from "./src/tui/index.tsx"
