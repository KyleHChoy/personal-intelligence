import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorCursor, type SourceDeletion } from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import {
  type AgentRecordArgs,
  type AgentRecordKind,
  type CardId,
  type NewCard,
  type PersonalTool,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import type { Keys } from "../core/keys.ts";
import { raiseCard } from "../core/queue.ts";
import { openUnder, sealUnder } from "../core/seal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { Reader } from "../read/read.ts";
import { type Accounts, connect, QUENTIN } from "../test-support/cast.ts";
import { ALL_VIEWS, hashFingerprint, sha256Hex, testId } from "../test-support/clients.ts";
import { addOwnerAddressUnderived, one, type Query, readAs, session } from "../test-support/connections.ts";
import { queryAs, scanForPlaintext } from "../test-support/database.ts";
import {
  derive,
  eventItem,
  ingestEvent,
  ingestMail,
  type MailFixture,
  mail,
  mailFacts,
  mailRevision,
  mailSourceId,
  NOW,
} from "../test-support/items.ts";
import { EVENTS, MAIL } from "../test-support/items-named.ts";
import { exposuresOf, memoryClient, projectionOf, serve, served } from "../test-support/memory-fixtures.ts";
import { insideHold, recordingLogger, recordingPool, recordingStatements } from "../test-support/recording.ts";
import { lines, snapshot } from "../test-support/snapshot.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue, registration } from "../test-support/values.ts";
import { createWriter, type Writer } from "./writer.ts";
import { RESTING, removeResting } from "./writer-records.ts";

// Intake of agent records into the vault, and their removal with deleted evidence. Agent records
// are written through the reader's `record`, each Reader a process and so a session of its own.
// Where a read log row is needed that these tools do not write (a pack's), it is written through
// `policy.log_read` under a tool that binds nothing.

const CLIENTS = ["alpha", "beta", "gamma", "delta", "keyless"];
const COMPARTMENTS = [
  "own",
  "employer:example",
  ...CLIENTS.filter((name) => name !== "keyless").map((name) => `agent:${name}`),
  "agent:keyless",
];
const TOOLS = ["get_self", "find_messages", "read_message", "find_facts", "record"] as PersonalTool[];
const NO_EVIDENCE = "f".repeat(64);

type Item = { id: string; evidence: string };
type World = {
  store: TestStore;
  accounts: Accounts;
  admin: Admin;
  writer: Writer;
  keys: Keys;
  canary: Item;
  solo: Item;
  event: Item;
  // A token for each client, registered with record.
  token: (name: string) => Promise<string>;
};

// The same keys without one compartment.
const without = (keys: Keys, compartment: string): Keys => ({
  compartments: new Map([...keys.compartments].filter(([name]) => name !== compartment)),
  fingerprintKey: keys.fingerprintKey,
});

async function itemOf(
  db: TestStore["db"],
  keys: Keys,
  table: "messages" | "events",
  sourceItemId: string,
): Promise<Item> {
  const [row] = await queryAs<{ id: string; evidence_id: string }>(
    db.urls.admin,
    `select k.id, k.evidence_id from knowledge.${table} k join vault.evidence_items e on e.id = k.evidence_id where e.source_item_fp = $1`,
    [hashFingerprint(keys, "source_id", sourceItemId)],
  );
  if (row === undefined) throw new Error("the item is not stored");
  return { id: row.id, evidence: row.evidence_id };
}

// A store with the owner's personal mail and calendar: the canary message, Solo's message and
// the canary event, under `own`.
async function inWorld(fn: (world: World) => Promise<void>): Promise<void> {
  const store = await openStore({ compartments: COMPARTMENTS });
  try {
    const { db, writer } = store;
    const accounts = await connect(writer);
    await ingestMail(writer, accounts.personalMail, MAIL.canary);
    await ingestMail(writer, accounts.personalMail, MAIL.solo);
    await ingestEvent(writer, accounts.personalCalendar, EVENTS.canary);
    const admin = new Admin({ pool: store.adminPool, keys: db.keys, log: store.log, recordEnabled: true });
    const tokens = new Map<string, string>();
    await fn({
      store,
      accounts,
      admin,
      writer,
      keys: db.keys,
      canary: await itemOf(db, db.keys, "messages", mailSourceId(MAIL.canary)),
      solo: await itemOf(db, db.keys, "messages", mailSourceId(MAIL.solo)),
      event: await itemOf(db, db.keys, "events", eventItem(EVENTS.canary, accounts.personalCalendar).sourceItemId),
      token: async (name) => {
        const known = tokens.get(name);
        if (known !== undefined) return known;
        const { token } = await admin.clients.addClient(
          registration(name, ["own"], { tools: TOOLS, views: ALL_VIEWS as never }),
        );
        tokens.set(name, token);
        return token;
      },
    });
  } finally {
    await store.close();
  }
}

// A new process: a reader with no session for any client.
const newSession = (world: World): Reader =>
  new Reader({ pool: world.store.readerPool, keys: world.keys, log: world.store.log });

let requests = 0;
async function write(
  world: World,
  reader: Reader,
  client: string,
  over: Partial<AgentRecordArgs> & { kind?: AgentRecordKind } = {},
): Promise<string> {
  requests += 1;
  const args: AgentRecordArgs = {
    kind: "note",
    body: `an agent record, number ${requests}`,
    requestId: `request-${String(requests).padStart(8, "0")}`,
    ...over,
  };
  return outcomeValue(await reader.record(await world.token(client), args)).recordId;
}

type Row = {
  id: string;
  body: boolean;
  evidence_id: string | null;
  refused_code: string | null;
  tainted_at: Date | null;
  content_fp: string;
  cites: string[];
  session_id: string;
  client_id: string;
};
const rowOf = async (world: World, id: string): Promise<Row> => {
  const [row] = await queryAs<Row>(
    world.store.db.urls.admin,
    "select id, body_enc is not null as body, evidence_id, refused_code, tainted_at, content_fp, cites, session_id, client_id from ledger.agent_writes where id = $1",
    [id],
  );
  if (row === undefined) throw new Error("no such agent record");
  return row;
};
const agentEvidence = (world: World): Promise<{ id: string }[]> =>
  queryAs(
    world.store.db.urls.admin,
    "select id from vault.evidence_items where source_kind = 'agent_record' order by id",
  );
const blobsOf = async (world: World): Promise<number> =>
  (await queryAs<{ n: number }>(world.store.db.urls.admin, "select count(*)::int as n from vault.evidence_blobs"))[0]
    ?.n ?? 0;
// Removed: no body, no evidence row and no blob of its own.
async function expectRemoved(world: World, id: string): Promise<void> {
  const row = await rowOf(world, id);
  expect(row.body, id).toBe(false);
  expect(row.tainted_at, id).toBeInstanceOf(Date);
  if (row.evidence_id !== null)
    expect(
      await queryAs(world.store.db.urls.admin, "select id from vault.evidence_items where id = $1", [row.evidence_id]),
    ).toEqual([]);
}
const expectKept = async (world: World, id: string): Promise<void> => {
  const row = await rowOf(world, id);
  expect(row.body, id).toBe(true);
  expect(row.tainted_at, id).toBeNull();
};

const deletionOf = (world: World, fixture: MailFixture): SourceDeletion =>
  ({ sourceAccount: world.accounts.personalMail.id, sourceItemId: mailSourceId(fixture) }) as SourceDeletion;
const deleteMail = (world: World, fixture: MailFixture) =>
  world.writer.applyDeletion(world.accounts.personalMail, deletionOf(world, fixture));
// A complete listing of the personal mailbox that names only these.
const reconcileMail = (world: World, kept: MailFixture[]) =>
  world.writer.finishPage(world.accounts.personalMail, {
    listing: { first: true, ended: "complete" },
    listedIds: kept.map(mailSourceId),
    skippedIds: [],
    next: ConnectorCursor.parse(`cursor-${testId("c")}`),
  });

// One read log row written as the client, through the function the reader calls.
async function logRead(
  world: World,
  client: string,
  tool: string,
  lists: { bound?: string[]; shown?: string[] },
): Promise<void> {
  const [row] = await queryAs<{ id: string }>(
    world.store.db.urls.admin,
    "select s.id from ledger.sessions s join policy.clients c on c.id = s.client_id where c.name = $1 order by s.started_at desc, s.id desc limit 1",
    [client],
  );
  const sessionId = row?.id ?? testId("ses");
  await readAs(world.store.db, await world.token(client), async (query) => {
    if (row === undefined) await query("select policy.open_session($1)", [sessionId]);
    await query("select policy.log_read($1, $2, $3, $4, $5)", [
      sessionId,
      tool,
      lists.bound ?? [],
      lists.shown ?? [],
      [],
    ]);
  });
}

// As pi_owner, with row security not forced for the one statement on these tables: what no
// runtime role can do, done by the test itself to leave a row as a race would.
async function asTableOwner(world: World, tables: string[], sql: string, values: unknown[] = []): Promise<void> {
  await session(world.store.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    for (const table of tables) await query(`alter table ${table} no force row level security`);
    try {
      await query(sql, values);
    } finally {
      for (const table of tables) await query(`alter table ${table} force row level security`);
    }
  });
}

const ZERO = { taken: 0, removed: 0, refused: 0, waiting: 0 };

describe("takeRecords", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an agent record is taken in once: one evidence row, one blob, and its evidence_id set", () =>
    inWorld(async (world) => {
      const id = await write(world, newSession(world), "alpha", { cites: [world.canary.id as never] });
      const blobs = await blobsOf(world);
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 1 });
      const evidence = await agentEvidence(world);
      expect(evidence).toHaveLength(1);
      expect(await blobsOf(world)).toBe(blobs + 1);
      expect((await rowOf(world, id)).evidence_id).toBe(evidence[0]?.id);
    }));

  it("its evidence row carries the agent record's own label, its time and the keyed fingerprint of its body", () =>
    inWorld(async (world) => {
      const body = "the label, the time and the fingerprint";
      const id = await write(world, newSession(world), "alpha", { body });
      await world.writer.takeRecords();
      const [stored] = await queryAs<{ compartments: string[]; created_at: Date }>(
        world.store.db.urls.admin,
        "select compartments, created_at from ledger.agent_writes where id = $1",
        [id],
      );
      const [evidence] = await queryAs<{ compartments: string[]; observed_at: Date; content_hash: string }>(
        world.store.db.urls.admin,
        "select compartments, observed_at, content_hash from vault.evidence_items where id = $1",
        [(await rowOf(world, id)).evidence_id],
      );
      expect(evidence?.compartments).toEqual(["agent:alpha", "own"]);
      expect(evidence?.compartments).toEqual(stored?.compartments);
      expect(evidence?.observed_at.getTime()).toBe(stored?.created_at.getTime());
      expect(evidence?.content_hash).toBe(hashFingerprint(world.keys, "content_hash", sha256Hex(body)));
    }));

  it("every column of the evidence row is as expected, with answers_system false, hold_released_at null and blob_ref the blob's, and the first insert does not fail 23502", () =>
    inWorld(async (world) => {
      const body = "every column";
      const id = await write(world, newSession(world), "alpha", { body, cites: [world.canary.id as never] });
      // The first intake there is takes it: no column is left null that must not be.
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 1 });
      const row = await rowOf(world, id);
      const [account] = await queryAs<{ id: string }>(
        world.store.db.urls.admin,
        "select id from vault.source_accounts where label = 'agent:alpha' and connector = 'agent'",
      );
      const [created] = await queryAs<{ created_at: Date; compartments: string[] }>(
        world.store.db.urls.admin,
        "select created_at, compartments from ledger.agent_writes where id = $1",
        [id],
      );
      const source = {
        vault: "personal" as const,
        sourceAccount: SourceAccountId.parse(account?.id),
        sourceItemId: `record:${id}`,
      };
      const [evidence] = await queryAs<Record<string, unknown>>(
        world.store.db.urls.admin,
        "select * from vault.evidence_items where id = $1",
        [row.evidence_id],
      );
      const blobRef = evidence?.blob_ref;
      const [blob] = await queryAs<{ blob_ref: string; compartments: string[] }>(
        world.store.db.urls.admin,
        "select blob_ref, compartments from vault.evidence_blobs where blob_ref = $1",
        [blobRef],
      );
      expect(blob).toEqual({ blob_ref: blobRef, compartments: ["agent:alpha", "own"] });
      expect({
        ...evidence,
        item_enc: typeof evidence?.item_enc,
        ingested_at: evidence?.ingested_at instanceof Date,
      }).toEqual({
        id: evidenceIdFor({ ...source, revision: 0 }),
        source_account_id: account?.id,
        source_kind: "agent_record",
        source_item_fp: hashFingerprint(world.keys, "source_id", `record:${id}`),
        revision_tag_fp: fingerprint(world.keys, "revision_tag", id),
        revision: 0,
        supersedes: null,
        next_revision_id: evidenceIdFor({ ...source, revision: 1 }),
        thread_fp: null,
        content_hash: row.content_fp,
        media_type: "text/plain",
        observed_at: created?.created_at,
        ingested_at: true,
        change_kind: "live",
        headers_only: false,
        participant_members: [],
        sender_member: null,
        system_originated: false,
        answers_system: false,
        sent_id: null,
        hold_released_at: null,
        expired_at: null,
        model_hold_at: null,
        recovery_screened_at: null,
        payload_state: "present",
        compartments: created?.compartments,
        readers: [THE_OWNER],
        blob_ref: blobRef,
        item_enc: "object",
        // An untyped record taken in by intake is not a typed one.
        typed: false,
        // A fill's fingerprints, set only on a research fill's row.
        fill_identity_fp: null,
        fill_domain_fp: null,
      });
      expect(row.content_fp).toBe(hashFingerprint(world.keys, "content_hash", sha256Hex(body)));
    }));

  it("the blob opens to the body, and item_enc to the record item", () =>
    inWorld(async (world) => {
      const body = "the blob's body, opened again";
      const reader = newSession(world);
      const id = await write(world, reader, "alpha", {
        kind: "finding",
        body,
        cites: [world.canary.id as never, world.event.id as never],
      });
      await world.writer.takeRecords();
      const row = await rowOf(world, id);
      const [evidence] = await queryAs<{ blob_ref: string; item_enc: unknown; compartments: string[] }>(
        world.store.db.urls.admin,
        "select blob_ref, item_enc, compartments from vault.evidence_items where id = $1",
        [row.evidence_id],
      );
      const [blob] = await queryAs<{ envelope: unknown }>(
        world.store.db.urls.admin,
        "select envelope from vault.evidence_blobs where blob_ref = $1",
        [evidence?.blob_ref],
      );
      const compartments = evidence?.compartments ?? [];
      // Its UTF-8 bytes, base64, as every blob holds its payload.
      const opened = openUnder(
        world.keys,
        compartments,
        { table: "vault.evidence_blobs", id: evidence?.blob_ref ?? "", column: "envelope" },
        blob?.envelope as never,
      );
      expect(Buffer.from(opened, "base64").toString("utf8")).toBe(body);
      const [stored] = await queryAs<{ created_at: Date }>(
        world.store.db.urls.admin,
        "select created_at from ledger.agent_writes where id = $1",
        [id],
      );
      expect(
        JSON.parse(
          openUnder(
            world.keys,
            compartments,
            { table: "vault.evidence_items", id: row.evidence_id ?? "", column: "item_enc" },
            evidence?.item_enc as never,
          ),
        ),
      ).toEqual({
        recordId: id,
        client: "alpha",
        session: row.session_id,
        kind: "finding",
        recordedAt: stored?.created_at.toISOString(),
        cites: [world.canary.evidence, world.event.evidence],
      });
    }));

  it("takeRecords twice takes nothing the second time", () =>
    inWorld(async (world) => {
      await write(world, newSession(world), "alpha");
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 1 });
      const before = lines(await snapshot(world.store.db));
      expect(await world.writer.takeRecords()).toEqual(ZERO);
      expect(lines(await snapshot(world.store.db))).toEqual(before);
    }));

  it("an unreadable body is retained and retryable, other rows proceed, and restoring its envelope permits intake", () =>
    inWorld(async (world) => {
      const reader = newSession(world);
      const id = await write(world, reader, "alpha");
      const other = await write(world, reader, "alpha");
      const [original] = await queryAs<{ body_enc: unknown }>(
        world.store.db.urls.admin,
        "select body_enc from ledger.agent_writes where id = $1",
        [id],
      );
      // Another row's envelope: bound to that row, it opens nowhere else.
      await queryAs(
        world.store.db.urls.admin,
        "update ledger.agent_writes set body_enc = (select body_enc from ledger.agent_writes where id = $2) where id = $1",
        [id, other],
      );
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 1, waiting: 1 });
      expect(await rowOf(world, id)).toMatchObject({
        body: true,
        refused_code: null,
        evidence_id: null,
        tainted_at: null,
      });
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, waiting: 1 });
      await queryAs(world.store.db.urls.admin, "update ledger.agent_writes set body_enc = $2 where id = $1", [
        id,
        original?.body_enc,
      ]);
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 1 });
    }));

  it("a limit-one intake rotates unreadable rows so later valid and repaired records advance", () =>
    inWorld(async (world) => {
      const reader = newSession(world);
      const ids = [
        await write(world, reader, "alpha"),
        await write(world, reader, "alpha"),
        await write(world, reader, "alpha"),
      ];
      const rows = await queryAs<{ id: string; body_enc: unknown }>(
        world.store.db.urls.admin,
        "select id, body_enc from ledger.agent_writes where id = any($1) order by created_at, id",
        [ids],
      );
      const [first, second, valid] = rows;
      if (first === undefined || second === undefined || valid === undefined) throw new Error("missing records");
      await queryAs(world.store.db.urls.admin, "update ledger.agent_writes set body_enc = $2 where id = any($1)", [
        [first.id, second.id],
        valid.body_enc,
      ]);
      expect(await world.writer.takeRecords(1)).toEqual({ ...ZERO, waiting: 1 });
      expect(await world.writer.takeRecords(1)).toEqual({ ...ZERO, waiting: 1 });
      expect(await world.writer.takeRecords(1)).toEqual({ ...ZERO, taken: 1 });
      expect(await rowOf(world, first.id)).toMatchObject({ body: true, evidence_id: null, tainted_at: null });
      await queryAs(world.store.db.urls.admin, "update ledger.agent_writes set body_enc = $2 where id = $1", [
        second.id,
        second.body_enc,
      ]);
      expect(await world.writer.takeRecords(1)).toEqual({ ...ZERO, waiting: 1 });
      expect(await world.writer.takeRecords(1)).toEqual({ ...ZERO, taken: 1 });
      expect(await rowOf(world, second.id)).toMatchObject({ body: true, refused_code: null });
    }));

  it("a body that does not match its fingerprint is marked content_mismatch, keeps its body, and is not selected again", () =>
    inWorld(async (world) => {
      const id = await write(world, newSession(world), "alpha", { body: "the body that was fingerprinted" });
      const { compartments } = (
        await queryAs<{ compartments: string[] }>(
          world.store.db.urls.admin,
          "select compartments from ledger.agent_writes where id = $1",
          [id],
        )
      )[0] ?? { compartments: [] };
      const swapped = sealUnder(
        world.keys,
        compartments,
        { table: "ledger.agent_writes", id, column: "body_enc" },
        "another body under the same binding",
      );
      await queryAs(world.store.db.urls.admin, "update ledger.agent_writes set body_enc = $2 where id = $1", [
        id,
        swapped,
      ]);
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, refused: 1 });
      expect(await rowOf(world, id)).toMatchObject({
        body: true,
        refused_code: "content_mismatch",
        evidence_id: null,
        tainted_at: null,
      });
      expect(await world.writer.takeRecords()).toEqual(ZERO);
      expect(await agentEvidence(world)).toEqual([]);
    }));

  // The row is made a proposal by the table's owner, as the reader's propose_about_you would leave
  // it, with a body sealed and fingerprinted as that call does.
  async function asProposal(world: World, body: string, scope: "all" | "this_client"): Promise<string> {
    const id = await write(world, newSession(world), "alpha");
    const { compartments } = (
      await queryAs<{ compartments: string[] }>(
        world.store.db.urls.admin,
        "select compartments from ledger.agent_writes where id = $1",
        [id],
      )
    )[0] ?? { compartments: [] };
    const sealed = sealUnder(world.keys, compartments, { table: "ledger.agent_writes", id, column: "body_enc" }, body);
    await asTableOwner(
      world,
      ["ledger.agent_writes"],
      "update ledger.agent_writes set kind = 'proposal', tool = 'propose_about_you', proposal_scope = $2, body_enc = $3, content_fp = $4 where id = $1",
      [id, scope, sealed, fingerprint(world.keys, "content_hash", sha256Hex(body))],
    );
    return id;
  }
  const PROPOSAL = '{"fields":{"polarity":"prefers","what":"window seats"},"kind":"preference","scope":"all"}';

  it("a proposal whose body parses is taken in; one that does not, or whose scope is not its row's, is refused content_mismatch", () =>
    inWorld(async (world) => {
      const good = await asProposal(world, PROPOSAL, "all");
      const bad = await asProposal(
        world,
        '{"fields":{"polarity":"adores","what":"window seats"},"kind":"preference","scope":"all"}',
        "all",
      );
      const extra = await asProposal(
        world,
        '{"fields":{"polarity":"prefers","what":"window seats"},"kind":"preference","requestId":"abcdefgh","scope":"all"}',
        "all",
      );
      const scoped = await asProposal(world, PROPOSAL, "this_client");
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 1, refused: 3 });
      expect((await rowOf(world, good)).evidence_id).not.toBeNull();
      for (const id of [bad, extra, scoped])
        expect(await rowOf(world, id)).toMatchObject({
          body: true,
          refused_code: "content_mismatch",
          evidence_id: null,
        });
    }));

  it("a row whose label holds a compartment the keys lack is counted as waiting, no key is tried, and a later row is still taken", () =>
    inWorld(async (world) => {
      const reader = newSession(world);
      const waits = await write(world, reader, "keyless");
      const taken = await write(world, reader, "alpha");
      const lacking = createWriter({
        url: world.store.db.urls.writer,
        keys: without(world.keys, "agent:keyless"),
        log: recordingLogger().log,
      });
      try {
        expect(await lacking.takeRecords()).toEqual({ ...ZERO, taken: 1, waiting: 1 });
        expect(await lacking.takeRecords()).toEqual({ ...ZERO, waiting: 1 });
      } finally {
        await lacking.close();
      }
      expect(await rowOf(world, waits)).toMatchObject({ body: true, evidence_id: null, refused_code: null });
      expect((await rowOf(world, taken)).evidence_id).not.toBeNull();
      // With its key it is taken.
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 1 });
    }));

  it("501 rows that wait for a key do not hold back a row that can be taken", () =>
    inWorld(async (world) => {
      const reader = newSession(world);
      const first = await write(world, reader, "keyless");
      // 500 more of the same client, older than any other row, written as the table's owner:
      // the daily bound would refuse them through the function.
      await asTableOwner(
        world,
        ["ledger.agent_writes"],
        `insert into ledger.agent_writes (id, client_id, client_name, session_id, request_id, tool, kind, created_at, compartments, writer_views, content_fp, cites_fp, cites, body_enc)
         select 'rec_' || lpad(upper(to_hex(n)), 26, '0'), w.client_id, w.client_name, w.session_id, 'bulk-request-' || n, 'record', 'note',
           w.created_at - make_interval(secs => n), w.compartments, w.writer_views, w.content_fp, w.cites_fp, '{}', w.body_enc
         from ledger.agent_writes w, generate_series(1, 500) as n where w.id = $1`,
        [first],
      );
      const later = await write(world, reader, "alpha");
      const lacking = createWriter({
        url: world.store.db.urls.writer,
        keys: without(world.keys, "agent:keyless"),
        log: recordingLogger().log,
      });
      try {
        expect(await lacking.takeRecords()).toEqual({ ...ZERO, taken: 1, waiting: 501 });
      } finally {
        await lacking.close();
      }
      expect((await rowOf(world, later)).evidence_id).not.toBeNull();
    }));

  it("a client with no agent account marks the row no_account", () =>
    inWorld(async (world) => {
      const id = await write(world, newSession(world), "alpha");
      await queryAs(world.store.db.urls.admin, "delete from vault.source_accounts where label = 'agent:alpha'");
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, refused: 1 });
      expect(await rowOf(world, id)).toMatchObject({ body: true, refused_code: "no_account", evidence_id: null });
      expect(await world.writer.takeRecords()).toEqual(ZERO);
    }));

  it("a row with no body is never taken", () =>
    inWorld(async (world) => {
      const id = await write(world, newSession(world), "alpha");
      await queryAs(
        world.store.db.urls.admin,
        "update ledger.agent_writes set body_enc = null, tainted_at = now() where id = $1",
        [id],
      );
      expect(await world.writer.takeRecords()).toEqual(ZERO);
      expect((await rowOf(world, id)).evidence_id).toBeNull();
      expect(await agentEvidence(world)).toEqual([]);
    }));

  it("a row that cites an evidence id the vault does not hold is removed, not taken in", () =>
    inWorld(async (world) => {
      const id = await write(world, newSession(world), "alpha", { cites: [world.canary.id as never] });
      // As a race leaves it: appended while the cited message was being deleted.
      await asTableOwner(world, ["ledger.agent_writes"], "update ledger.agent_writes set cites = $2 where id = $1", [
        id,
        [NO_EVIDENCE],
      ]);
      const control = await write(world, newSession(world), "beta", { cites: [world.canary.id as never] });
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 1, removed: 1 });
      await expectRemoved(world, id);
      expect((await rowOf(world, id)).evidence_id).toBeNull();
      expect((await rowOf(world, control)).evidence_id).not.toBeNull();
    }));

  it("a row whose session had read, before it was written, a message the vault no longer holds is removed, not taken in, and one whose session read it afterwards is taken", () =>
    inWorld(async (world) => {
      const before = newSession(world);
      const after = newSession(world);
      // alpha reads the message, then the message is deleted, then alpha writes: the race.
      expect((await before.readMessage(await world.token("alpha"), { id: world.canary.id as never })).ok).toBe(true);
      // beta writes first, and reads the message afterwards.
      const kept = await write(world, after, "beta");
      expect((await after.readMessage(await world.token("beta"), { id: world.canary.id as never })).ok).toBe(true);
      expect(await deleteMail(world, MAIL.canary)).toEqual({ recordsRemoved: 0 });
      expect(
        await before.record(await world.token("alpha"), {
          kind: "note",
          body: "after the deletion",
          requestId: "request-after-deletion",
        }),
      ).toEqual({ ok: false, code: "not_found", refusal: "session_renewed" });
      const removed = await write(world, newSession(world), "alpha");
      const [reading] = await queryAs<{ session_id: string }>(
        world.store.db.urls.admin,
        "select session_id from ledger.read_log where tool = 'read_message' and client_id = (select id from policy.clients where name = 'alpha')",
      );
      await asTableOwner(
        world,
        ["ledger.agent_writes"],
        "update ledger.agent_writes set session_id = $2, created_at = now() where id = $1",
        [removed, reading?.session_id],
      );
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 1, removed: 1 });
      await expectRemoved(world, removed);
      expect((await rowOf(world, kept)).evidence_id).not.toBeNull();
    }));

  it("a row whose session was shown, in a pack, the body of an agent record since removed is taken in", () =>
    inWorld(async (world) => {
      const gone = await write(world, newSession(world), "alpha", { kind: "handoff", cites: [world.solo.id as never] });
      expect(await deleteMail(world, MAIL.solo)).toEqual({ recordsRemoved: 1 });
      await expectRemoved(world, gone);
      const reader = newSession(world);
      expect((await reader.getSelf(await world.token("alpha"))).ok).toBe(true);
      // The pack's read log row, as a context pack writes it: the removed handoff shown.
      await logRead(world, "alpha", "get_self", { shown: [gone] });
      const next = await write(world, reader, "alpha", { kind: "handoff" });
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 1 });
      expect((await rowOf(world, next)).evidence_id).not.toBeNull();
    }));

  it("a row removed by the owner while intake runs is not taken in", () =>
    inWorld(async (world) => {
      // The owner first, holding the row while intake waits for it: intake then finds no body.
      const first = await write(world, newSession(world), "alpha");
      await session(world.store.db.urls.admin, async (query) => {
        await query("begin");
        await query("select id from ledger.agent_writes where id = $1 for update", [first]);
        const intake = world.writer.takeRecords();
        await new Promise((resolve) => setTimeout(resolve, 500));
        await query("update ledger.agent_writes set body_enc = null, tainted_at = now() where id = $1", [first]);
        await query("commit");
        expect(await intake).toEqual(ZERO);
      });
      await expectRemoved(world, first);
      expect(await agentEvidence(world)).toEqual([]);
      // Intake first: the owner's removal then takes the evidence row with it.
      const second = await write(world, newSession(world), "alpha");
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 1 });
      expect(await world.admin.agents.removeRecord(second)).toEqual({ removed: 1 });
      await expectRemoved(world, second);
      expect(await agentEvidence(world)).toEqual([]);
    }));

  it("a re-derive leaves an agent record's evidence as it was, and opens none", () =>
    inWorld(async (world) => {
      const id = await write(world, newSession(world), "alpha", { cites: [world.canary.id as never] });
      await world.writer.takeRecords();
      const { evidence_id } = await rowOf(world, id);
      const xmin = async () =>
        (
          await queryAs<{ xmin: string; compartments: string[] }>(
            world.store.db.urls.admin,
            "select xmin::text as xmin, compartments from vault.evidence_items where id = $1",
            [evidence_id],
          )
        )[0];
      const before = await xmin();
      expect(before?.compartments).toEqual(["agent:alpha", "own"]);
      // A person's address becomes the owner's, so a re-derive is needed; the writer that runs
      // it holds no key for the agent record's compartment, so it could not open it.
      await addOwnerAddressUnderived(world.store.db, QUENTIN.address, "own");
      const lacking = createWriter({
        url: world.store.db.urls.writer,
        keys: without(world.keys, "agent:alpha"),
        log: recordingLogger().log,
      });
      try {
        expect((await lacking.rederiveIfNeeded(derive)).rederived).toBe(true);
      } finally {
        await lacking.close();
      }
      expect(await xmin()).toEqual(before);
    }));

  it("a canary in an agent record's body is found in plaintext in no column of any table after intake, and neither is its SHA-256", () =>
    inWorld(async (world) => {
      const canary = "CANARY-agent-record-7f3a91 the heron left at dawn";
      await write(world, newSession(world), "alpha", { body: canary });
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 1 });
      expect(await scanForPlaintext(world.store.db.urls.admin, [canary, sha256Hex(canary)])).toEqual([]);
    }));

  // Due as an agent_record item, not only email.
  it("an agent record taken in is due for extraction as an agent_record item", () =>
    inWorld(async (world) => {
      await write(world, newSession(world), "alpha");
      await world.writer.takeRecords();
      const [evidence] = await agentEvidence(world);
      const pipeline = createPipeline({
        url: world.store.db.urls.pipeline,
        keys: world.keys,
        log: recordingLogger().log,
      });
      try {
        const items = await pipeline.due(100, 1);
        const due = items.map((item) => item.evidenceId as string);
        expect(items.find((item) => item.evidenceId === evidence?.id)).toMatchObject({ source: "agent_record" });
        // The control: a message's row is due.
        expect(due).toContain(world.canary.evidence);
      } finally {
        await pipeline.close();
      }
    }));
});

describe("removal with deleted evidence", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a message deleted at the source removes what rests on it, and leaves what does not", () =>
    inWorld(async (world) => {
      const token = (name: string) => world.token(name);
      // Removed: one that cites it; one whose session read its text with read_message, and one
      // with find_facts, before writing.
      const cites = await write(world, newSession(world), "alpha", { cites: [world.canary.id as never] });
      const reads = newSession(world);
      expect((await reads.readMessage(await token("beta"), { id: world.canary.id as never })).ok).toBe(true);
      const read = await write(world, reads, "beta");
      const facts = newSession(world);
      expect((await facts.getSelf(await token("gamma"))).ok).toBe(true);
      await logRead(world, "gamma", "find_facts", { bound: [world.canary.evidence] });
      const found = await write(world, facts, "gamma");
      // Kept: one written before its session read the message; one whose session was only
      // shown its summary; one of another session; one whose session was shown, in a pack, the
      // body of an agent record that was removed.
      const early = newSession(world);
      const before = await write(world, early, "delta");
      expect((await early.readMessage(await token("delta"), { id: world.canary.id as never })).ok).toBe(true);
      const summary = newSession(world);
      expect((await summary.findMessages(await token("alpha"), {})).ok).toBe(true);
      const shown = await write(world, summary, "alpha");
      const other = await write(world, newSession(world), "beta");
      const pack = newSession(world);
      expect((await pack.getSelf(await token("alpha"))).ok).toBe(true);
      await logRead(world, "alpha", "get_self", { shown: [cites] });
      const packed = await write(world, pack, "alpha", { kind: "handoff" });

      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 7 });
      expect(await deleteMail(world, MAIL.canary)).toEqual({ recordsRemoved: 3 });
      for (const id of [cites, read, found]) await expectRemoved(world, id);
      for (const id of [before, shown, other, packed]) await expectKept(world, id);
      expect(await world.writer.takeRecords()).toEqual(ZERO);
    }));

  it("an agent record that cites a deleted message is removed, by a deletion notice and by a reconcile alike, and each path answers the count", () =>
    inWorld(async (world) => {
      const notice = await write(world, newSession(world), "alpha", { cites: [world.canary.id as never] });
      const listing = await write(world, newSession(world), "beta", { cites: [world.solo.id as never] });
      await world.writer.takeRecords();
      expect(await deleteMail(world, MAIL.canary)).toEqual({ recordsRemoved: 1 });
      await expectRemoved(world, notice);
      await expectKept(world, listing);
      expect(await reconcileMail(world, [])).toEqual({ removed: 1, reconciled: true, recordsRemoved: 1 });
      await expectRemoved(world, listing);
    }));

  it("one that cites an earlier revision of the deleted message is removed", () =>
    inWorld(async (world) => {
      const id = await write(world, newSession(world), "alpha", { cites: [world.solo.id as never] });
      await world.writer.takeRecords();
      await world.writer.ingestItem(
        world.accounts.personalMail,
        mailRevision(MAIL.soloAgain, world.accounts.personalMail),
        mailFacts(MAIL.soloAgain),
      );
      expect((await rowOf(world, id)).cites).toEqual([world.solo.evidence]);
      // It stays while its revision is stored.
      await expectKept(world, id);
      expect(await deleteMail(world, MAIL.solo)).toEqual({ recordsRemoved: 1 });
      await expectRemoved(world, id);
    }));

  it("one that cites a message that gained a new revision stays", () =>
    inWorld(async (world) => {
      const id = await write(world, newSession(world), "alpha", { cites: [world.solo.id as never] });
      await world.writer.takeRecords();
      await world.writer.ingestItem(
        world.accounts.personalMail,
        mailRevision(MAIL.soloAgain, world.accounts.personalMail),
        mailFacts(MAIL.soloAgain),
      );
      await expectKept(world, id);
      expect((await rowOf(world, id)).evidence_id).not.toBeNull();
      // And a record written after the revision, citing it, is taken in.
      const later = await write(world, newSession(world), "beta", { cites: [world.solo.id as never] });
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 1 });
      await expectKept(world, later);
    }));

  it("one that cites a deleted calendar event is removed, and one that cites an event that only changed its time stays", () =>
    inWorld(async (world) => {
      const moved = await write(world, newSession(world), "alpha", { cites: [world.event.id as never] });
      await world.writer.takeRecords();
      await ingestEvent(world.writer, world.accounts.personalCalendar, EVENTS.canaryMoved);
      await expectKept(world, moved);
      expect(await world.writer.takeRecords()).toEqual(ZERO);
      const sourceItemId = eventItem(EVENTS.canary, world.accounts.personalCalendar).sourceItemId;
      expect(
        await world.writer.applyDeletion(world.accounts.personalCalendar, {
          sourceAccount: world.accounts.personalCalendar.id,
          sourceItemId,
        } as SourceDeletion),
      ).toEqual({
        recordsRemoved: 1,
      });
      await expectRemoved(world, moved);
    }));

  it("one whose session had read the deleted message's text before it was written is removed, though it cites nothing", () =>
    inWorld(async (world) => {
      const viaRead = newSession(world);
      expect((await viaRead.readMessage(await world.token("alpha"), { id: world.canary.id as never })).ok).toBe(true);
      const read = await write(world, viaRead, "alpha");
      const viaFacts = newSession(world);
      expect((await viaFacts.getSelf(await world.token("beta"))).ok).toBe(true);
      await logRead(world, "beta", "find_facts", { bound: [world.canary.evidence] });
      const found = await write(world, viaFacts, "beta");
      expect(await deleteMail(world, MAIL.canary)).toEqual({ recordsRemoved: 2 });
      await expectRemoved(world, read);
      await expectRemoved(world, found);
    }));

  it("one written before its session read the message stays", () =>
    inWorld(async (world) => {
      const reader = newSession(world);
      const id = await write(world, reader, "alpha");
      expect((await reader.readMessage(await world.token("alpha"), { id: world.canary.id as never })).ok).toBe(true);
      expect(await deleteMail(world, MAIL.canary)).toEqual({ recordsRemoved: 0 });
      await expectKept(world, id);
    }));

  it("one whose session was only shown the message's summary stays", () =>
    inWorld(async (world) => {
      const reader = newSession(world);
      expect((await reader.findMessages(await world.token("alpha"), {})).ok).toBe(true);
      const [logged] = await queryAs<{ shown: string[] }>(
        world.store.db.urls.admin,
        "select shown from ledger.read_log where tool = 'find_messages'",
      );
      expect(logged?.shown).toContain(world.canary.evidence);
      const id = await write(world, reader, "alpha");
      expect(await deleteMail(world, MAIL.canary)).toEqual({ recordsRemoved: 0 });
      await expectKept(world, id);
    }));

  it("one of another session stays", () =>
    inWorld(async (world) => {
      expect(
        (await newSession(world).readMessage(await world.token("alpha"), { id: world.canary.id as never })).ok,
      ).toBe(true);
      const id = await write(world, newSession(world), "alpha");
      expect(await deleteMail(world, MAIL.canary)).toEqual({ recordsRemoved: 0 });
      await expectKept(world, id);
    }));

  it("one whose session was shown, in a pack, the body of a removed agent record stays, and so does the third of three such handoffs", () =>
    inWorld(async (world) => {
      const first = await write(world, newSession(world), "alpha", {
        kind: "handoff",
        cites: [world.canary.id as never],
      });
      const handoffs = [first];
      for (let index = 0; index < 2; index += 1) {
        const reader = newSession(world);
        expect((await reader.getSelf(await world.token("alpha"))).ok).toBe(true);
        await logRead(world, "alpha", "get_self", { shown: [handoffs[handoffs.length - 1] ?? ""] });
        handoffs.push(await write(world, reader, "alpha", { kind: "handoff" }));
      }
      expect(await deleteMail(world, MAIL.canary)).toEqual({ recordsRemoved: 1 });
      await expectRemoved(world, first);
      for (const id of handoffs.slice(1)) await expectKept(world, id);
    }));

  it("one removed before intake is never taken in", () =>
    inWorld(async (world) => {
      const id = await write(world, newSession(world), "alpha", { cites: [world.canary.id as never] });
      expect(await deleteMail(world, MAIL.canary)).toEqual({ recordsRemoved: 1 });
      expect(await world.writer.takeRecords()).toEqual(ZERO);
      await expectRemoved(world, id);
      expect((await rowOf(world, id)).evidence_id).toBeNull();
    }));

  it("the removed row keeps its ids, its fingerprint and tainted_at, and no body", () =>
    inWorld(async (world) => {
      const id = await write(world, newSession(world), "alpha", { cites: [world.canary.id as never] });
      await world.writer.takeRecords();
      const before = await rowOf(world, id);
      await deleteMail(world, MAIL.canary);
      const after = await rowOf(world, id);
      expect(after).toEqual({ ...before, body: false, tainted_at: expect.any(Date) });
      expect(after.evidence_id).not.toBeNull();
    }));

  it("a deletion that fails leaves every agent record as it was", () =>
    inWorld(async (world) => {
      const id = await write(world, newSession(world), "alpha", { cites: [world.canary.id as never] });
      await world.writer.takeRecords();
      const before = lines(await snapshot(world.store.db));
      // The last statement of the deletion fails: the transaction rolls back whole.
      await asTableOwner(
        world,
        [],
        "create function vault.refuse_listed_delete() returns trigger language plpgsql as $$ begin raise exception 'refused for the test'; end $$",
      );
      await asTableOwner(
        world,
        [],
        "create trigger refuse_listed_delete before delete on vault.listed_items for each statement execute function vault.refuse_listed_delete()",
      );
      await expect(deleteMail(world, MAIL.canary)).rejects.toMatchObject({ code: "unavailable" });
      expect(lines(await snapshot(world.store.db))).toEqual(before);
      await expectKept(world, id);
    }));

  it("a deletion of an item no agent record rests on answers recordsRemoved 0 and leaves every ledger row as it was", () =>
    inWorld(async (world) => {
      await write(world, newSession(world), "alpha", { cites: [world.canary.id as never] });
      await write(world, newSession(world), "beta", { kind: "handoff" });
      await world.writer.takeRecords();
      const agents = (await agentEvidence(world)).map((row) => row.id);
      expect(agents).toHaveLength(2);
      const ledger = async () =>
        lines(await snapshot(world.store.db)).filter(
          (line) => line.startsWith("ledger.") || agents.some((id) => line.includes(id)),
        );
      const before = await ledger();
      expect(await deleteMail(world, MAIL.solo)).toEqual({ recordsRemoved: 0 });
      expect(await ledger()).toEqual(before);
    }));

  it("removeResting locks the resting records' evidence rows before their agent_writes rows", () =>
    inWorld(async (world) => {
      const ids = [
        await write(world, newSession(world), "alpha", { cites: [world.canary.id as never] }),
        await write(world, newSession(world), "beta", { cites: [world.canary.id as never] }),
      ];
      await world.writer.takeRecords();
      const sent: string[] = [];
      await session(world.store.db.urls.writer, async (query) => {
        const spy: Query = (text, values) => {
          sent.push(text.replace(/\s+/g, " ").trim());
          return query(text, values);
        };
        await query("begin");
        try {
          expect((await removeResting({ query: spy, keys: world.keys }, [world.canary.evidence])).removed).toBe(2);
        } finally {
          await query("rollback");
        }
      });
      const evidenceLock = sent.findIndex(
        (text) => text.startsWith("select id from vault.evidence_items") && text.endsWith("for update"),
      );
      const rowLock = sent.findIndex(
        (text) => text.startsWith("select id, evidence_id from ledger.agent_writes") && text.endsWith("for update"),
      );
      const beliefs = sent.findIndex((text) => text.includes("pg_advisory_xact_lock"));
      expect(evidenceLock).toBeGreaterThan(0);
      expect(rowLock).toBeGreaterThan(evidenceLock);
      expect(beliefs).toBeGreaterThan(rowLock);
      void ids;
    }));
});

describe("a removed agent record taints what rests on its evidence", { timeout: DB_TEST_TIMEOUT }, () => {
  // A pending notice with a body, and one basis row on it that cites `evidenceId`, as no
  // function built yet writes one for an agent record: written by the test as the table owner.
  async function citing(world: World, recordId: string, evidenceId: string): Promise<CardId> {
    const made: NewCard = {
      id: newId("crd") as CardId,
      requestId: `req-${testId("r")}`,
      kind: "notice",
      author: "system:test",
      options: ["acknowledge"],
      target: null,
      refs: [],
      compartments: ["own"],
      expiresAt: null,
      expiresAfterDays: null,
      caseKey: null,
      run: null,
      body: "a body to lose",
      bodyFrom: "code",
    };
    await session(world.store.db.urls.admin, async (query) => {
      await query("begin");
      await raiseCard(query, made, { now: new Date(NOW), keys: world.keys });
      await query("commit");
    });
    await asTableOwner(
      world,
      ["ledger.basis"],
      "insert into ledger.basis (row_kind, row_id, ref_kind, ref_id, evidence_id, source_class, compartments) values ('card', $1, 'record', $2, $3, 'agent', '{own}')",
      [made.id, recordId, evidenceId],
    );
    return made.id;
  }
  const cardOf = async (world: World, id: CardId) =>
    (
      await queryAs<{ tainted: boolean; body: boolean; state: string }>(
        world.store.db.urls.admin,
        `select c.tainted_at is not null as tainted, c.body_enc is not null as body,
           (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) as state
         from ledger.cards c where c.id = $1`,
        [id],
      )
    )[0];
  const TAINTED = { tainted: true, body: false, state: "withdrawn" };
  const basisOf = (world: World, recordId: string) =>
    queryAs<{ tainted: boolean; evidence_id: string | null }>(
      world.store.db.urls.admin,
      "select tainted_at is not null as tainted, evidence_id from ledger.basis where ref_id = $1",
      [recordId],
    );
  const taints = (statements: { text: string; values: unknown[] }[], evidenceId: string): number[] =>
    statements.flatMap((one, index) =>
      one.text.includes("taint_citing") &&
      Array.isArray(one.values[0]) &&
      (one.values[0] as string[]).includes(evidenceId)
        ? [index]
        : [],
    );
  const at = (statements: { text: string }[], pattern: RegExp): number =>
    statements.findIndex((one) => pattern.test(one.text));

  it("the owner's removal calls taint_citing with the agent record's evidence id, after the beliefs lock, and taints what cited it", () =>
    inWorld(async (world) => {
      const id = await write(world, newSession(world), "alpha");
      await world.writer.takeRecords();
      const evidenceId = (await rowOf(world, id)).evidence_id as string;
      expect(evidenceId).not.toBeNull();
      const cited = await citing(world, id, evidenceId);
      const { result, statements } = await recordingStatements(() => world.admin.agents.removeRecord(id));
      expect(result).toEqual({ removed: 1 });
      await expectRemoved(world, id);
      const [taint, ...more] = taints(statements, evidenceId);
      expect(more).toEqual([]);
      for (const before of [/hashtext\('intelligence personal beliefs'\)/, /delete from vault\.evidence_items/]) {
        expect(at(statements, before), String(before)).toBeGreaterThanOrEqual(0);
        expect(taint).toBeGreaterThan(at(statements, before));
      }
      expect(await cardOf(world, cited)).toEqual(TAINTED);
      expect(await basisOf(world, id)).toEqual([{ tainted: true, evidence_id: null }]);
    }));

  it("a source deletion that removes a resting agent record taints with its evidence id in the deletion's one call, after the events are deleted", () =>
    inWorld(async (world) => {
      const id = await write(world, newSession(world), "alpha", { cites: [world.canary.id as never] });
      await world.writer.takeRecords();
      const evidenceId = (await rowOf(world, id)).evidence_id as string;
      const cited = await citing(world, id, evidenceId);
      const { result, statements } = await recordingStatements(() => deleteMail(world, MAIL.canary));
      expect(result).toEqual({ recordsRemoved: 1 });
      await expectRemoved(world, id);
      // One call names both the item's revision and the agent record's evidence row.
      const [taint, ...more] = taints(statements, evidenceId);
      expect(more).toEqual([]);
      expect(statements[taint as number]?.values[0]).toEqual(
        expect.arrayContaining([world.canary.evidence, evidenceId]),
      );
      for (const before of [/hashtext\('intelligence personal beliefs'\)/, /delete from knowledge\.events/]) {
        expect(at(statements, before), String(before)).toBeGreaterThanOrEqual(0);
        expect(taint).toBeGreaterThan(at(statements, before));
      }
      expect(await cardOf(world, cited)).toEqual(TAINTED);
      expect(await basisOf(world, id)).toEqual([{ tainted: true, evidence_id: null }]);
    }));

  it("an agent record removed before it was taken in has no evidence row, and taints only what cites it as the owner's request", () =>
    inWorld(async (world) => {
      const id = await write(world, newSession(world), "alpha");
      const { result, statements } = await recordingStatements(() => world.admin.agents.removeRecord(id));
      expect(result).toEqual({ removed: 1 });
      expect((await rowOf(world, id)).evidence_id).toBeNull();
      // No evidence id, so one call names the record as an owner_request ref.
      expect(statements.filter((one) => one.text.includes("taint_citing")).map((one) => one.values)).toEqual([
        [[], ["owner_request"], [id]],
      ]);
    }));

  it("a memory projection whose belief rests on an agent record's claim is tainted, and gets an exposure row, when the record is removed", () =>
    inWorld(async (world) => {
      const id = await write(world, newSession(world), "alpha");
      await world.writer.takeRecords();
      const evidenceId = (await rowOf(world, id)).evidence_id as string;
      const [label] = await queryAs<{ compartments: string[] }>(
        world.store.db.urls.admin,
        "select compartments from vault.evidence_items where id = $1",
        [evidenceId],
      );
      const compartments = label?.compartments ?? [];
      expect(compartments).toEqual(["agent:alpha", "own"]);
      // A client cleared for the record's label is served a commitment whose one claim is on it.
      const memory = await memoryClient(world.store.db, "memory-of-records", compartments, { retention: "retains" });
      const entry = served(1, { evidence: [evidenceId], compartments });
      await serve(world.store.db, memory.token, { entries: [entry] });
      expect((await projectionOf(world.store.db, entry.id)).evidence_ids).toEqual([evidenceId]);
      expect(await world.admin.agents.removeRecord(id)).toEqual({ removed: 1 });
      const row = await projectionOf(world.store.db, entry.id);
      expect(row).toMatchObject({ evidence_ids: [], belief_id: null, reason: "withdrawn" });
      expect(row.tainted_at).toBeInstanceOf(Date);
      expect(
        (await exposuresOf(world.store.db, memory)).map((one) => [one.projection_id, one.retention, one.removal]),
      ).toEqual([[entry.id, "retains", "pending"]]);
    }));
});

// Every deletion path holds the sync lock, so intake never runs beside one: `pi sync` takes intake
// and its own deletions under it (sync-command.ts), and an erasure takes it first.
describe("the removed-evidence check on the agent lane", { timeout: DB_TEST_TIMEOUT }, () => {
  const TAINT = "hashtext('intelligence personal ledger taint')";
  const clientId = async (world: World, name: string): Promise<string> =>
    one(
      await queryAs<{ id: string }>(world.store.db.urls.admin, "select id from policy.clients where name = $1", [name]),
    ).id;
  const quota = async (world: World, name: string): Promise<number> =>
    (
      await queryAs<{ attempts: number }>(
        world.store.db.urls.admin,
        "select attempts::int as attempts from policy.record_quota where client_id = (select id from policy.clients where name = $1)",
        [name],
      )
    )[0]?.attempts ?? 0;
  const callsOf = async (world: World, name: string): Promise<string[]> =>
    (
      await queryAs<{ outcome: string }>(
        world.store.db.urls.admin,
        "select outcome from policy.calls where tool = 'record' and client_id = (select id from policy.clients where name = $1) order by id",
        [name],
      )
    ).map((row) => row.outcome);
  const writesOf = async (world: World, name: string): Promise<number> =>
    one(
      await queryAs<{ n: number }>(
        world.store.db.urls.admin,
        "select count(*)::int as n from ledger.agent_writes where client_name = $1",
        [name],
      ),
    ).n;
  // The agent records with a body that rest on the evidence ids: what a deletion must leave none of.
  const resting = async (world: World, evidenceIds: string[]): Promise<string[]> =>
    (await queryAs<{ id: string }>(world.store.db.urls.admin, RESTING, [evidenceIds])).map((row) => row.id);
  // An Admin with an erasure journal of its own, in a folder the test removes.
  async function journaled(world: World, fn: (admin: Admin) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "pi-removed-"));
    try {
      await fn(
        new Admin({
          pool: world.store.adminPool,
          keys: world.keys,
          log: world.store.log,
          journal: join(dir, "keys.json.erasures"),
          recordEnabled: true,
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  // One projection row of a client, as policy.serve_memory leaves it, inserted as pi_owner, whose
  // policies on ledger.memory_projections let it.
  async function projection(world: World, name: string, tainted: boolean): Promise<string> {
    const id = `mpr_${randomBytes(20).toString("hex")}`;
    await session(world.store.db.urls.bootstrap, async (query) => {
      await query("set role pi_owner");
      await query(
        `insert into ledger.memory_projections (id, client_id, audience, template, fact_key_fp, state_fp, evidence_ids, compartments, first_served_at, last_served_at, tainted_at)
         values ($1, $2, '{own}', 'commitments@1', $3, $3, '{}', '{own}', now(), now(), $4)`,
        [id, await clientId(world, name), "c".repeat(64), tainted ? new Date() : null],
      );
    });
    return id;
  }
  const stamped = (projectionId: string): string =>
    `Copied from memory: - Commitment, active. Due 2026-10-09. [pi:${projectionId} f:${"a".repeat(16)} s:${"b".repeat(16)}]`;
  // Until `wanted` holds, every 50 ms, for at most 10 seconds.
  async function until(wanted: () => Promise<boolean>): Promise<void> {
    for (let tries = 0; tries < 200; tries += 1) {
      if (await wanted()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("timed out");
  }
  const waitingOnAdvisory = async (world: World): Promise<boolean> =>
    one(
      await queryAs<{ n: number }>(
        world.store.db.urls.admin,
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted",
      ),
    ).n > 0;
  // One agent record row, as the table owner writes it, resting on `cites`: what an append that
  // passed its check before a deletion committed leaves, once committed.
  async function lateRow(
    world: World,
    name: string,
    sessionId: string,
    cites: string[],
    evidenceId: string | null = null,
  ): Promise<string> {
    const id = newId("rec");
    const label = [`agent:${name}`, "own"];
    await session(world.store.db.urls.bootstrap, async (query) => {
      await query("set role pi_owner");
      await query(
        `insert into ledger.agent_writes (id, client_id, client_name, session_id, request_id, tool, kind, compartments, writer_views, content_fp, cites_fp, cites, body_enc, evidence_id)
         values ($1, $2, $3, $4, $5, 'record', 'note', $6, $7, $8, $8, $9, $10, $11)`,
        [
          id,
          await clientId(world, name),
          name,
          sessionId,
          `request-late-${id.slice(-12)}`,
          label,
          ALL_VIEWS,
          "d".repeat(64),
          cites,
          sealUnder(world.keys, label, { table: "ledger.agent_writes", id, column: "body_enc" }, "a late note"),
          evidenceId,
        ],
      );
    });
    return id;
  }
  // A deletion of the canary message held at its taint call by an exclusive taint lock another
  // connection holds; `during` runs while it waits, then the lock is let go.
  async function heldAtTaint<T>(
    world: World,
    during: () => Promise<T>,
  ): Promise<{ during: T; deleted: { recordsRemoved: number } }> {
    const holder = new pg.Client({ connectionString: world.store.db.urls.admin });
    await holder.connect();
    try {
      await holder.query(`select pg_advisory_lock(${TAINT})`);
      const deletion = deleteMail(world, MAIL.canary);
      await until(() => waitingOnAdvisory(world));
      const done = await during();
      await holder.query(`select pg_advisory_unlock(${TAINT})`);
      return { during: done, deleted: await deletion };
    } finally {
      await holder.end();
    }
  }

  it("a record call's transaction is read committed and its first statement takes the shared taint lock", () =>
    inWorld(async (world) => {
      const token = await world.token("alpha");
      const recorded = recordingPool(world.store.readerPool);
      const reader = new Reader({ pool: recorded.pool, keys: world.keys, log: world.store.log });
      expect(
        (await reader.record(token, { kind: "note", body: "under the lock", requestId: "request-r1-0001" })).ok,
      ).toBe(true);
      expect(recorded.statements.slice(0, 2)).toEqual([
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        `select pg_advisory_xact_lock_shared(${TAINT})`,
      ]);
      // The refusal path of record takes it too; every read tool keeps its own transaction and
      // takes no transaction-scoped taint lock: it holds the lock shared around that transaction
      // instead.
      recorded.statements.length = 0;
      expect(await reader.refused(token, "record")).toEqual({ ok: false, code: "invalid_request" });
      expect(recorded.statements.slice(0, 2)).toEqual([
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        `select pg_advisory_xact_lock_shared(${TAINT})`,
      ]);
      recorded.statements.length = 0;
      expect((await reader.getSelf(token)).ok).toBe(true);
      const inside = insideHold([...recorded.statements]);
      expect(inside[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
      expect(inside.filter((text) => text.includes("pg_advisory"))).toEqual([]);
    }));

  it("agent-records, Sessions: the refusal for a removed read renews the session, and the next write rests only on what is read after it", () =>
    inWorld(async (world) => {
      const token = await world.token("alpha");
      const reader = newSession(world);
      const session = async (): Promise<string[]> =>
        (
          await queryAs<{ id: string }>(
            world.store.db.urls.admin,
            "select s.id from ledger.sessions s join policy.clients c on c.id = s.client_id where c.name = 'alpha' order by s.started_at, s.id",
          )
        ).map((row) => row.id);
      expect((await reader.readMessage(token, { id: world.canary.id as never })).ok).toBe(true);
      expect(await session()).toHaveLength(1);
      await deleteMail(world, MAIL.canary);
      const args = { kind: "note" as const, body: "written after the refusal" };
      expect(await reader.record(token, { ...args, requestId: "request-renew-1" })).toEqual({
        ok: false,
        code: "not_found",
        refusal: "session_renewed",
      });
      expect(await writesOf(world, "alpha")).toBe(0);
      // The next write stands, in a session of its own, which holds none of the removed read.
      const written = await reader.record(token, { ...args, requestId: "request-renew-2" });
      expect(written.ok).toBe(true);
      const sessions = await session();
      expect(sessions).toHaveLength(2);
      expect(
        await queryAs(
          world.store.db.urls.admin,
          "select session_id from ledger.agent_writes where client_name = 'alpha'",
        ),
      ).toEqual([{ session_id: sessions[1] }]);
      // A deletion's reach over what the old session wrote stays: its reads are kept.
      expect(
        await queryAs(
          world.store.db.urls.admin,
          "select count(*)::int as n from ledger.read_log where session_id = $1",
          [sessions[0]],
        ),
      ).toEqual([{ n: 1 }]);
      // Another call of the same session finding nothing wrong renews nothing.
      expect((await reader.record(token, { ...args, requestId: "request-renew-3" })).ok).toBe(true);
      expect(await session()).toHaveLength(2);
    }));

  it("after read_message of a message that is then deleted, record answers not_found and writes nothing but its calls row and the quota row", () =>
    inWorld(async (world) => {
      const token = await world.token("alpha");
      const reader = newSession(world);
      expect((await reader.readMessage(token, { id: world.canary.id as never })).ok).toBe(true);
      expect(await deleteMail(world, MAIL.canary)).toEqual({ recordsRemoved: 0 });
      const attempts = await quota(world, "alpha");
      expect(
        await reader.record(token, {
          kind: "note",
          body: "what the deleted message said",
          requestId: "request-r2-0001",
        }),
      ).toEqual({ ok: false, code: "not_found", refusal: "session_renewed" });
      expect(await writesOf(world, "alpha")).toBe(0);
      expect(await callsOf(world, "alpha")).toEqual(["not_found"]);
      expect(await quota(world, "alpha")).toBe(attempts + 1);
      // So is a cite of it, from a session that read nothing: the cite resolves to nothing.
      expect(
        await newSession(world).record(token, {
          kind: "note",
          body: "x",
          cites: [world.canary.id as never],
          requestId: "request-r2-0002",
        }),
      ).toEqual({ ok: false, code: "not_found" });
      // The control: a session that read only what is still there writes.
      const other = newSession(world);
      expect((await other.readMessage(token, { id: world.solo.id as never })).ok).toBe(true);
      expect(
        (await other.record(token, { kind: "note", body: "about the other one", requestId: "request-r2-0003" })).ok,
      ).toBe(true);
      expect(await writesOf(world, "alpha")).toBe(1);
    }));

  it("a body with a stamp of the client's tainted projection answers not_found", () =>
    inWorld(async (world) => {
      const token = await world.token("alpha");
      await world.token("beta");
      const tainted = await projection(world, "alpha", true);
      const live = await projection(world, "alpha", false);
      const betas = await projection(world, "beta", true);
      const reader = newSession(world);
      expect(
        await reader.record(token, { kind: "note", body: stamped(tainted), requestId: "request-r3-0001" }),
      ).toEqual({ ok: false, code: "not_found" });
      expect(
        await reader.record(token, {
          kind: "note",
          body: `${stamped(live)}\n${stamped(tainted)}`,
          requestId: "request-r3-0002",
        }),
      ).toEqual({ ok: false, code: "not_found" });
      expect(await writesOf(world, "alpha")).toBe(0);
      // The controls: its own live projection, another client's tainted one, no row at all.
      for (const [n, body] of [stamped(live), stamped(betas), stamped(`mpr_${"0".repeat(40)}`), "no stamp"].entries()) {
        expect((await reader.record(token, { kind: "note", body, requestId: `request-r3-ok-${n}` })).ok, body).toBe(
          true,
        );
      }
      expect(await writesOf(world, "alpha")).toBe(4);
    }));

  // One agent record row with this body, as an append through raw SQL that passed no stamps
  // leaves it: its fingerprint the body's, so intake can take it.
  async function bodyRow(world: World, name: string, sessionId: string, body: string): Promise<string> {
    const id = newId("rec");
    const label = [`agent:${name}`, "own"];
    await session(world.store.db.urls.bootstrap, async (query) => {
      await query("set role pi_owner");
      await query(
        `insert into ledger.agent_writes (id, client_id, client_name, session_id, request_id, tool, kind, compartments, writer_views, content_fp, cites_fp, cites, body_enc)
         values ($1, $2, $3, $4, $5, 'record', 'note', $6, $7, $8, $9, '{}', $10)`,
        [
          id,
          await clientId(world, name),
          name,
          sessionId,
          `request-raw-${id.slice(-12)}`,
          label,
          ALL_VIEWS,
          fingerprint(world.keys, "content_hash", sha256Hex(body)),
          "d".repeat(64),
          sealUnder(world.keys, label, { table: "ledger.agent_writes", id, column: "body_enc" }, body),
        ],
      );
    });
    return id;
  }

  it("intake removes a record whose body carries a stamp of its client's tainted projection, though it was appended with no stamps", () =>
    inWorld(async (world) => {
      await world.token("beta");
      const first = await write(world, newSession(world), "alpha");
      const { session_id: sessionId } = await rowOf(world, first);
      const tainted = await projection(world, "alpha", true);
      const live = await projection(world, "alpha", false);
      const betas = await projection(world, "beta", true);
      const late = await bodyRow(world, "alpha", sessionId, `${stamped(live)}\n${stamped(tainted)}`);
      // The controls: its own live projection, another client's tainted one, an id of no row.
      const kept = [stamped(live), stamped(betas), stamped(`mpr_${"0".repeat(40)}`)];
      const keptIds: string[] = [];
      for (const body of kept) keptIds.push(await bodyRow(world, "alpha", sessionId, body));
      expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 4, removed: 1 });
      await expectRemoved(world, late);
      expect((await rowOf(world, late)).evidence_id).toBeNull();
      for (const id of keptIds) expect((await rowOf(world, id)).evidence_id, id).not.toBeNull();
    }));

  it("a record naming a suppressed address is stored and resolves no account for it", () =>
    inWorld(async (world) =>
      journaled(world, async (admin) => {
        const [person] = await queryAs<{ entity_id: string }>(
          world.store.db.urls.admin,
          "select distinct entity_id from knowledge.accounts where value_fp = $1",
          [fingerprint(world.keys, "address", QUENTIN.address)],
        );
        await admin.erasure.erasePerson(person?.entity_id as never, { requestId: "request-r5-erase" });
        const suppressed = await queryAs(
          world.store.db.urls.admin,
          "select id from knowledge.suppressions where value_fp = $1",
          [fingerprint(world.keys, "address", QUENTIN.address)],
        );
        expect(suppressed).toHaveLength(1);
        const id = await write(world, newSession(world), "alpha", {
          body: `Write to ${QUENTIN.address} about the plans.`,
        });
        await expectKept(world, id);
        expect(await world.writer.takeRecords()).toEqual({ ...ZERO, taken: 1 });
        expect(
          await queryAs(world.store.db.urls.admin, "select id from knowledge.accounts where value_fp = $1", [
            fingerprint(world.keys, "address", QUENTIN.address),
          ]),
        ).toEqual([]);
      }),
    ));

  it("every transaction that calls removeSourceItem is read committed, set explicitly", () =>
    inWorld(async (world) => {
      // The begin of the transaction that runs removeSourceItem's first statement.
      const beginOf = (statements: { text: string }[]): string | undefined => {
        const texts = statements.map((one) => one.text.replace(/\s+/g, " ").trim());
        const first = texts.findIndex((text) => text.startsWith("delete from knowledge.messages where evidence_id in"));
        expect(first).toBeGreaterThan(0);
        return texts.slice(0, first).findLast((text) => /^begin/i.test(text));
      };
      const notice = await recordingStatements(() => deleteMail(world, MAIL.canary));
      expect(beginOf(notice.statements)).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
      const reconcile = await recordingStatements(() => reconcileMail(world, []));
      expect(beginOf(reconcile.statements)).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
      // The owner's erasure, through the admin's transaction.
      await journaled(world, async (admin) => {
        const erased = await recordingStatements(() =>
          admin.erasure.eraseItem({ kind: "event", id: world.event.id as never }, { requestId: "request-r4-erase" }),
        );
        const texts = erased.statements.map((one) => one.text.replace(/\s+/g, " ").trim());
        const first = texts.findIndex((text) =>
          text.startsWith(
            "select id, blob_ref, revision, compartments from vault.evidence_items where source_account_id",
          ),
        );
        expect(first).toBeGreaterThan(0);
        expect(texts.slice(0, first).findLast((text) => /^begin/i.test(text))).toBe(
          "BEGIN ISOLATION LEVEL READ COMMITTED",
        );
      });
    }));

  it("the second sweep finds a record written between the first sweep and the taint lock", () =>
    inWorld(async (world) => {
      const first = await write(world, newSession(world), "alpha");
      const { session_id: sessionId } = await rowOf(world, first);
      const { during: late, deleted } = await heldAtTaint(world, () =>
        lateRow(world, "alpha", sessionId, [world.canary.evidence]),
      );
      expect(deleted).toEqual({ recordsRemoved: 1 });
      await expectRemoved(world, late);
      await expectKept(world, first);
      expect(await resting(world, [world.canary.evidence])).toEqual([]);
    }));

  it("a record with an evidence row is never touched by the second sweep", () =>
    inWorld(async (world) => {
      const first = await write(world, newSession(world), "alpha");
      const { session_id: sessionId } = await rowOf(world, first);
      // A row taken in, as no intake can make while a deletion holds the sync lock: left by the
      // test to show the second pass's limit.
      const { during: taken, deleted } = await heldAtTaint(world, () =>
        lateRow(world, "alpha", sessionId, [world.canary.evidence], world.solo.evidence),
      );
      expect(deleted).toEqual({ recordsRemoved: 0 });
      await expectKept(world, taken);
      expect((await rowOf(world, taken)).evidence_id).toBe(world.solo.evidence);
    }));

  // A reader whose first transaction after `arm()` stops before its COMMIT until `release` is
  // called: a record call's append is then made and holds the shared taint lock, uncommitted.
  // `paused` settles once it stops.
  function pausingReader(world: World): {
    reader: Reader;
    arm: () => void;
    paused: Promise<void>;
    release: () => void;
  } {
    let armed = false;
    let release = (): void => {};
    let reached = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const pool = world.store.readerPool;
    const wrapped = new Proxy(pool, {
      get: (target, property) => {
        if (property !== "connect") return Reflect.get(target, property, target);
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get: (inner, key) => {
              if (key !== "query") {
                const value: unknown = Reflect.get(inner, key, inner);
                return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(inner) : value;
              }
              return async (text: string, values?: unknown[]) => {
                if (armed && text === "COMMIT") {
                  armed = false;
                  reached();
                  await gate;
                }
                return inner.query(text, values);
              };
            },
          });
        };
      },
    });
    const arm = (): void => {
      armed = true;
    };
    return { reader: new Reader({ pool: wrapped, keys: world.keys, log: world.store.log }), arm, paused, release };
  }

  it("a record appended before a deletion's taint and committed after its first pass is emptied by the second pass", () =>
    inWorld(async (world) => {
      const token = await world.token("alpha");
      const { reader, arm, paused, release } = pausingReader(world);
      expect((await reader.readMessage(token, { id: world.canary.id as never })).ok).toBe(true);
      arm();
      // The append runs, checks the vault while the message is there, and stops before COMMIT.
      const recorded = reader.record(token, {
        kind: "note",
        body: "what the canary said",
        requestId: "request-forced-0001",
      });
      await paused;
      // The deletion's first pass cannot see it; its taint call waits for the shared lock.
      const deletion = deleteMail(world, MAIL.canary);
      await until(() => waitingOnAdvisory(world));
      release();
      const answer = await recorded;
      expect(answer.ok).toBe(true);
      expect(await deletion).toEqual({ recordsRemoved: 1 });
      await expectRemoved(world, outcomeValue(answer).recordId);
      expect(await resting(world, [world.canary.evidence])).toEqual([]);
    }));

  it("a record call that waits behind a deletion's taint is refused not_found once it commits", () =>
    inWorld(async (world) => {
      const token = await world.token("alpha");
      const reader = newSession(world);
      expect((await reader.readMessage(token, { id: world.canary.id as never })).ok).toBe(true);
      const holder = new pg.Client({ connectionString: world.store.db.urls.admin });
      await holder.connect();
      try {
        // The deletion waits at its taint call; the record call then waits behind it.
        await holder.query(`select pg_advisory_lock(${TAINT})`);
        const deletion = deleteMail(world, MAIL.canary);
        await until(() => waitingOnAdvisory(world));
        const recorded = reader.record(token, {
          kind: "note",
          body: "what the canary said",
          requestId: "request-forced-0002",
        });
        await until(
          async () =>
            one(
              await queryAs<{ n: number }>(
                world.store.db.urls.admin,
                "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted",
              ),
            ).n >= 2,
        );
        await holder.query(`select pg_advisory_unlock(${TAINT})`);
        expect(await deletion).toEqual({ recordsRemoved: 0 });
        expect(await recorded).toEqual({ ok: false, code: "not_found", refusal: "session_renewed" });
      } finally {
        await holder.end();
      }
      expect(await writesOf(world, "alpha")).toBe(0);
    }));

  it(
    "a record call and a deletion of an item its session read, run together in both orders a hundred times, never leave a record with a body that rests on the deleted item",
    { timeout: 1_200_000 },
    () =>
      inWorld(async (world) => {
        const outcomes = { ok: 0, not_found: 0 };
        for (const [order, client] of [
          ["record first", "alpha"],
          ["deletion first", "beta"],
        ] as const) {
          const token = await world.token(client);
          // A hundred reads and a hundred records, faster than the default 60 calls a minute
          // (the read quota): the client gets the most the bounds allow.
          await world.admin.clients.setQuota(client, { maxCallsMinute: 600 });
          for (let n = 0; n < 100; n += 1) {
            const fixture = mail({
              ...MAIL.solo,
              id: `gm-race-${client}-${n}`,
              threadId: `thread-race-${client}-${n}`,
              messageId: `race-${client}-${n}@one-message.test`,
              text: `Race message ${n}.`,
            });
            await ingestMail(world.writer, world.accounts.personalMail, fixture);
            const item = await itemOf(world.store.db, world.keys, "messages", mailSourceId(fixture));
            const reader = newSession(world);
            expect((await reader.readMessage(token, { id: item.id as never })).ok).toBe(true);
            const recording = () =>
              reader.record(token, {
                kind: "note",
                body: `what race message ${n} said`,
                requestId: `request-race-${client}-${String(n).padStart(4, "0")}`,
              });
            const deleting = () => world.writer.applyDeletion(world.accounts.personalMail, deletionOf(world, fixture));
            const answer =
              order === "record first"
                ? (await Promise.all([recording(), deleting()]))[0]
                : (await Promise.all([deleting(), recording()]))[1];
            if (answer.ok) outcomes.ok += 1;
            else {
              expect(answer).toEqual({ ok: false, code: "not_found", refusal: "session_renewed" });
              outcomes.not_found += 1;
            }
            expect(await resting(world, [item.evidence]), `${order} ${n}`).toEqual([]);
          }
        }
        expect(outcomes.ok + outcomes.not_found).toBe(200);
      }),
  );
});
