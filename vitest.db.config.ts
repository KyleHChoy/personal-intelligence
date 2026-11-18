import { defineConfig } from "vitest/config";

// Tests that need Postgres, named *.db.test.ts. They need only the local server (pnpm db:up),
// whose start-up script makes the migrator role; the schema uses no extension. Each test
// makes the rest itself: the store's roles, a template database migrated once per run, and a
// copy of it for each test, dropped when the test ends (packages/store/src/test-support/database.ts).
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.db.test.ts", "apps/*/src/**/*.db.test.ts"],
    // One file at a time when VITEST_MAX_WORKERS is unset: the machine carries only a few
    // database-backed runs. Vitest sets its workers from that variable after this
    // option, so a run that exports it runs that many files at once.
    fileParallelism: false,
    // Tests of this system's own apps and packages treat each example.org subdomain as its own
    // organization, where production folds them into one (tests/setup.ts says why).
    setupFiles: ["tests/setup.ts"],
  },
});
