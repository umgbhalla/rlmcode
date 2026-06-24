// Vitest runs its worker pool under Node (Bun's runtime can't host vitest's thread pool),
// but src/core/tools.ts does `import { $ } from "bun"` for the bash tool. None of the ported
// unit suites invoke the bash tool — they only transitively import tools.ts — so this shim
// satisfies the `bun` builtin import under Node. `$` throws if ever actually called, so a test
// that DID try to shell out would fail loudly rather than silently no-op.
// ponytail: a minimal `$` stand-in for the Node test runner. Upgrade: drop this if the bash
// tool's shell dependency moves behind a runtime-agnostic seam (e.g. an injected exec service).

const notInNode = (): never => {
  throw new Error("bun `$` is not available under the Node vitest runner (tests must not shell out)")
}

export const $: (...args: Array<unknown>) => unknown = notInNode
