import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Vitest config for the headless hermetic Effect unit suite (test/*.test.ts), the
// @effect/vitest port of the hand-rolled `bun scripts/*.test.ts` `assert()` loops.
// SEPARATE from the PTY frame gate (scripts/tui/*.test.ts → `bun run test:tui`).
//
// Thread pool scaled to this M4 Max (16 cores / 12 perf, 64GB): a worker-thread pool
// (faster than forks for these CPU-light Effect units) capped at ~12 workers to ride the
// perf cores, floored at 4 so a cold run still parallelizes. The suites are hermetic (no
// network, no shared module state across files), so parallel threads are safe.
// (Vitest 4 flattened poolOptions.threads.{max,min}Threads → top-level max/minWorkers.)
export default defineConfig({
  resolve: {
    alias: {
      // src/core/tools.ts imports `$` from bun's builtin; vitest's pool runs under Node, where
      // that builtin is absent. Alias it to a throwing shim — the unit suites only transitively
      // import tools.ts, they never shell out. (test:tui still runs the REAL bash under bun.)
      bun: fileURLToPath(new URL("./test/bun-shim.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    pool: "threads",
    maxWorkers: 12,
    minWorkers: 4,
  },
})
