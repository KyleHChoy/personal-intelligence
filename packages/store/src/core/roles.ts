import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { CodedError } from "@intelligence/contracts/personal";
import pg from "pg";
import { parseDatabaseUrl } from "./db.ts";
import { ROLES_LOCK } from "./locks.ts";

// The server's personal roles. Roles belong to the whole server, so this is separate from migrating
// any one database.

const ATTRIBUTES = "nosuperuser nobypassrls nocreatedb nocreaterole noreplication";

const refusal = (code: string): Error => new CodedError(code);

const SCRAM_ITERATIONS = 4096;
const hmac = (key: Buffer, text: string): Buffer => createHmac("sha256", key).update(text, "utf8").digest();

// What the server stores for a password, computed here so the password itself is never sent:
// not in a statement, and so not in the server's log. The password is prepared in the same
// three steps as the pg driver prepares it at login (its saslprep): a non-ASCII space becomes a
// space, the characters RFC 3454 maps to nothing are dropped, and the rest is NFKC.
export function scramVerifier(password: string): string {
  const prepared = password
    .replace(/[   -​  　]/g, " ")
    .replace(/­|͏|᠆|[᠋-᠍]|‌|‍|⁠|[︀-️]|﻿/g, "")
    .normalize("NFKC");
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(prepared, salt, SCRAM_ITERATIONS, 32, "sha256");
  const storedKey = createHash("sha256").update(hmac(salted, "Client Key")).digest();
  const serverKey = hmac(salted, "Server Key");
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

type Found = {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
};

type Membership = { role: string; member: string; bootstrap: boolean; admin: boolean; inherit: boolean; set: boolean };

// One row per grantor.
const MEMBERSHIPS = `
  select r.rolname as role, m.rolname as member, m.rolname = current_user as bootstrap,
    a.admin_option as admin, a.inherit_option as inherit, a.set_option as set
  from pg_auth_members a
  join pg_roles r on r.oid = a.roleid
  join pg_roles m on m.oid = a.member
  where r.rolname = any($1) or m.rolname = any($1)`;

// The grant the server itself gives a role's creator: ADMIN, and nothing else.
const adminAlone = (row: Membership): boolean => row.bootstrap && row.admin && !row.inherit && !row.set;

// The box's standing migration role. ensureRoles never makes it, alters it or grants to it: on the
// box pi-migrate does, as the superuser, and only on the owner's word.
export const migratorOf = (prefix = "pi_"): string => `${prefix}migrator`;

// Whether a membership in the owner is one ensureRoles refuses. Two are allowed: the bootstrap's
// own, and the migrator's one grant that sets, does not inherit and cannot grant the owner on.
export function ownerMemberRefused(
  row: Pick<Membership, "member" | "bootstrap" | "admin" | "inherit" | "set">,
  migrator: string,
): boolean {
  if (row.bootstrap) return false;
  return !(row.member === migrator && row.set && !row.inherit && !row.admin);
}

// `prefix` exists only so roles.db.test.ts can make disposable roles beside the real ones on a
// shared server. The schema, the runner and every policy name the `pi_` roles, so a deployment
// always uses the default. `database` exists only so role-check.db.test.ts can run this as a
// bootstrap of its own, which cannot connect to the local server's `postgres`; a deployment
// always uses the default.
export async function ensureRoles(
  bootstrapUrl: string,
  passwords: {
    admin: string;
    writer: string;
    reader: string;
    pipeline: string;
    work: string;
    restricted?: string | undefined;
  },
  options?: { prefix?: string; database?: string },
): Promise<void> {
  const prefix = options?.prefix ?? "pi_";
  const owner = `${prefix}owner`;
  const logins: { name: string; password: string | undefined }[] = [
    { name: `${prefix}admin`, password: passwords.admin },
    { name: `${prefix}writer`, password: passwords.writer },
    { name: `${prefix}reader`, password: passwords.reader },
    { name: `${prefix}pipeline`, password: passwords.pipeline },
    // The durable-work dispatcher.
    { name: `${prefix}work`, password: passwords.work },
    // The restricted worker. Its password is the owner's to set (PI_DATABASE_URL_RESTRICTED), so a
    // migration never waits on it: with none it is made with no password, as pi_proxy is, so no one
    // can log in as it, and a password it has already is kept.
    { name: `${prefix}restricted`, password: passwords.restricted },
  ];
  // The send proxy's role: made with no password and never given one here. On the box pi-migrate
  // sets it as root from a verifier; until then it cannot log in.
  const proxy = `${prefix}proxy`;
  // The work-notice sender's role, made and never given a password here, as pi_proxy.
  const notify = `${prefix}notify`;
  const names = [owner, ...logins.map((role) => role.name), proxy, notify];

  // Advisory locks are per database, so every run takes the lock in the same one.
  const url = parseDatabaseUrl(bootstrapUrl);
  url.pathname = `/${options?.database ?? "postgres"}`;
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  try {
    // Held until the connection closes, so two runs take turns.
    await client.query(ROLES_LOCK);

    // Every existing role, and who is a member of whom, is checked before anything is made or
    // changed: a refusal here alters nothing.
    const { rows } = await client.query<Found>(
      `select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
       from pg_roles where rolname = any($1)`,
      [names],
    );
    for (const role of rows) {
      const other = role.rolsuper || role.rolbypassrls || role.rolcreatedb || role.rolcreaterole || role.rolreplication;
      if (other || role.rolcanlogin !== (role.rolname !== owner)) throw refusal("role_attributes");
    }

    // A runtime role is a member of nothing and has no member, so it holds only the rights
    // granted to it by name and nobody else holds those: the one grant allowed is the server's
    // own to the role's creator. The owner's only members are the bootstrap and, on a box whose
    // owner turned unattended migration on, the migrator.
    const loginNames = [...logins.map((role) => role.name), proxy, notify];
    const memberships = (await client.query<Membership>(MEMBERSHIPS, [names])).rows;
    for (const name of loginNames) {
      const members = memberships.filter((row) => row.role === name);
      if (memberships.some((row) => row.member === name) || members.length > 1 || !members.every(adminAlone))
        throw refusal("role_attributes");
    }
    if (memberships.some((row) => row.role === owner && ownerMemberRefused(row, migratorOf(prefix))))
      throw refusal("role_attributes");

    const missing = (name: string): boolean => !rows.some((role) => role.rolname === name);
    if (missing(owner)) await client.query(`create role ${pg.escapeIdentifier(owner)} nologin ${ATTRIBUTES}`);
    for (const { name, password } of logins) {
      if (missing(name)) await client.query(`create role ${pg.escapeIdentifier(name)} login ${ATTRIBUTES}`);
      // On every run: a role that is not a superuser cannot read pg_authid to compare. A role
      // given no password keeps the one it has, or none.
      if (password !== undefined)
        await client.query(
          `alter role ${pg.escapeIdentifier(name)} password ${pg.escapeLiteral(scramVerifier(password))}`,
        );
    }
    // A pi_proxy that exists keeps the password it has.
    if (missing(proxy)) await client.query(`create role ${pg.escapeIdentifier(proxy)} login ${ATTRIBUTES}`);
    // So does a pi_notify that exists.
    if (missing(notify)) await client.query(`create role ${pg.escapeIdentifier(notify)} login ${ATTRIBUTES}`);
    // SET lets a bootstrap that is not a superuser create objects as the owner. INHERIT FALSE
    // keeps it from holding the owner's rights without an explicit SET ROLE.
    await client.query(`grant ${pg.escapeIdentifier(owner)} to current_user with set true, inherit false`);
    // Checked after the grant, so a run killed before it does not leave every later run
    // refused: the bootstrap holds exactly one grant that carries SET, which does not inherit,
    // and beside it at most the server's own grant to the owner's creator (a superuser
    // bootstrap has none).
    const mine = (await client.query<Membership>(MEMBERSHIPS, [[owner]])).rows.filter(
      (row) => row.role === owner && row.bootstrap,
    );
    const settable = mine.filter((row) => row.set);
    const others = mine.filter((row) => !row.set);
    if (settable.length !== 1 || settable.some((row) => row.inherit) || others.length > 1 || !others.every(adminAlone))
      throw refusal("role_attributes");
  } finally {
    await client.end();
  }
}
