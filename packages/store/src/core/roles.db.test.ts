import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureRoles } from "./roles.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const BOOTSTRAP = `postgres://migrator:local-only@127.0.0.1:${Number(process.env.INTELLIGENCE_PG_PORT ?? 54329)}/postgres`;
const PASSWORDS = {
  admin: "local-only",
  writer: "local-only",
  reader: "local-only",
  pipeline: "local-only",
  work: "local-only",
  restricted: "local-only",
};
const NAMES = ["owner", "admin", "writer", "reader", "pipeline", "work", "proxy", "restricted", "notify"];

async function asBootstrap<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: BOOTSTRAP });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Runs fn with a fresh prefix, and drops whatever roles it left: the eight, and one more a test may make.
async function withPrefix(fn: (prefix: string, roles: string[]) => Promise<void>): Promise<void> {
  const prefix = `pit${randomBytes(3).toString("hex")}_`;
  const roles = NAMES.map((name) => `${prefix}${name}`);
  try {
    await fn(prefix, roles);
  } finally {
    await asBootstrap(async (client) => {
      for (const role of [...roles, `${prefix}other`])
        await client.query(`drop role if exists ${pg.escapeIdentifier(role)}`);
    });
  }
}

// Logs in as role with password to a database made for the call, and answers the role or the
// SQLSTATE of the refusal. A database made here lets any role connect.
async function loginWith(database: string, role: string, password: string): Promise<string> {
  await asBootstrap((client) => client.query(`create database ${pg.escapeIdentifier(database)} template template0`));
  const client = new pg.Client({
    host: "127.0.0.1",
    port: Number(process.env.INTELLIGENCE_PG_PORT ?? 54329),
    database,
    user: role,
    password,
  });
  try {
    await client.connect();
    return (await client.query("select current_user as role")).rows[0].role as string;
  } catch (error) {
    return `SQLSTATE ${(error as { code?: string }).code}`;
  } finally {
    await client.end().catch(() => {});
    await asBootstrap((bootstrap) =>
      bootstrap.query(`drop database if exists ${pg.escapeIdentifier(database)} with (force)`),
    );
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

const attributes = (roles: string[]) =>
  asBootstrap(async (client) => {
    const { rows } = await client.query(
      `select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
       from pg_roles where rolname = any($1) order by rolname`,
      [roles],
    );
    return rows;
  });

const listed = (prefix: string) =>
  ["admin", "notify", "owner", "pipeline", "proxy", "reader", "restricted", "work", "writer"].map((name) => ({
    rolname: `${prefix}${name}`,
    rolcanlogin: name !== "owner",
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
  }));

describe("ensureRoles", () => {
  it("two ensureRoles at once both succeed", async () => {
    await withPrefix(async (prefix, roles) => {
      expect(await attributes(roles)).toEqual([]);

      await Promise.all([ensureRoles(BOOTSTRAP, PASSWORDS, { prefix }), ensureRoles(BOOTSTRAP, PASSWORDS, { prefix })]);

      expect(await attributes(roles)).toEqual(listed(prefix));
      // One row per grantor: the server's own grant to the creator carries admin, and the
      // runner's carries set.
      const membership = await asBootstrap(async (client) => {
        const { rows } = await client.query(
          `select bool_or(m.set_option) as set, bool_or(m.inherit_option) as inherit, bool_or(m.admin_option) as admin
           from pg_auth_members m
           where m.roleid = (select oid from pg_roles where rolname = $1)
             and m.member = (select oid from pg_roles where rolname = current_user)`,
          [`${prefix}owner`],
        );
        return rows[0];
      });
      expect(membership).toEqual({ set: true, inherit: false, admin: true });
      // The bootstrap does not hold the owner's rights without an explicit SET ROLE, and can take it.
      await asBootstrap(async (client) => {
        await client.query(`set role ${pg.escapeIdentifier(`${prefix}owner`)}`);
        expect((await client.query("select current_user as role")).rows[0].role).toBe(`${prefix}owner`);
      });
      // The password was set: the login role passes authentication (a wrong password is 28P01)
      // and is then refused only for want of CONNECT on template1, which no personal role has.
      const login = new pg.Client({
        connectionString: BOOTSTRAP.replace("migrator:", `${prefix}admin:`).replace("/postgres", "/template1"),
      });
      await expect(login.connect()).rejects.toMatchObject({ code: "42501" });
      await login.end().catch(() => {});

      // A third run changes nothing.
      await ensureRoles(BOOTSTRAP, PASSWORDS, { prefix });
      expect(await attributes(roles)).toEqual(listed(prefix));
    });
  });

  it("a role that exists with another attribute is refused", async () => {
    await withPrefix(async (prefix, roles) => {
      const writer = pg.escapeIdentifier(`${prefix}writer`);
      await asBootstrap((client) => client.query(`create role ${writer} login createdb`));

      await expect(ensureRoles(BOOTSTRAP, PASSWORDS, { prefix })).rejects.toMatchObject({ code: "role_attributes" });
      // Refused, not altered, and no other role was made.
      expect(await attributes(roles)).toEqual(
        listed(prefix)
          .filter((row) => row.rolname === `${prefix}writer`)
          .map((row) => ({ ...row, rolcreatedb: true })),
      );

      // The positive control: the same call once the role has only the listed attributes.
      await asBootstrap((client) => client.query(`alter role ${writer} nocreatedb`));
      await ensureRoles(BOOTSTRAP, PASSWORDS, { prefix });
      expect(await attributes(roles)).toEqual(listed(prefix));

      // A login role where the owner should be, and an owner that can log in, are refused too.
      await asBootstrap((client) => client.query(`alter role ${pg.escapeIdentifier(`${prefix}owner`)} login`));
      await expect(ensureRoles(BOOTSTRAP, PASSWORDS, { prefix })).rejects.toMatchObject({ code: "role_attributes" });
    });
  });

  it("a role's password never reaches the server in clear", async () => {
    await withPrefix(async (prefix) => {
      // Passwords of this test's own, one of them outside ASCII, so the stored verifier is shown
      // to be the one the driver computes at login.
      const passwords = {
        admin: `pw-admin-${randomBytes(6).toString("hex")}`,
        writer: `pw-writer-${randomBytes(6).toString("hex")}-caf\u00e9\u00a0x`,
        reader: `pw-reader-${randomBytes(6).toString("hex")}`,
        pipeline: `pw-pipeline-${randomBytes(6).toString("hex")}`,
        work: `pw-work-${randomBytes(6).toString("hex")}`,
        restricted: `pw-restricted-${randomBytes(6).toString("hex")}`,
      };
      // ensureRoles makes its own connection, so there is no pool to wrap: every statement any
      // client sends is recorded at the driver, text and values.
      const sent: string[] = [];
      const query = pg.Client.prototype.query;
      vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
        sent.push(JSON.stringify(args));
        return (query as (...given: unknown[]) => unknown).apply(this, args);
      } as typeof query);
      await ensureRoles(BOOTSTRAP, passwords, { prefix });
      await ensureRoles(BOOTSTRAP, passwords, { prefix });
      vi.restoreAllMocks();

      expect(sent.length).toBeGreaterThan(6);
      for (const password of Object.values(passwords))
        expect(sent.filter((statement) => statement.includes(password))).toEqual([]);
      // What was sent instead: a SCRAM-SHA-256 verifier with 4096 iterations and a 16-byte salt,
      // one per login role per run, never the same twice.
      const verifiers = sent.flatMap(
        (statement) =>
          /SCRAM-SHA-256\$4096:([A-Za-z0-9+/=]+)\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}/.exec(statement) ?? [],
      );
      const salts = verifiers.filter((_, index) => index % 2 === 1);
      expect(salts).toHaveLength(12);
      expect(new Set(salts).size).toBe(12);
      for (const salt of salts) expect(Buffer.from(salt, "base64")).toHaveLength(16);

      // The positive control: each role logs in with its password, and with no other. A database
      // made here lets any role connect; the two the server came with let no personal role in.
      const database = `${prefix}db`;
      await asBootstrap((client) =>
        client.query(`create database ${pg.escapeIdentifier(database)} template template0`),
      );
      try {
        const login = async (role: string, password: string): Promise<string> => {
          const client = new pg.Client({
            host: "127.0.0.1",
            port: Number(process.env.INTELLIGENCE_PG_PORT ?? 54329),
            database,
            user: role,
            password,
          });
          try {
            await client.connect();
            return (await client.query("select current_user as role")).rows[0].role as string;
          } catch (error) {
            return `SQLSTATE ${(error as { code?: string }).code}`;
          } finally {
            await client.end().catch(() => {});
          }
        };
        for (const name of ["admin", "writer", "reader", "pipeline", "work", "restricted"] as const) {
          expect(await login(`${prefix}${name}`, passwords[name])).toBe(`${prefix}${name}`);
          expect(await login(`${prefix}${name}`, `${passwords[name]}x`)).toBe("SQLSTATE 28P01");
        }
      } finally {
        await asBootstrap((client) =>
          client.query(`drop database if exists ${pg.escapeIdentifier(database)} with (force)`),
        );
      }
    });
  });

  // What a membership test works with: the eight roles as a first run leaves them, and one more.
  const withRoles = (
    fn: (at: {
      name: (role: string) => string;
      run: (text: string) => Promise<unknown>;
      refused: () => Promise<void>;
      passes: () => Promise<void>;
      left: unknown[];
    }) => Promise<void>,
  ): Promise<void> =>
    withPrefix(async (prefix, roles) => {
      const name = (role: string): string => pg.escapeIdentifier(`${prefix}${role}`);
      const run = (text: string) => asBootstrap((client) => client.query(text));
      const memberships = () =>
        asBootstrap(async (client) => {
          const { rows } = await client.query(
            `select r.rolname as role, m.rolname as member, a.admin_option as admin, a.inherit_option as inherit, a.set_option as set
             from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member
             where r.rolname = any($1) or m.rolname = any($1)
             order by r.rolname, m.rolname, a.set_option`,
            [roles],
          );
          return rows;
        });
      await ensureRoles(BOOTSTRAP, PASSWORDS, { prefix });
      // What a run leaves: the server's own grant of each role to its creator, which carries
      // admin and nothing else, and the one grant of the owner that carries set.
      const creator = (role: string) => ({
        role: `${prefix}${role}`,
        member: "migrator",
        admin: true,
        inherit: false,
        set: false,
      });
      const left = [
        creator("admin"),
        creator("notify"),
        creator("owner"),
        { ...creator("owner"), admin: false, set: true },
        creator("pipeline"),
        creator("proxy"),
        creator("reader"),
        creator("restricted"),
        creator("work"),
        creator("writer"),
      ];
      expect(await memberships()).toEqual(left);
      await run(`create role ${name("other")}`);
      await fn({
        name,
        run,
        left,
        // A refusal alters nothing.
        refused: async () => {
          const before = await memberships();
          await expect(ensureRoles(BOOTSTRAP, PASSWORDS, { prefix })).rejects.toMatchObject({
            code: "role_attributes",
          });
          expect(await memberships()).toEqual(before);
        },
        // The positive control: the same call passes, and leaves exactly what the first run left.
        passes: async () => {
          await ensureRoles(BOOTSTRAP, PASSWORDS, { prefix });
          expect(await memberships()).toEqual(left);
        },
      });
    });

  it("ensureRoles makes eight runtime roles, each with no attribute and no membership", () =>
    withPrefix(async (prefix, roles) => {
      await ensureRoles(BOOTSTRAP, PASSWORDS, { prefix });
      expect(await attributes(roles)).toEqual(listed(prefix));
      // No runtime role is a member of any role, and none has a member but its creator's grant.
      const rows = await asBootstrap(async (client) => {
        const { rows: found } = await client.query(
          `select r.rolname as role, m.rolname as member, a.admin_option as admin, a.set_option as set
           from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member
           where (r.rolname = any($1) or m.rolname = any($1)) and r.rolname <> $2
           order by r.rolname`,
          [roles, `${prefix}owner`],
        );
        return found;
      });
      expect(rows).toEqual(
        ["admin", "notify", "pipeline", "proxy", "reader", "restricted", "work", "writer"].map((name) => ({
          role: `${prefix}${name}`,
          member: "migrator",
          admin: true,
          set: false,
        })),
      );
    }));

  // The restricted worker's role, checked as pi_work's is.
  it("pi_restricted is made with the runtime attributes, and refused with any other", () =>
    withPrefix(async (prefix, roles) => {
      const restricted = pg.escapeIdentifier(`${prefix}restricted`);
      // bypassrls is not tried: the bootstrap, not a superuser, cannot make a role with it.
      for (const attribute of ["createdb", "createrole"]) {
        await asBootstrap((client) => client.query(`create role ${restricted} login ${attribute}`));
        await expect(ensureRoles(BOOTSTRAP, PASSWORDS, { prefix }), attribute).rejects.toMatchObject({
          code: "role_attributes",
        });
        expect((await attributes(roles)).map((row) => row.rolname)).toEqual([`${prefix}restricted`]);
        await asBootstrap((client) => client.query(`drop role ${restricted}`));
      }
      // The positive control: made by ensureRoles with the runtime attributes alone, and it logs in.
      await ensureRoles(BOOTSTRAP, PASSWORDS, { prefix });
      expect(await attributes(roles)).toEqual(listed(prefix));
      expect(await loginWith(`${prefix}db`, `${prefix}restricted`, "local-only")).toBe(`${prefix}restricted`);
    }));

  it("a pi_restricted that is a member of a role, or has a member, is refused", () =>
    withRoles(async ({ name, run, refused, passes }) => {
      await run(`grant ${name("other")} to ${name("restricted")}`);
      await refused();
      await run(`revoke ${name("other")} from ${name("restricted")}`);
      await passes();
      await run(`grant ${name("restricted")} to ${name("other")}`);
      await refused();
      await run(`revoke ${name("restricted")} from ${name("other")}`);
      await passes();
    }));

  it("pi_work is made with the runtime attributes, and refused with any other", () =>
    withPrefix(async (prefix, roles) => {
      const work = pg.escapeIdentifier(`${prefix}work`);
      for (const attribute of ["createdb", "createrole"]) {
        await asBootstrap((client) => client.query(`create role ${work} login ${attribute}`));
        await expect(ensureRoles(BOOTSTRAP, PASSWORDS, { prefix }), attribute).rejects.toMatchObject({
          code: "role_attributes",
        });
        // Refused, not altered, and no other role was made.
        expect((await attributes(roles)).map((row) => row.rolname)).toEqual([`${prefix}work`]);
        await asBootstrap((client) => client.query(`drop role ${work}`));
      }
      // A pi_work that cannot log in is refused too.
      await asBootstrap((client) => client.query(`create role ${work} nologin`));
      await expect(ensureRoles(BOOTSTRAP, PASSWORDS, { prefix })).rejects.toMatchObject({ code: "role_attributes" });
      // The positive control: with the runtime attributes alone it passes, and is made so when absent.
      await asBootstrap((client) => client.query(`alter role ${work} login`));
      await ensureRoles(BOOTSTRAP, PASSWORDS, { prefix });
      expect(await attributes(roles)).toEqual(listed(prefix));
    }));

  it("a pi_work that is a member of a role, or has a member, is refused", () =>
    withRoles(async ({ name, run, refused, passes }) => {
      await run(`grant ${name("other")} to ${name("work")}`);
      await refused();
      await run(`revoke ${name("other")} from ${name("work")}`);
      await passes();
      await run(`grant ${name("work")} to ${name("other")}`);
      await refused();
      await run(`revoke ${name("work")} from ${name("other")}`);
      await passes();
    }));

  it("pi_proxy is made with the runtime attributes and no password, and refused with any other attribute", () =>
    withPrefix(async (prefix, roles) => {
      const proxy = pg.escapeIdentifier(`${prefix}proxy`);
      for (const attribute of ["createdb", "createrole", "nologin"]) {
        await asBootstrap((client) =>
          client.query(`create role ${proxy} ${attribute === "nologin" ? "nologin" : `login ${attribute}`}`),
        );
        await expect(ensureRoles(BOOTSTRAP, PASSWORDS, { prefix }), attribute).rejects.toMatchObject({
          code: "role_attributes",
        });
        // Refused, not altered, and no other role was made.
        expect((await attributes(roles)).map((row) => row.rolname)).toEqual([`${prefix}proxy`]);
        await asBootstrap((client) => client.query(`drop role ${proxy}`));
      }
      // The positive control: made by ensureRoles with the runtime attributes alone.
      await ensureRoles(BOOTSTRAP, PASSWORDS, { prefix });
      expect(await attributes(roles)).toEqual(listed(prefix));
      // No password: it cannot log in with any, until one is set.
      expect(await loginWith(`${prefix}db`, `${prefix}proxy`, "local-only")).toBe("SQLSTATE 28P01");
    }));

  // The work-notice sender's role, made as pi_proxy is.
  it("pi_notify is made with the runtime attributes and no password, and refused with any other attribute", () =>
    withPrefix(async (prefix, roles) => {
      const notify = pg.escapeIdentifier(`${prefix}notify`);
      for (const attribute of ["createdb", "createrole", "nologin"]) {
        await asBootstrap((client) =>
          client.query(`create role ${notify} ${attribute === "nologin" ? "nologin" : `login ${attribute}`}`),
        );
        await expect(ensureRoles(BOOTSTRAP, PASSWORDS, { prefix }), attribute).rejects.toMatchObject({
          code: "role_attributes",
        });
        expect((await attributes(roles)).map((row) => row.rolname)).toEqual([`${prefix}notify`]);
        await asBootstrap((client) => client.query(`drop role ${notify}`));
      }
      await ensureRoles(BOOTSTRAP, PASSWORDS, { prefix });
      expect(await attributes(roles)).toEqual(listed(prefix));
      expect(await loginWith(`${prefix}db`, `${prefix}notify`, "local-only")).toBe("SQLSTATE 28P01");
      // A password set on the box survives a second run.
      await asBootstrap((client) => client.query(`alter role ${notify} password 'set-on-the-box'`));
      await ensureRoles(BOOTSTRAP, PASSWORDS, { prefix });
      expect(await loginWith(`${prefix}db`, `${prefix}notify`, "set-on-the-box")).toBe(`${prefix}notify`);
    }));

  it("a pi_notify that is a member of a role, or has a member, is refused", () =>
    withRoles(async ({ name, run, refused, passes }) => {
      await run(`grant ${name("other")} to ${name("notify")}`);
      await refused();
      await run(`revoke ${name("other")} from ${name("notify")}`);
      await passes();
      await run(`grant ${name("notify")} to ${name("other")}`);
      await refused();
      await run(`revoke ${name("notify")} from ${name("other")}`);
      await passes();
    }));

  it("a pi_proxy that is a member of a role, or has a member, is refused", () =>
    withRoles(async ({ name, run, refused, passes }) => {
      await run(`grant ${name("other")} to ${name("proxy")}`);
      await refused();
      await run(`revoke ${name("other")} from ${name("proxy")}`);
      await passes();
      await run(`grant ${name("proxy")} to ${name("other")}`);
      await refused();
      await run(`revoke ${name("proxy")} from ${name("other")}`);
      await passes();
    }));

  it("a password the superuser set on pi_proxy survives a second ensureRoles", () =>
    withPrefix(async (prefix) => {
      await ensureRoles(BOOTSTRAP, PASSWORDS, { prefix });
      const role = `${prefix}proxy`;
      await asBootstrap((client) => client.query(`alter role ${pg.escapeIdentifier(role)} password 'set-on-the-box'`));
      await ensureRoles(BOOTSTRAP, PASSWORDS, { prefix });
      expect(await loginWith(`${prefix}db`, role, "set-on-the-box")).toBe(role);
      expect(await loginWith(`${prefix}db`, role, "local-only")).toBe("SQLSTATE 28P01");
    }));

  // The restricted role's password is the owner's to set (PI_DATABASE_URL_RESTRICTED), so a
  // migration never waits on it: with none, the role is made with no password, as pi_proxy is,
  // and cannot log in with any until one is set.
  it("with no restricted password ensureRoles still makes pi_restricted, which cannot log in with any password", () =>
    withPrefix(async (prefix, roles) => {
      const { restricted: _omitted, ...others } = PASSWORDS;
      await ensureRoles(BOOTSTRAP, others, { prefix });
      expect(await attributes(roles)).toEqual(listed(prefix));
      const role = `${prefix}restricted`;
      expect(await loginWith(`${prefix}db`, role, "local-only")).toBe("SQLSTATE 28P01");
      // An empty password is refused by the driver before it reaches the server; another is not.
      expect(await loginWith(`${prefix}db`, role, "any-other-password")).toBe("SQLSTATE 28P01");
      // The other five still log in with theirs.
      expect(await loginWith(`${prefix}db`, `${prefix}work`, "local-only")).toBe(`${prefix}work`);
      // A second run changes nothing about it.
      await ensureRoles(BOOTSTRAP, others, { prefix });
      expect(await loginWith(`${prefix}db`, role, "local-only")).toBe("SQLSTATE 28P01");
      // The positive control: the same role takes its password once the owner gives one.
      await ensureRoles(BOOTSTRAP, PASSWORDS, { prefix });
      expect(await loginWith(`${prefix}db`, role, "local-only")).toBe(role);
    }));

  it("a restricted password already set survives a run with none", () =>
    withPrefix(async (prefix) => {
      const { restricted: _omitted, ...others } = PASSWORDS;
      await ensureRoles(BOOTSTRAP, { ...others, restricted: "set-by-the-owner" }, { prefix });
      await ensureRoles(BOOTSTRAP, others, { prefix });
      const role = `${prefix}restricted`;
      expect(await loginWith(`${prefix}db`, role, "set-by-the-owner")).toBe(role);
      expect(await loginWith(`${prefix}db`, role, "local-only")).toBe("SQLSTATE 28P01");
    }));

  it("a pipeline role that is a member of another role is refused", () =>
    withRoles(async ({ name, run, refused, passes }) => {
      await run(`grant ${name("other")} to ${name("pipeline")}`);
      await refused();
      await run(`revoke ${name("other")} from ${name("pipeline")}`);
      await passes();
    }));

  it("a runtime role that is a member of another role is refused", () =>
    withRoles(async ({ name, run, refused, passes }) => {
      for (const role of ["admin", "writer", "reader", "pipeline", "work", "proxy"]) {
        await run(`grant ${name("other")} to ${name(role)}`);
        await refused();
        await run(`revoke ${name("other")} from ${name(role)}`);
        await passes();
      }
      // A runtime role that is a member of the owner would hold every table.
      await run(`grant ${name("owner")} to ${name("reader")}`);
      await refused();
      await run(`revoke ${name("owner")} from ${name("reader")}`);
      await passes();
    }));

  it("a runtime role with a member is refused", () =>
    withRoles(async ({ name, run, refused, passes }) => {
      for (const role of ["admin", "writer", "reader", "pipeline", "work", "proxy"]) {
        // Another role that would hold the runtime role's rights.
        await run(`grant ${name(role)} to ${name("other")}`);
        await refused();
        await run(`revoke ${name(role)} from ${name("other")}`);
        await passes();
        // The bootstrap itself, able to become the runtime role: more than the server's own
        // grant to the role's creator, which carries admin alone.
        await run(`grant ${name(role)} to current_user with set true`);
        await refused();
        await run(`revoke ${name(role)} from current_user`);
        await passes();
      }
    }));

  it("pi_owner with a second member is refused", () =>
    withRoles(async ({ name, run, refused, passes }) => {
      await run(`grant ${name("owner")} to ${name("other")}`);
      await refused();
      await run(`revoke ${name("owner")} from ${name("other")}`);
      await passes();
    }));

  it("the bootstrap's membership in the owner is checked after the run's own grant", () =>
    withRoles(async ({ name, run, passes }) => {
      // A run that was killed between creating the owner and granting it leaves no grant that
      // carries set: the next run finishes it, and is not refused.
      await run(`revoke ${name("owner")} from current_user`);
      await passes();
      // The run's own grant, found inheriting, is put right by the grant the run makes.
      await run(`grant ${name("owner")} to current_user with inherit true`);
      await passes();
    }));
});
