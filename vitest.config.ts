import { defineConfig } from "vitest/config";

// Unit and structural tests. These must always pass, and they need no database:
// a test that needs Postgres is named *.db.test.ts and runs under vitest.db.config.ts.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tests/structure/**/*.test.ts", "tools/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.db.test.ts"],
    // Tests of this system's own apps and packages treat each example.org subdomain as its own
    // organization, where production folds them into one (tests/setup.ts says why).
    setupFiles: ["tests/setup.ts"],
  },
});
