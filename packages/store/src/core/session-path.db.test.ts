import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import { SourceAccountId } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Accounts, CANARY_PERSON, connect, SOLO, WORK_ONLY } from "../test-support/cast.ts";
import { RUNTIME_ROLES } from "../test-support/catalogue-grants.ts";
import { hashFingerprint, insertClient, sha256Hex, type TestClient, testId } from "../test-support/clients.ts";
import { one, readAs, session, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs, sealRow } from "../test-support/database.ts";
import { ingestMail, type MailFixture, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { seeder } from "../test-support/seeder.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { evidenceIdOf } from "../test-support/values.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";

// ledger.session_path, the two booleans the mixed_session mark is made of. Over the caller's own
// session's read log rows read at or before now, by the evidence ids in `bound` alone: `untrusted`
// when one is a web_research item or an inbound message whose sender the owner never wrote to from
// any account; `sensitive` when one item's own compartments hold an employer:<slug> not ending
// -released, or a restricted:*. A read log row's own compartments are the client's clearance and
// say nothing of what it read. Only rows within the caller's clearance count (invariant 6).
// report_move's use of it is tested in session-path-report.db.test.ts.
//
// The mail is stored through the writer, so the sender and recipient fingerprints are the ones
// the writer makes; the other evidence is seeded as pi_admin. Reads are logged through
// policy.log_read under each client's token, as the reader logs them. Reserved domains only.

type Path = { untrusted: boolean; sensitive: boolean };
const MARKED: Path = { untrusted: true, sensitive: true };
const NEITHER: Path = { untrusted: false, sensitive: false };

let store: TestStore;
let accounts: Accounts;
// Evidence ids, by what each is.
const ev = {} as Record<
  // The owner's sent reply to the canary person (with Quentin and Rhea on Cc), from `personal`.
  | "reply"
  // From the canary person, whom the reply wrote to: `own`.
  | "canary"
  // From Solo, whom the owner never wrote to: `own`.
  | "stranger"
  // From the canary person to the work account: employer-labelled, a sender written to from the
  // personal account.
  | "workCanary"
  // From the work-only person, never written to: employer-labelled.
  | "workStranger"
  // Seeded items with no message: employer, employer-released, own, restricted, and a research page.
  | "employer"
  | "released"
  | "own"
  | "restricted"
  | "web",
  string
>;
let wide: TestClient;
let other: TestClient;
let ownOnly: TestClient;
let health: TestClient;

const admin = <Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(store.db.urls.admin, text, values);
const evidenceOf = (account: SourceAccountRow, fixture: MailFixture): string =>
  evidenceIdOf(account, mailSourceId(fixture));

// One web_research item and its blob, as pi_admin, on a web account of its own.
async function webEvidence(compartment: string, url: string, text: string): Promise<string> {
  const account = SourceAccountId.parse(testId("acc"));
  await admin(
    "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, 'web', 'web_research', $3)",
    [account, compartment, [compartment]],
  );
  const blobRef = testId("blb");
  await admin("insert into vault.evidence_blobs (blob_ref, compartments, envelope) values ($1, $2, $3)", [
    blobRef,
    [compartment],
    sealRow(
      store.db.keys,
      compartment,
      { table: "vault.evidence_blobs", id: blobRef, column: "envelope" },
      Buffer.from(text).toString("base64"),
    ),
  ]);
  const at = { vault: "personal" as const, sourceAccount: account, sourceItemId: url };
  const id = evidenceIdFor({ ...at, revision: 0 });
  await admin(
    `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, next_revision_id, content_hash, media_type,
       observed_at, change_kind, participant_members, system_originated, answers_system, payload_state, compartments, readers, blob_ref, item_enc)
     values ($1, $2, 'web_research', $3, $4, 0, $5, $6, 'text/html', now(), 'live', '{}', false, false, 'present', $7, '{m-owner}', $8, $9)`,
    [
      id,
      account,
      fingerprint(store.db.keys, "source_id", url),
      fingerprint(store.db.keys, "revision_tag", sha256Hex(text)),
      evidenceIdFor({ ...at, revision: 1 }),
      hashFingerprint(store.db.keys, "content_hash", sha256Hex(text)),
      [compartment],
      blobRef,
      sealRow(
        store.db.keys,
        compartment,
        { table: "vault.evidence_items", id, column: "item_enc" },
        JSON.stringify({ sourceItemId: url, markers: ["web"] }),
      ),
    ],
  );
  return id;
}

// A session the client opens itself.
async function sessionOf(client: TestClient): Promise<string> {
  const id = testId("ses");
  await readAs(store.db, client.token, (query) => query("select policy.open_session($1)", [id]));
  return id;
}

// One read, logged as the reader logs it: its bound and shown ids, under the client's token.
const read = (client: TestClient, sessionId: string, bound: string[], shown: string[] = []): Promise<unknown> =>
  readAs(store.db, client.token, (query) =>
    query("select policy.log_read($1, 'search', $2::text[], $3::text[], '{}'::text[])", [sessionId, bound, shown]),
  );

const PATH = "select untrusted, sensitive from ledger.session_path($1)";
const pathOf = async (client: TestClient, sessionId: string): Promise<Path> =>
  one(await readAs(store.db, client.token, (query) => query<Path>(PATH, [sessionId])));

// A new session of `client` with one read per entry of `reads`, in order, and its two booleans.
async function pathAfter(client: TestClient, ...reads: string[][]): Promise<Path> {
  const sessionId = await sessionOf(client);
  for (const bound of reads) await read(client, sessionId, bound);
  return pathOf(client, sessionId);
}

beforeAll(async () => {
  // The released compartment needs a key of its own.
  store = await openStore({ compartments: ["own", "employer:example", "employer:example-released"] });
  accounts = await connect(store.writer);
  for (const fixture of [MAIL.reply, MAIL.canary, MAIL.solo])
    expect(await ingestMail(store.writer, accounts.personalMail, fixture), fixture.id).toBe("stored");
  for (const fixture of [MAIL.workCanary, MAIL.workOnly])
    expect(await ingestMail(store.writer, accounts.workMail, fixture), fixture.id).toBe("stored");
  ev.reply = evidenceOf(accounts.personalMail, MAIL.reply);
  ev.canary = evidenceOf(accounts.personalMail, MAIL.canary);
  ev.stranger = evidenceOf(accounts.personalMail, MAIL.solo);
  ev.workCanary = evidenceOf(accounts.workMail, MAIL.workCanary);
  ev.workStranger = evidenceOf(accounts.workMail, MAIL.workOnly);
  await session(store.db.urls.admin, async (query) => {
    const seed = seeder(store.db, query);
    // An account holds one compartment; a restricted item is an own account's item labelled as a screen labels it.
    const item = async (compartments: string[]) =>
      seed.evidence(compartments, await seed.sourceAccount(compartments.slice(0, 1)));
    ev.employer = await item(["employer:example"]);
    ev.released = await item(["employer:example-released"]);
    ev.own = await item(["own"]);
    ev.restricted = await item(["own", "restricted:health"]);
  });
  ev.web = await webEvidence("own", "https://pages.example/session-path", "A page the system fetched.");

  wide = await insertClient(store.db, "path-wide", ["own", "employer:example", "employer:example-released"]);
  other = await insertClient(store.db, "path-other", ["own", "employer:example"]);
  ownOnly = await insertClient(store.db, "path-own", ["own"]);
  health = await insertClient(store.db, "path-health", ["own", "restricted:health"]);
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store?.close();
});

describe("ledger.session_path", { timeout: DB_TEST_TIMEOUT }, () => {
  // The plan's first check: the mark compares the two fingerprints, so they must agree.
  it("a sender the owner wrote to has the fingerprint of the recipient row the writer made", async () => {
    const [recipient] = await admin<{ fp: string }>(
      "select address_fp as fp from vault.sent_recipients where evidence_id = $1 and address_fp = $2",
      [ev.reply, fingerprint(store.db.keys, "address", CANARY_PERSON.address)],
    );
    const [sender] = await admin<{ fp: string }>(
      "select sender_fp as fp from knowledge.messages where evidence_id = $1",
      [ev.canary],
    );
    expect(recipient?.fp).toBeDefined();
    expect(sender?.fp).toBe(recipient?.fp);
    // The control: Solo's and the work-only person's senders are no recipient row's.
    for (const [evidence, who] of [
      [ev.stranger, SOLO],
      [ev.workStranger, WORK_ONLY],
    ] as const) {
      const [row] = await admin<{ fp: string; written: boolean }>(
        "select m.sender_fp as fp, exists (select 1 from vault.sent_recipients t where t.address_fp = m.sender_fp) as written from knowledge.messages m where m.evidence_id = $1",
        [evidence],
      );
      expect(row, who.address).toEqual({ fp: fingerprint(store.db.keys, "address", who.address), written: false });
    }
  });

  it("a stranger's message read and an employer row read, in either order, before the report, mark it", async () => {
    expect(await pathAfter(wide, [ev.stranger], [ev.employer])).toEqual(MARKED);
    expect(await pathAfter(wide, [ev.employer], [ev.stranger])).toEqual(MARKED);
    // In one read, and a stranger's message that is itself employer-labelled.
    expect(await pathAfter(wide, [ev.own, ev.employer, ev.stranger])).toEqual(MARKED);
    expect(await pathAfter(wide, [ev.workStranger])).toEqual(MARKED);
    // Each alone answers its own boolean.
    expect(await pathAfter(wide, [ev.stranger])).toEqual({ untrusted: true, sensitive: false });
    expect(await pathAfter(wide, [ev.employer])).toEqual({ untrusted: false, sensitive: true });
    // A session with no reads answers neither.
    expect(await pathAfter(wide)).toEqual(NEITHER);
  });

  it("the same reads after the report do not", async () => {
    const sessionId = await sessionOf(wide);
    // The report's transaction began before the reads: its now() is earlier than their read_at.
    const atReport = await readAs(store.db, wide.token, async (query) => {
      await query("select now()");
      await read(wide, sessionId, [ev.stranger]);
      await read(wide, sessionId, [ev.employer]);
      return one(await query<Path>(PATH, [sessionId]));
    });
    expect(atReport).toEqual(NEITHER);
    // The control: a report after them is marked.
    expect(await pathOf(wide, sessionId)).toEqual(MARKED);
  });

  it("an employer-released row, an own row, or a message from someone the owner wrote to does not", async () => {
    expect(await pathAfter(wide, [ev.stranger], [ev.released])).toEqual({ untrusted: true, sensitive: false });
    expect(await pathAfter(wide, [ev.stranger], [ev.own])).toEqual({ untrusted: true, sensitive: false });
    expect(await pathAfter(wide, [ev.canary], [ev.employer])).toEqual({ untrusted: false, sensitive: true });
    // The owner's own sent message is not inbound.
    expect(await pathAfter(wide, [ev.reply], [ev.employer])).toEqual({ untrusted: false, sensitive: true });
    // Written to from any account: the canary person, written to from `personal`, writing to the
    // work account, is not a stranger there.
    expect(await pathAfter(wide, [ev.workCanary])).toEqual({ untrusted: false, sensitive: true });
    // The positive control in the same client: the stranger and the employer row mark it.
    expect(await pathAfter(wide, [ev.stranger], [ev.employer])).toEqual(MARKED);
  });

  it("a client cleared for an employer compartment that reads only own-labelled evidence and a stranger's message is not marked", async () => {
    const sessionId = await sessionOf(wide);
    await read(wide, sessionId, [ev.own]);
    await read(wide, sessionId, [ev.stranger]);
    // Its read log rows carry its clearance, employer:example among it...
    const rows = await admin<{ compartments: string[] }>(
      "select compartments from ledger.read_log where session_id = $1 order by id",
      [sessionId],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.compartments).toContain("employer:example");
    // ...and that is no sensitive read.
    expect(await pathOf(wide, sessionId)).toEqual({ untrusted: true, sensitive: false });
  });

  it("a web_research item read counts as untrusted", async () => {
    expect(await pathAfter(wide, [ev.web])).toEqual({ untrusted: true, sensitive: false });
    expect(await pathAfter(wide, [ev.web], [ev.employer])).toEqual(MARKED);
    expect(await pathAfter(wide, [ev.employer], [ev.web])).toEqual(MARKED);
  });

  it("a restricted row read counts as sensitive", async () => {
    expect(await pathAfter(health, [ev.restricted])).toEqual({ untrusted: false, sensitive: true });
    expect(await pathAfter(health, [ev.stranger], [ev.restricted])).toEqual(MARKED);
    // The control: the same client's own row is not.
    expect(await pathAfter(health, [ev.stranger], [ev.own])).toEqual({ untrusted: true, sensitive: false });
  });

  it("only bound counts: an id in shown, or an agent record's id, counts for neither", async () => {
    const shownOnly = await sessionOf(wide);
    await read(wide, shownOnly, [ev.stranger], [ev.employer, ev.web]);
    expect(await pathOf(wide, shownOnly)).toEqual({ untrusted: true, sensitive: false });
    const noEvidence = await sessionOf(wide);
    await read(wide, noEvidence, [], [ev.stranger, ev.employer]);
    expect(await pathOf(wide, noEvidence)).toEqual(NEITHER);
    expect(await pathAfter(wide, [testId("rec"), testId("rec")])).toEqual(NEITHER);
    const withRecord = await sessionOf(wide);
    await read(wide, withRecord, [testId("rec"), ev.employer], [ev.stranger]);
    expect(await pathOf(wide, withRecord)).toEqual({ untrusted: false, sensitive: true });
  });

  it("evidence outside the caller's clearance changes nothing (invariant 6)", async () => {
    // A client cleared for `own` alone, whose reads name employer-labelled ids it cannot see.
    expect(await pathAfter(ownOnly, [ev.stranger], [ev.employer])).toEqual({ untrusted: true, sensitive: false });
    expect(await pathAfter(ownOnly, [ev.workStranger])).toEqual(NEITHER);
    expect(await pathAfter(ownOnly, [ev.restricted], [ev.web])).toEqual({ untrusted: true, sensitive: false });
    // The control: the same reads by a client cleared for them.
    expect(await pathAfter(wide, [ev.workStranger])).toEqual(MARKED);
    expect(await pathAfter(health, [ev.restricted], [ev.web])).toEqual(MARKED);
  });

  it("another client's session is refused", async () => {
    const theirs = await sessionOf(other);
    await read(other, theirs, [ev.stranger], [ev.employer]);
    expect(await sqlState(() => readAs(store.db, wide.token, (query) => query(PATH, [theirs])))).toBe("42501");
    // No current client, and a session no client opened.
    expect(await sqlState(() => readAs(store.db, null, (query) => query(PATH, [theirs])))).toBe("42501");
    expect(await sqlState(() => readAs(store.db, wide.token, (query) => query(PATH, [testId("ses")])))).toBe("42501");
    // The control: each client's own session.
    expect(await pathOf(other, theirs)).toEqual({ untrusted: true, sensitive: false });
    const mine = await sessionOf(wide);
    expect(await sqlState(() => readAs(store.db, wide.token, (query) => query(PATH, [mine])))).toBeNull();
  });

  it("the function returns booleans only", async () => {
    const row = one(
      await admin<{
        result: string;
        args: string;
        set: boolean;
        definer: boolean;
        volatility: string;
        owner: string;
        config: string[] | null;
        public: boolean;
      }>(
        `select pg_get_function_result(p.oid) as result, pg_get_function_identity_arguments(p.oid) as args, p.proretset as set, p.prosecdef as definer,
                p.provolatile::text as volatility, pg_get_userbyid(p.proowner)::text as owner, p.proconfig::text[] as config,
                coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), true) as public
         from pg_proc p where p.oid = to_regprocedure('ledger.session_path(text)')`,
      ),
    );
    expect(row).toMatchObject({
      result: "TABLE(untrusted boolean, sensitive boolean)",
      args: "session_id text",
      set: true,
      definer: true,
      volatility: "s",
      owner: "pi_owner",
      public: false,
    });
    expect((row.config ?? []).map((setting) => setting.replaceAll(/[\s"]/g, ""))).toEqual([
      "search_path=pg_catalog,policy,pg_temp",
    ]);
    // Every output column is a boolean.
    const columns = await admin<{ name: string; type: string }>(
      `select a.name, format_type(a.type, null) as type
       from pg_proc p cross join lateral unnest(p.proargnames, p.proallargtypes::oid[], p.proargmodes::text[]) as a (name, type, mode)
       where p.oid = to_regprocedure('ledger.session_path(text)') and a.mode = 't' order by a.name`,
    );
    expect(columns).toEqual([
      { name: "sensitive", type: "boolean" },
      { name: "untrusted", type: "boolean" },
    ]);
    // pi_reader alone executes it.
    for (const role of RUNTIME_ROLES) {
      const [can] = await admin<{ ok: boolean }>(
        "select has_function_privilege($1, 'ledger.session_path(text)', 'EXECUTE') as ok",
        [role],
      );
      expect(can?.ok, role).toBe(role === "pi_reader");
    }
  });
});
