import { createHash, randomBytes } from "node:crypto";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import { approvalCodeText } from "@intelligence/contracts/personal";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { insertClient, revokeClient, sha256Hex } from "../test-support/clients.ts";
import { readAs, sqlState } from "../test-support/connections.ts";
import { createTestDatabase, queryAs, type TestDatabase } from "../test-support/database.ts";
import { registrationFingerprint } from "./oauth.ts";
import { createReader, type Reader } from "./read.ts";

// One database for the file; each test makes its own clients and registrations.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const quiet: PersonalLogger = { info() {}, warn() {}, error() {} };
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const URI = "https://claude.ai/api/mcp/auth_callback";
const RESOURCE = "https://pi.example/mcp";
const fresh = (prefix: string): string => `${prefix}${randomBytes(32).toString("base64url")}`;
const registrationId = (): string => `oc_${randomBytes(24).toString("base64url")}`;

let db: TestDatabase;
let reader: Reader;
beforeAll(async () => {
  db = await createTestDatabase();
  reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet });
});
afterAll(async () => {
  await reader?.close();
  await db?.drop();
});

// A committed statement as pi_owner, to move a row's times into the past.
async function asOwner(text: string, values: unknown[] = []): Promise<void> {
  const client = new pg.Client({ connectionString: db.urls.bootstrap });
  await client.connect();
  try {
    await client.query("set role pi_owner");
    await client.query(text, values);
  } finally {
    await client.end();
  }
}

// The client an access token reaches, as every reader call asks.
const clientOf = async (token: string): Promise<string[]> =>
  (await readAs(db, token, (query) => query<{ id: string }>("select id from policy.current_client()"))).map(
    (row) => row.id,
  );

// An approval code made as `pi oauth approve` makes one, for a new client and the registration
// named by its fingerprint; its hash and client.
async function approval(name: string, registration: string): Promise<{ hash: string; client: string }> {
  const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
  try {
    const { code } = await admin.clients.approveOAuth(
      {
        name,
        runtime: "cloud",
        vendorRetention: "unknown",
        compartments: ["own"],
        views: ["self"],
        tools: ["get_self"],
      },
      registrationFingerprint(registration),
    );
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const [row] = await queryAs<{ id: string }>(db.urls.admin, "select id from policy.clients where name = $1", [name]);
    return { hash: sha256Hex(approvalCodeText(code) ?? ""), client: row?.id ?? "" };
  } finally {
    await admin.close();
  }
}

async function registered(): Promise<string> {
  const id = registrationId();
  await reader.oauth.register(id, { redirectUris: [URI, "http://localhost:3118/callback"], clientName: "Claude" });
  return id;
}

// A registration approved for a new client, and its authorization code.
async function authorized(name: string): Promise<{ registration: string; client: string; code: string }> {
  const registration = await registered();
  const { hash, client } = await approval(name, registration);
  const code = fresh("poc_");
  expect(
    await reader.oauth.authorize({
      registration,
      approvalHash: hash,
      codeHash: sha256Hex(code),
      redirectUri: URI,
      challenge: CHALLENGE,
      resource: RESOURCE,
    }),
  ).toBe(true);
  return { registration, client, code };
}

async function tokens(
  name: string,
): Promise<{ registration: string; client: string; code: string; access: string; refresh: string }> {
  const grant = await authorized(name);
  const access = fresh("pio_");
  const refresh = fresh("pir_");
  expect(
    await reader.oauth.exchange({
      registration: grant.registration,
      codeHash: sha256Hex(grant.code),
      challenge: CHALLENGE,
      redirectUri: URI,
      resource: RESOURCE,
      accessHash: sha256Hex(access),
      refreshHash: sha256Hex(refresh),
    }),
  ).toBe(true);
  return { ...grant, access, refresh };
}

describe("0031: OAuth's grants", () => {
  it("pi_reader and the other runtime roles hold nothing on the tables; pi_reader executes the five functions; pi_admin reads, and inserts approvals only", async () => {
    const client = await insertClient(db, "grants", ["own"]);
    for (const table of ["oauth_registrations", "oauth_approvals", "oauth_codes", "oauth_tokens"]) {
      expect(
        await sqlState(() => readAs(db, client.token, (query) => query(`select * from policy.${table}`))),
        table,
      ).toBe("42501");
      for (const url of [db.urls.writer, db.urls.pipeline, db.urls.work, db.urls.proxy])
        expect(await sqlState(() => queryAs(url, `select * from policy.${table}`)), table).toBe("42501");
      expect(await sqlState(() => queryAs(db.urls.admin, `select count(*) from policy.${table}`)), table).toBeNull();
      expect(await sqlState(() => queryAs(db.urls.admin, `delete from policy.${table}`)), table).toBe("42501");
    }
    expect(await sqlState(() => queryAs(db.urls.admin, "update policy.oauth_approvals set used_at = null"))).toBe(
      "42501",
    );
    expect(
      await sqlState(() =>
        queryAs(db.urls.admin, "insert into policy.oauth_approvals (code_hash, client_id) values ($1, $2)", [
          sha256Hex("x"),
          client.id,
        ]),
      ),
    ).toBeNull();
    // Longer than ten minutes is refused by the table.
    expect(
      await sqlState(() =>
        queryAs(
          db.urls.admin,
          "insert into policy.oauth_approvals (code_hash, client_id, expires_at) values ($1, $2, now() + interval '11 minutes')",
          [sha256Hex("y"), client.id],
        ),
      ),
    ).toBe("23514");
    const functions = await queryAs<{ name: string; reader: boolean; admin: boolean; writer: boolean }>(
      db.urls.admin,
      `select p.oid::regprocedure::text as name, has_function_privilege('pi_reader', p.oid, 'EXECUTE') as reader,
              has_function_privilege('pi_admin', p.oid, 'EXECUTE') as admin, has_function_privilege('pi_writer', p.oid, 'EXECUTE') as writer
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'policy' and p.proname like 'oauth\\_%' order by 1`,
    );
    expect(functions.map((one) => one.name)).toEqual([
      "policy.oauth_authorize(text,text,text,text,text,text)",
      "policy.oauth_exchange(text,text,text,text,text,text,text)",
      "policy.oauth_refresh(text,text,text,text)",
      "policy.oauth_register(text,text[],text)",
      "policy.oauth_registration(text)",
    ]);
    for (const one of functions) expect(one, one.name).toMatchObject({ reader: true, admin: false, writer: false });
  });
});

describe("0031: registrations", () => {
  it("are kept and read back; a day-old unapproved one is dropped; past 100 unapproved the oldest goes, never an approved one", async () => {
    const first = await registered();
    expect(await reader.oauth.registration(first)).toEqual({
      redirectUris: [URI, "http://localhost:3118/callback"],
      clientName: "Claude",
      fingerprint: registrationFingerprint(first),
    });
    expect(await reader.oauth.registration(registrationId())).toBeNull();
    await asOwner("update policy.oauth_registrations set created_at = now() - interval '2 days' where id = $1", [
      first,
    ]);
    await registered();
    expect(await reader.oauth.registration(first)).toBeNull();

    // Start from none unapproved, so the count is this test's; one approved stays throughout.
    const kept = (await authorized("register-kept")).registration;
    await asOwner(
      "update policy.oauth_registrations set created_at = now() - interval '2 days' where client_id is null",
    );
    await registered();
    const made: string[] = [];
    for (let n = 0; n < 99; n += 1) made.push(await registered());
    await asOwner(
      "update policy.oauth_registrations set created_at = now() - interval '1 hour' where client_id is null",
    );
    const oldest = made[0] ?? "";
    await asOwner("update policy.oauth_registrations set created_at = now() - interval '2 hours' where id = $1", [
      oldest,
    ]);
    const newest = await registered();
    expect(await reader.oauth.registration(newest)).not.toBeNull();
    expect(await reader.oauth.registration(oldest)).toBeNull();
    expect(await reader.oauth.registration(made[1] ?? "")).not.toBeNull();
    await asOwner("update policy.oauth_registrations set created_at = now() - interval '3 days' where id = $1", [kept]);
    await registered();
    expect(await reader.oauth.registration(kept)).not.toBeNull();
  });
});

describe("0031: approval and authorization codes", () => {
  it("an approval code is spent once, and refused unknown, expired or for a revoked client", async () => {
    const registration = await registered();
    const { hash, client } = await approval("approve-once", registration);
    const authorize = (approvalHash: string) =>
      reader.oauth.authorize({
        registration,
        approvalHash,
        codeHash: sha256Hex(fresh("poc_")),
        redirectUri: URI,
        challenge: CHALLENGE,
        resource: null,
      });
    expect(await authorize(sha256Hex("ZZZZZZZZZZZZ"))).toBe(false);
    expect(
      await reader.oauth.authorize({
        registration: registrationId(),
        approvalHash: hash,
        codeHash: sha256Hex(fresh("poc_")),
        redirectUri: URI,
        challenge: CHALLENGE,
        resource: null,
      }),
    ).toBe(false);
    expect(await authorize(hash)).toBe(true);
    expect(await authorize(hash)).toBe(false);
    expect(client).toMatch(/^cli_/);

    const late = await approval("approve-late", registration);
    await asOwner(
      "update policy.oauth_approvals set created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' where code_hash = $1",
      [late.hash],
    );
    expect(await authorize(late.hash)).toBe(false);

    const gone = await approval("approve-revoked", registration);
    await revokeClient(db, { id: gone.client, name: "approve-revoked", token: "", compartments: [] });
    expect(await authorize(gone.hash)).toBe(false);
  });

  it("a code is exchanged once; a mismatch spends it; a reuse revokes what it issued", async () => {
    const grant = await tokens("exchange-once");
    expect(await clientOf(grant.access)).toEqual([grant.client]);
    const again = () =>
      reader.oauth.exchange({
        registration: grant.registration,
        codeHash: sha256Hex(grant.code),
        challenge: CHALLENGE,
        redirectUri: URI,
        resource: RESOURCE,
        accessHash: sha256Hex(fresh("pio_")),
        refreshHash: sha256Hex(fresh("pir_")),
      });
    expect(await again()).toBe(false);
    expect(await clientOf(grant.access)).toEqual([]);

    for (const [name, over] of [
      ["mismatch-challenge", { challenge: createHash("sha256").update("w".repeat(43)).digest("base64url") }],
      ["mismatch-redirect", { redirectUri: "http://localhost:3118/callback" }],
      ["mismatch-resource", { resource: "https://other.example/mcp" }],
      ["mismatch-registration", { registration: registrationId() }],
    ] as const) {
      const one = await authorized(name);
      const exchange = (
        values: Partial<{ challenge: string; redirectUri: string; resource: string; registration: string }>,
      ) =>
        reader.oauth.exchange({
          registration: one.registration,
          codeHash: sha256Hex(one.code),
          challenge: CHALLENGE,
          redirectUri: URI,
          resource: RESOURCE,
          accessHash: sha256Hex(fresh("pio_")),
          refreshHash: sha256Hex(fresh("pir_")),
          ...values,
        });
      expect(await exchange(over), name).toBe(false);
      expect(await exchange({}), name).toBe(false);
    }

    const expired = await authorized("exchange-expired");
    await asOwner("update policy.oauth_codes set expires_at = now() - interval '1 second' where code_hash = $1", [
      sha256Hex(expired.code),
    ]);
    expect(
      await reader.oauth.exchange({
        registration: expired.registration,
        codeHash: sha256Hex(expired.code),
        challenge: CHALLENGE,
        redirectUri: URI,
        resource: null,
        accessHash: sha256Hex(fresh("pio_")),
        refreshHash: sha256Hex(fresh("pir_")),
      }),
    ).toBe(false);
  });
});

describe("pi oauth code: a new approval code for an existing client", () => {
  it("makes a code for an active client, as single use as the first; refuses an unknown or revoked name", async () => {
    const first = await authorized("code-again");
    const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
    try {
      const registration = await registered();
      const { code } = await admin.clients.oauthCode("code-again", registrationFingerprint(registration));
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      const hash = sha256Hex(approvalCodeText(code) ?? "");
      const authorize = () =>
        reader.oauth.authorize({
          registration,
          approvalHash: hash,
          codeHash: sha256Hex(fresh("poc_")),
          redirectUri: URI,
          challenge: CHALLENGE,
          resource: null,
        });
      expect(await authorize()).toBe(true);
      expect(await authorize()).toBe(false);
      // No second client: the code leads to the first one's.
      expect(
        await queryAs(db.urls.admin, "select count(*)::int as n from policy.clients where name = 'code-again'"),
      ).toEqual([{ n: 1 }]);
      const access = fresh("pio_");
      expect(
        await reader.oauth.exchange({
          registration,
          codeHash: sha256Hex(fresh("poc_")),
          challenge: CHALLENGE,
          redirectUri: URI,
          resource: null,
          accessHash: sha256Hex(access),
          refreshHash: sha256Hex(fresh("pir_")),
        }),
      ).toBe(false);
      expect(first.client).toMatch(/^cli_/);

      const other = registrationFingerprint(await registered());
      await expect(admin.clients.oauthCode("no-such-client", other)).rejects.toMatchObject({ code: "not_found" });
      await expect(admin.clients.oauthCode("code-again", "not a print")).rejects.toMatchObject({
        code: "unknown_registration",
      });
      await revokeClient(db, { id: first.client, name: "code-again", token: "", compartments: [] });
      await expect(admin.clients.oauthCode("code-again", other)).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await admin.close();
    }
  });
});

describe("0031: current_client() for an OAuth access token", () => {
  it("resolves to its own client, and not once expired, revoked, a refresh token, or its client revoked", async () => {
    const a = await tokens("current-a");
    const b = await tokens("current-b");
    expect(await clientOf(a.access)).toEqual([a.client]);
    expect(await clientOf(b.access)).toEqual([b.client]);
    expect(a.client).not.toBe(b.client);
    expect(await clientOf(a.refresh)).toEqual([]);
    // A client's own token still resolves beside OAuth's.
    const plain = await insertClient(db, "current-plain", ["own"]);
    expect(await clientOf(plain.token)).toEqual([plain.id]);
    expect(await clientOf("")).toEqual([]);

    await asOwner("update policy.oauth_tokens set expires_at = now() - interval '1 second' where token_hash = $1", [
      sha256Hex(a.access),
    ]);
    expect(await clientOf(a.access)).toEqual([]);

    const c = await tokens("current-c");
    await asOwner("update policy.oauth_tokens set revoked_at = now() where token_hash = $1", [sha256Hex(c.access)]);
    expect(await clientOf(c.access)).toEqual([]);

    await revokeClient(db, { id: b.client, name: "current-b", token: "", compartments: [] });
    expect(await clientOf(b.access)).toEqual([]);
    expect(
      await reader.oauth.refresh({
        registration: b.registration,
        refreshHash: sha256Hex(b.refresh),
        accessHash: sha256Hex(fresh("pio_")),
        nextRefreshHash: sha256Hex(fresh("pir_")),
      }),
    ).toBe(false);
  });

  it("an OAuth client reads through the reader as its client: tools and views are its registration's", async () => {
    const grant = await tokens("current-reads");
    expect(await reader.client(grant.access)).toMatchObject({
      id: grant.client,
      name: "current-reads",
      views: ["self"],
      tools: ["get_self"],
      compartments: ["own"],
    });
  });
});

describe("0031: refresh", () => {
  it("rotates; the old one used again revokes the family; another registration's use revokes too; expiry refuses", async () => {
    const grant = await tokens("refresh-rotate");
    const next = { access: fresh("pio_"), refresh: fresh("pir_") };
    const refresh = (old: string, access: string, nextRefresh: string, registration = grant.registration) =>
      reader.oauth.refresh({
        registration,
        refreshHash: sha256Hex(old),
        accessHash: sha256Hex(access),
        nextRefreshHash: sha256Hex(nextRefresh),
      });
    expect(await refresh(grant.refresh, next.access, next.refresh)).toBe(true);
    expect(await clientOf(next.access)).toEqual([grant.client]);
    // The first access token is not revoked by a rotation.
    expect(await clientOf(grant.access)).toEqual([grant.client]);
    expect(await refresh(grant.refresh, fresh("pio_"), fresh("pir_"))).toBe(false);
    expect(await clientOf(next.access)).toEqual([]);
    expect(await clientOf(grant.access)).toEqual([]);
    expect(await refresh(next.refresh, fresh("pio_"), fresh("pir_"))).toBe(false);
    // An access token is no refresh token.
    const other = await tokens("refresh-other");
    expect(await refresh(other.access, fresh("pio_"), fresh("pir_"), other.registration)).toBe(false);
    expect(await refresh(other.refresh, fresh("pio_"), fresh("pir_"), registrationId())).toBe(false);
    expect(await clientOf(other.access)).toEqual([]);

    const late = await tokens("refresh-late");
    await asOwner("update policy.oauth_tokens set expires_at = now() - interval '1 second' where token_hash = $1", [
      sha256Hex(late.refresh),
    ]);
    expect(await refresh(late.refresh, fresh("pio_"), fresh("pir_"), late.registration)).toBe(false);
  });

  it("stores hashes only: no row holds a token or code in clear", async () => {
    const grant = await tokens("refresh-hashes");
    const client = new pg.Client({ connectionString: db.urls.bootstrap });
    await client.connect();
    try {
      await client.query("set role pi_owner");
      const dump = JSON.stringify([
        (await client.query("select * from policy.oauth_codes")).rows,
        (await client.query("select * from policy.oauth_tokens")).rows,
        (await client.query("select * from policy.oauth_approvals")).rows,
      ]);
      for (const secret of [grant.code, grant.access, grant.refresh, VERIFIER]) expect(dump).not.toContain(secret);
      expect(dump).toContain(sha256Hex(grant.access));
    } finally {
      await client.end();
    }
  });
});

describe("0167: an approval code opens the one registration it was made for", () => {
  it("another registration typing the code is refused and binds nothing; the named one is then approved", async () => {
    const mine = await registered();
    const stranger = await registered();
    const { hash, client } = await approval("bound-approval", mine);
    const authorize = (registration: string) =>
      reader.oauth.authorize({
        registration,
        approvalHash: hash,
        codeHash: sha256Hex(fresh("poc_")),
        redirectUri: URI,
        challenge: CHALLENGE,
        resource: null,
      });
    expect(await authorize(stranger)).toBe(false);
    expect(
      await queryAs(db.urls.admin, "select client_id from policy.oauth_registrations where id = $1", [stranger]),
    ).toEqual([{ client_id: null }]);
    expect(
      await queryAs(
        db.urls.admin,
        "select used_at is null as unused from policy.oauth_approvals where code_hash = $1",
        [hash],
      ),
    ).toEqual([{ unused: true }]);
    expect(await authorize(mine)).toBe(true);
    expect(
      await queryAs(db.urls.admin, "select client_id from policy.oauth_registrations where id = $1", [mine]),
    ).toEqual([{ client_id: client }]);
  });

  it("an approval made with no registration, as before 0167, binds none", async () => {
    const registration = await registered();
    const client = await insertClient(db, "unbound-approval", ["own"]);
    const code = "ABCDEFGHJKMN";
    await queryAs(db.urls.admin, "insert into policy.oauth_approvals (code_hash, client_id) values ($1, $2)", [
      sha256Hex(code),
      client.id,
    ]);
    expect(
      await reader.oauth.authorize({
        registration,
        approvalHash: sha256Hex(code),
        codeHash: sha256Hex(fresh("poc_")),
        redirectUri: URI,
        challenge: CHALLENGE,
        resource: null,
      }),
    ).toBe(false);
  });

  it("an approval refuses a canary- name, as registering a client does", async () => {
    const pending = await registered();
    const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
    try {
      await expect(
        admin.clients.approveOAuth(
          {
            name: "canary-approved",
            runtime: "cloud",
            vendorRetention: "unknown",
            compartments: ["own"],
            views: ["self"],
            tools: ["get_self"],
          },
          registrationFingerprint(pending),
        ),
      ).rejects.toMatchObject({ code: "invalid_registration" });
      expect(await queryAs(db.urls.admin, "select 1 from policy.clients where name = 'canary-approved'", [])).toEqual(
        [],
      );
    } finally {
      await admin.close();
    }
  });

  it("an unknown fingerprint registers no client; the pending list shows each unbound registration's fingerprint", async () => {
    const pending = await registered();
    const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
    try {
      await expect(
        admin.clients.approveOAuth(
          {
            name: "unknown-print",
            runtime: "cloud",
            vendorRetention: "unknown",
            compartments: ["own"],
            views: ["self"],
            tools: ["get_self"],
          },
          "ZZZZ-ZZZZ",
        ),
      ).rejects.toMatchObject({ code: "unknown_registration" });
      expect(
        await queryAs(db.urls.admin, "select count(*)::int as n from policy.clients where name = 'unknown-print'"),
      ).toEqual([{ n: 0 }]);
      const listed = await admin.clients.pendingRegistrations();
      expect(listed).toContainEqual(
        expect.objectContaining({
          fingerprint: registrationFingerprint(pending),
          clientName: "Claude",
          redirectHosts: ["claude.ai", "localhost"],
        }),
      );
      // Typed loosely, as the owner may: lower case, no hyphen.
      const loose = registrationFingerprint(pending).replace("-", "").toLowerCase();
      expect((await admin.clients.oauthCode("bound-approval", loose)).code).toMatch(/^[0-9A-Z]{4}-/);
    } finally {
      await admin.close();
    }
  });
});
