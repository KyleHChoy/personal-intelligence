// The ceilings a database test file gives its tests and hooks. A ceiling bounds a hung test, not a
// slow one: a file that needs more keeps its own, with a comment saying why. They are set for a
// shared machine under heavy load, so a gate is not red from load alone.

export const DB_TEST_TIMEOUT = 120_000;
// A file that builds a large world, or migrates a populated database, before its tests.
export const SLOW_DB_TEST_TIMEOUT = 600_000;
