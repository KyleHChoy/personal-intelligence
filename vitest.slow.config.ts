import { defineConfig } from "vitest/config";

// Database tests too slow for every change, named *.db.slow-test.ts: neither vitest.config.ts
// (*.test.ts) nor vitest.db.config.ts (*.db.test.ts) picks them up. Run them with
// pnpm test:db:slow after a change to SQL, a migration or a reader query.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.db.slow-test.ts", "apps/*/src/**/*.db.slow-test.ts"],
    // One file at a time: a file adds thousands of hidden rows per labelled table to a world,
    // measures its statements' buffers and plans, and runs its own work at once inside.
    fileParallelism: false,
    setupFiles: ["tests/setup.ts"],
  },
});
