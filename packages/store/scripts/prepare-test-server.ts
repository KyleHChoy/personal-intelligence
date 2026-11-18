// node packages/store/scripts/prepare-test-server.ts
// Makes what every database test is copied from, on the local server of `pnpm db:up`, when it is
// missing: the roles, and a template database every migration file was applied to. Prints the
// template's name; a failure ends the process with its error. The tests make the same on first
// use; a run of many test files runs this first, so a migration that fails is reported once, as that.
import { prepareTestServer } from "../src/test-support/database.ts";

process.stdout.write(`${await prepareTestServer()}\n`);
