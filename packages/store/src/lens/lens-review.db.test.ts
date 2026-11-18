import { createHash, randomBytes } from "node:crypto";
import type { MessageId } from "@intelligence/contracts/personal";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { registrationFingerprint } from "../read/oauth.ts";
import { createReader, type Reader } from "../read/read.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { readAs } from "../test-support/connections.ts";
import { createTestDatabase, queryAs, type TestDatabase } from "../test-support/database.ts";
import { eventLogger } from "../test-support/recording.ts";
import { refusedWith, registration } from "../test-support/values.ts";
import { storeSeeder } from "../test-support/world.ts";
import { createWriter, type Writer } from "../write/writer.ts";

// A device's clients in the store: a device's capture client is never counted exposed by an
// erasure; neither client of a device is given OAuth; a rotation revokes the rotated client's OAuth
// tokens; and a device's mirror client takes read tools alone. One database for the file; each test
// its own device names. pi lens add's capture-only print is apps/pi/src/intake/lens.db.test.ts's.

const TIMEOUT = 120_000;
const MINUTE = 60_000;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const OWNER = "owner.review@example.com";
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const URI = "https://claude.ai/api/mcp/auth_callback";
const fresh = (prefix: string): string => `${prefix}${randomBytes(32).toString("base64url")}`;
const request = () => ({ requestId: testId("req") });

let db: TestDatabase;
let pool: pg.Pool;
let admin: Admin;
let writer: Writer;
let reader: Reader;

beforeAll(async () => {
  db = await createTestDatabase();
  const log = eventLogger();
  pool = new pg.Pool({ connectionString: db.urls.admin, max: 2 });
  admin = new Admin({ pool, keys: db.keys, log, journal: journalPath(db.keyFile) });
  writer = createWriter({ url: db.urls.writer, keys: db.keys, log, journal: journalPath(db.keyFile) });
  reader = createReader({ url: db.urls.reader, keys: db.keys, log });
}, TIMEOUT);
afterAll(async () => {
  await reader?.close();
  await writer?.close();
  await pool?.end();
  await db?.drop();
});

const sql = <Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const idOf = async (name: string): Promise<string> =>
  (await sql<{ id: string }>("select id from policy.clients where name = $1", [name]))[0]?.id ?? "";
// A committed statement as pi_owner, for the rows no runtime role may write.
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
// An `ok` call of a client, as policy.log_call writes one under its token.
const okCall = (token: string, tool: string): Promise<unknown> =>
  readAs(db, token, (query) => query("select policy.log_call($1, 1, 'ok')", [tool]));

describe("a device's client: exposure, OAuth approval and rotation", { timeout: TIMEOUT }, () => {
  it("owner-surface, Lens R4: an erasure counts no device's capture client exposed, whatever it pushed; an agent that read is, as the control", async () => {
    const seed = storeSeeder(writer, new Date(T));
    const mailbox = await writer.ensureSourceAccount("personal", "google_mail", "own", OWNER);
    for (const n of [1, 2])
      await seed.mail(mailbox, {
        id: `review-${n}`,
        from: { address: `sender-${n}@example.org`, name: `Review Sender${n}` },
        to: [{ address: OWNER }],
        at: new Date(T - n * MINUTE),
      });
    const messages = (await sql<{ id: MessageId }>("select id from knowledge.messages order by sent_at desc, id")).map(
      (row) => row.id,
    );
    expect(messages).toHaveLength(2);

    // A device whose capture client pushed, an `ok` call under `own`.
    const { capture } = await admin.lens.addDevice("review-mac", { compartments: ["own"], views: ["self"] });
    await okCall(capture, "push_capture");
    expect(
      await sql("select outcome from policy.calls where client_id = $1", [await idOf("review-mac-capture")]),
    ).toEqual([{ outcome: "ok" }]);
    expect(
      (await admin.erasure.eraseItem({ kind: "message", id: messages[0] as MessageId }, request())).exposedClients,
    ).toBe(0);

    // The control: an agent cleared for `own` that read since is counted.
    const { token } = await admin.clients.addClient(registration("review-agent", ["own"]));
    await okCall(token, "get_self");
    expect(
      (await admin.erasure.eraseItem({ kind: "message", id: messages[1] as MessageId }, request())).exposedClients,
    ).toBe(1);
  });

  it("oauthCode refuses device_fixed for either client of a device; an agent gets a code, as the control", async () => {
    await admin.lens.addDevice("review-code", { compartments: ["own"], views: ["self"] });
    const pending = `oc_${randomBytes(24).toString("base64url")}`;
    await reader.oauth.register(pending, { redirectUris: [URI], clientName: "Claude" });
    const print = registrationFingerprint(pending);
    for (const name of ["review-code-capture", "review-code"])
      expect(await refusedWith(() => admin.clients.oauthCode(name, print)), name).toEqual({
        name: "AdminError",
        code: "device_fixed",
      });
    expect(
      await sql("select count(*)::int as n from policy.oauth_approvals where client_id = any($1)", [
        [await idOf("review-code-capture"), await idOf("review-code")],
      ]),
    ).toEqual([{ n: 0 }]);
    await admin.clients.addClient(registration("review-code-agent", ["own"]));
    expect((await admin.clients.oauthCode("review-code-agent", print)).code).toMatch(
      /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/,
    );
    expect(await refusedWith(() => admin.clients.oauthCode("review-nobody", print))).toEqual({
      name: "AdminError",
      code: "not_found",
    });
  });

  it("policy.oauth_authorize binds nothing for an approval of a device's client, written past the admin; an agent's binds, as the control", async () => {
    await admin.lens.addDevice("review-auth", { compartments: ["own"], views: ["self"] });
    await admin.clients.addClient(registration("review-auth-agent", ["own"]));
    const authorize = async (client: string): Promise<boolean> => {
      const registrationId = `oc_${randomBytes(24).toString("base64url")}`;
      await reader.oauth.register(registrationId, { redirectUris: [URI], clientName: "Claude" });
      const approval = fresh("approval-");
      // pi_admin inserts approvals, for one registration, as the admin's own functions do.
      await sql("insert into policy.oauth_approvals (code_hash, client_id, registration) values ($1, $2, $3)", [
        sha256Hex(approval),
        client,
        registrationId,
      ]);
      return reader.oauth.authorize({
        registration: registrationId,
        approvalHash: sha256Hex(approval),
        codeHash: sha256Hex(fresh("poc_")),
        redirectUri: URI,
        challenge: CHALLENGE,
        resource: null,
      });
    };
    expect(await authorize(await idOf("review-auth-capture"))).toBe(false);
    expect(await authorize(await idOf("review-auth"))).toBe(false);
    expect(await authorize(await idOf("review-auth-agent"))).toBe(true);
    expect(
      await sql("select count(*)::int as n from policy.oauth_codes where client_id = any($1)", [
        [await idOf("review-auth-capture"), await idOf("review-auth")],
      ]),
    ).toEqual([{ n: 0 }]);
  });

  it("rotateDevice revokes the rotated client's OAuth tokens in its transaction; another client's stay, and revoke_device_oauth reaches no client a device does not name", async () => {
    await admin.lens.addDevice("review-turn", { compartments: ["own"], views: ["self"] });
    await admin.clients.addClient(registration("review-turn-agent", ["own"]));
    const [mirror, other] = [await idOf("review-turn"), await idOf("review-turn-agent")];
    // Tokens as an earlier OAuth flow would have left them, written as pi_owner: the admin may not.
    const registrationId = `oc_${randomBytes(24).toString("base64url")}`;
    await asOwner("insert into policy.oauth_registrations (id, redirect_uris, client_id) values ($1, $2, $3)", [
      registrationId,
      [URI],
      mirror,
    ]);
    const tokenOf = async (client: string): Promise<string> => {
      const hash = sha256Hex(fresh("pio_"));
      await asOwner(
        "insert into policy.oauth_tokens (token_hash, kind, family, registration, client_id, expires_at) values ($1, 'access', $2, $3, $4, now() + interval '1 hour')",
        [hash, testId("fam"), registrationId, client],
      );
      return hash;
    };
    const [mirrorToken, otherToken] = [await tokenOf(mirror), await tokenOf(other)];
    const revoked = async (hash: string): Promise<boolean> =>
      (
        await sql<{ revoked: boolean }>(
          "select revoked_at is not null as revoked from policy.oauth_tokens where token_hash = $1",
          [hash],
        )
      )[0]?.revoked ?? false;

    // pi_admin may not update the tokens itself, and the function leaves an agent's alone.
    expect(
      await refusedWith(() =>
        sql("update policy.oauth_tokens set revoked_at = now() where token_hash = $1", [otherToken]),
      ),
    ).toMatchObject({ code: expect.anything() });
    expect(await sql("select ledger.revoke_device_oauth($1) as n", [other])).toEqual([{ n: 0 }]);
    expect([await revoked(mirrorToken), await revoked(otherToken)]).toEqual([false, false]);

    await admin.lens.rotateDevice("review-turn", "mirror");
    expect([await revoked(mirrorToken), await revoked(otherToken)]).toEqual([true, false]);
  });

  it("a device's mirror client takes read tools and sync_mirror alone, never record or a work tool; an agent takes a work tool, as the control", async () => {
    await admin.lens.addDevice("review-tools", { compartments: ["own"], views: ["self", "people", "work"] });
    const toolsOf = async (name: string): Promise<string[]> =>
      (await sql<{ tools: string[] }>("select tools from policy.clients where name = $1", [name]))[0]?.tools ?? [];
    await admin.clients.setTools("review-tools", ["sync_mirror", "get_self", "find_facts"]);
    expect(await toolsOf("review-tools")).toEqual(["sync_mirror", "get_self", "find_facts"]);
    for (const tools of [
      ["sync_mirror", "record"],
      ["sync_mirror", "list_opportunities"],
      ["sync_mirror", "push_capture"],
    ] as const) {
      expect(await refusedWith(() => admin.clients.setTools("review-tools", [...tools])), tools.join(",")).toEqual({
        name: "AdminError",
        code: "device_fixed",
      });
      expect(await toolsOf("review-tools")).toEqual(["sync_mirror", "get_self", "find_facts"]);
    }
    await admin.clients.addClient(
      registration("review-tools-agent", ["own"], { kind: "agent", views: ["self", "work"], tools: ["get_self"] }),
    );
    await admin.clients.setTools("review-tools-agent", ["get_self", "list_opportunities"]);
    expect(await toolsOf("review-tools-agent")).toEqual(["get_self", "list_opportunities"]);
  });
});
