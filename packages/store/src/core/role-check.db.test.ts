import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "@intelligence/personal-core";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { asClient as as } from "../test-support/connections.ts";
import { ensureRoles } from "./roles.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// pi-migrate's check of the server's roles (deploy/lib/role-check.sql), run as the box
// runs it, after ensureRoles, on roles of this test's own under a random prefix. The bootstrap is
// one of its own too, made by the migrator, so the roles it made are this run's alone, as on the
// box, where the bootstrap makes nothing but the migration's roles.

const PORT = Number(process.env.INTELLIGENCE_PG_PORT ?? 54329);
const urlAs = (user: string, database: string): string => `postgres://${user}:local-only@127.0.0.1:${PORT}/${database}`;
const PASSWORDS = {
  admin: "local-only",
  writer: "local-only",
  reader: "local-only",
  pipeline: "local-only",
  work: "local-only",
  restricted: "local-only",
};
const NAMES = ["admin", "writer", "reader", "pipeline", "work", "restricted", "proxy", "notify", "owner"];
const CHECK = readFile(join(repoRoot(), "deploy/lib/role-check.sql"), "utf8");

// A bootstrap of its own, made as pi-db-init makes the box's (CREATEROLE, no CREATEDB), with a
// database made for the run that any role connects to; ensureRoles as it; then, as pi-migrate does
// before the check, its login taken away. fn gets the prefix, a statement runner as the bootstrap
// (which logs in again for it) and one as the migrator; everything is dropped after.
async function withRoles(
  fn: (
    prefix: string,
    asBootstrap: (sql: string) => Promise<void>,
    asMigrator: (sql: string) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const prefix = `prc${randomBytes(3).toString("hex")}_`;
  const bootstrap = `${prefix}bootstrap`;
  const database = `${prefix}db`;
  const migrator = urlAs("migrator", "postgres");
  const asMigrator = (sql: string) => as(migrator, async (client) => void (await client.query(sql)));
  const asBootstrap = async (sql: string) => {
    await asMigrator(`alter role ${pg.escapeIdentifier(bootstrap)} login`);
    try {
      await as(urlAs(bootstrap, database), async (client) => void (await client.query(sql)));
    } finally {
      await asMigrator(`alter role ${pg.escapeIdentifier(bootstrap)} nologin`);
    }
  };
  await asMigrator(`create role ${pg.escapeIdentifier(bootstrap)} login createrole nocreatedb password 'local-only'`);
  await asMigrator(`create database ${pg.escapeIdentifier(database)} template template0`);
  try {
    await ensureRoles(urlAs(bootstrap, database), PASSWORDS, { prefix, database });
    await asMigrator(`alter role ${pg.escapeIdentifier(bootstrap)} nologin`);
    await fn(prefix, asBootstrap, asMigrator);
  } finally {
    await asMigrator(`alter role ${pg.escapeIdentifier(bootstrap)} login`);
    await as(urlAs(bootstrap, database), async (client) => {
      for (const name of [...NAMES, "other"])
        await client.query(`drop role if exists ${pg.escapeIdentifier(`${prefix}${name}`)}`);
    });
    await asMigrator(`drop database if exists ${pg.escapeIdentifier(database)} with (force)`);
    await asMigrator(`drop role if exists ${pg.escapeIdentifier(bootstrap)}`);
  }
}

// The check's count for the run's roles, as root runs it: the two settings, then the file's text.
const unexpected = (prefix: string): Promise<number> =>
  as(urlAs("migrator", "postgres"), async (client) => {
    await client.query("select set_config('pi.role_prefix', $1, false), set_config('pi.role_bootstrap', $2, false)", [
      prefix,
      `${prefix}bootstrap`,
    ]);
    const { rows } = await client.query<{ count: string }>(await CHECK);
    return Number(rows[0]?.count);
  });

describe("pi-migrate's role check", () => {
  it("finds nothing unexpected in what ensureRoles makes, whatever other roles the server has", async () => {
    await withRoles(async (prefix, _asBootstrap, asMigrator) => {
      // A role another maker made, beside the run's: not the bootstrap's, so not the check's.
      await asMigrator(`create role ${pg.escapeIdentifier(`${prefix}other`)} login`);
      try {
        expect(await unexpected(prefix)).toBe(0);
      } finally {
        await asMigrator(`drop role ${pg.escapeIdentifier(`${prefix}other`)}`);
      }
    });
  });

  // Each change the bootstrap could make while pi held its password, undone after.
  const CHANGES: { what: string; make: (p: string) => string; undo: (p: string) => string }[] = [
    {
      what: "a login role made beside the migration's",
      make: (p) => `create role ${p}other login`,
      undo: (p) => `drop role ${p}other`,
    },
    {
      what: "a role made beside the migration's that cannot log in",
      make: (p) => `create role ${p}other nologin`,
      undo: (p) => `drop role ${p}other`,
    },
    {
      what: "another role holding the owner",
      make: (p) => `grant ${p}owner to ${p}writer`,
      undo: (p) => `revoke ${p}owner from ${p}writer`,
    },
    {
      what: "a login role holding the send role",
      make: (p) => `grant ${p}proxy to ${p}admin`,
      undo: (p) => `revoke ${p}proxy from ${p}admin`,
    },
    {
      what: "a login role able to make roles",
      make: (p) => `alter role ${p}admin createrole`,
      undo: (p) => `alter role ${p}admin nocreaterole`,
    },
    {
      what: "the owner able to log in",
      make: (p) => `alter role ${p}owner login`,
      undo: (p) => `alter role ${p}owner nologin`,
    },
    {
      what: "a login role gone",
      make: (p) => `drop role ${p}notify`,
      undo: (p) => `create role ${p}notify login nosuperuser nobypassrls nocreatedb nocreaterole noreplication`,
    },
  ];

  it("counts each change the bootstrap could make, and nothing once it is undone", async () => {
    await withRoles(async (prefix, asBootstrap) => {
      for (const change of CHANGES) {
        await asBootstrap(change.make(prefix));
        expect({ what: change.what, found: (await unexpected(prefix)) > 0 }).toEqual({
          what: change.what,
          found: true,
        });
        await asBootstrap(change.undo(prefix));
        expect({ what: change.what, after: await unexpected(prefix) }).toEqual({ what: change.what, after: 0 });
      }
    });
  });

  it("counts a bootstrap that can still log in", async () => {
    await withRoles(async (prefix, _asBootstrap, asMigrator) => {
      await asMigrator(`alter role ${pg.escapeIdentifier(`${prefix}bootstrap`)} login`);
      expect(await unexpected(prefix)).toBeGreaterThan(0);
      await asMigrator(`alter role ${pg.escapeIdentifier(`${prefix}bootstrap`)} nologin`);
    });
  });
});
