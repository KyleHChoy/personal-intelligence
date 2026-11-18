import { createHash } from "node:crypto";
import {
  type AgentRecordArgs,
  AgentRecordId,
  type ClientId,
  type EventId,
  MessageId,
} from "@intelligence/contracts/personal";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addCompartmentKey, loadKeys, reloadingKeys } from "../core/keys.ts";
import { openUnder } from "../core/seal.ts";
import { Reader } from "../read/read.ts";
import { ALL_VIEWS, hashFingerprint, sha256Hex, testId } from "../test-support/clients.ts";
import { one, readAs, sqlState } from "../test-support/connections.ts";
import { queryAs, scanForPlaintext } from "../test-support/database.ts";
import { ingestMail, type MailFixture, mail, mailFacts, mailRevision, mailSourceId } from "../test-support/items.ts";
import { orderFault } from "../test-support/order.ts";
import { readerReadProbes, readerWriteProbes } from "../test-support/probes.ts";
import { recordingPool } from "../test-support/recording.ts";
import { rowCounts } from "../test-support/snapshot.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue, registration, UNKNOWN_TOKEN } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";

// Reader.record. The store is seeded through the writer under `own` and `employer:example`; the
// clients that record are inserted in SQL as pi_admin, each with `record` among its tools and its
// own `agent:` compartment, since the admin still refuses a registration that lists record. Every
// refusal has its control.

// The agent compartments the key file holds: w1 to w40. A client named `keyless` has none.
const AGENTS = Array.from({ length: 40 }, (_, index) => `w${index + 1}`);
const COMPARTMENTS = ["own", "employer:example", ...AGENTS.map((name) => `agent:${name}`)];
const MISSING_MESSAGE = MessageId.parse(`msg_${"0".repeat(26)}`);
const CITE_MESSAGES = "select m.id, m.evidence_id from knowledge.messages m where m.id = any($1) order by m.id";
const CITE_EVENTS = "select v.id, v.evidence_id from knowledge.events v where v.id = any($1) order by v.id";

type Writer = { id: ClientId; name: string; token: string; compartments: string[] };

let store: TestStore;
let next = 0;
let own: { message: MessageId; evidence: string; event: EventId };
let personalMail: Awaited<ReturnType<typeof seedWorld>>["accounts"]["personalMail"];
let work: { message: MessageId };

beforeAll(async () => {
  store = await openStore({ now: WORLD_NOW, compartments: COMPARTMENTS });
  personalMail = (await seedWorld(store.writer, store.admin)).accounts.personalMail;
  const { token: ownToken } = await store.admin.clients.addClient(
    registration("seed-own", ["own"], { tools: ["find_messages", "get_self"] as never }),
  );
  const { token: workToken } = await store.admin.clients.addClient(
    registration("seed-work", ["employer:example"], { tools: ["find_messages"] as never }),
  );
  const message = outcomeValue(await store.reader.findMessages(ownToken, {})).messages[0]?.id as MessageId | undefined;
  const event = outcomeValue(await store.reader.getSelf(ownToken)).upcoming[0]?.id as EventId | undefined;
  const workMessage = outcomeValue(await store.reader.findMessages(workToken, {})).messages[0]?.id as
    | MessageId
    | undefined;
  if (message === undefined || event === undefined || workMessage === undefined)
    throw new Error("the world is missing a message or an event");
  const [row] = await queryAs<{ evidence_id: string }>(
    store.db.urls.admin,
    "select evidence_id from knowledge.messages where id = $1",
    [message],
  );
  own = { message, evidence: row?.evidence_id ?? "", event };
  work = { message: workMessage };
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store.close();
});

// A client that records: its own agent compartment and the clearance given, inserted as pi_admin.
async function newWriter(
  clearance: string[],
  options?: { name?: string; views?: string[]; tools?: string[] },
): Promise<Writer> {
  const name = options?.name ?? AGENTS[next++];
  if (name === undefined) throw new Error("out of agent compartments");
  const compartments = [...clearance, `agent:${name}`];
  const writer = { id: testId("cli") as ClientId, name, token: `pit_test-${name}-${testId("x")}`, compartments };
  await queryAs(
    store.db.urls.admin,
    `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
     values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6)`,
    [
      writer.id,
      name,
      sha256Hex(writer.token),
      compartments,
      options?.views ?? ALL_VIEWS,
      options?.tools ?? ["search", "get_self", "find_messages", "read_message", "record"],
    ],
  );
  return writer;
}

const freshReader = (options?: { rejectWhen?: (text: string) => boolean }) => {
  const recorded = recordingPool(store.readerPool, options);
  const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
  const during = async <T>(run: () => Promise<T>): Promise<{ answer: T; statements: string[] }> => {
    recorded.statements.length = 0;
    const answer = await run();
    // A record call takes the taint lock inside its read-committed transaction, so it holds none around it, as
    // sync_memory does not (FE1 holds it around the other reads).
    return { answer, statements: [...recorded.statements] };
  };
  return { reader, during };
};

let requests = 0;
const note = (over: Partial<AgentRecordArgs> = {}): AgentRecordArgs => ({
  kind: "note",
  body: `a note ${(requests += 1)}`,
  requestId: `request-${requests.toString().padStart(6, "0")}`,
  ...over,
});

type Row = {
  id: string;
  client_id: string;
  client_name: string;
  session_id: string;
  kind: string;
  compartments: string[];
  writer_views: string[];
  cites: string[];
  body_enc: unknown;
};
const rowsOf = (client: ClientId): Promise<Row[]> =>
  queryAs<Row>(
    store.db.urls.admin,
    "select id, client_id, client_name, session_id, kind, compartments, writer_views, cites, body_enc from ledger.agent_writes where client_id = $1 order by id",
    [client],
  );
const callsOf = async (client: ClientId): Promise<{ tool: string; rows: number; outcome: string }[]> =>
  queryAs(store.db.urls.admin, "select tool, rows, outcome from policy.calls where client_id = $1 order by id", [
    client,
  ]);
const readLogOf = (client: ClientId) =>
  queryAs(store.db.urls.admin, "select tool from ledger.read_log where client_id = $1", [client]);
const bodyOf = (row: Row, compartments: string[]): string =>
  openUnder(
    store.db.keys,
    compartments,
    { table: "ledger.agent_writes", id: row.id, column: "body_enc" },
    row.body_enc as never,
  );

describe("Reader.record", { timeout: DB_TEST_TIMEOUT }, () => {
  it("label forgery is refused and writes only its call-log row", async () => {
    const alpha = await newWriter(["own"]);
    const { reader } = freshReader();
    for (const field of [
      "label",
      "compartments",
      "compartment",
      "client",
      "session",
      "subject",
      "origin",
      "view",
      "views",
      "provenance",
    ]) {
      const forged = { ...note(), [field]: field === "compartments" ? ["public"] : "forged" } as AgentRecordArgs;
      expect(await reader.record(alpha.token, forged), field).toEqual({ ok: false, code: "invalid_request" });
    }
    expect(await rowsOf(alpha.id)).toEqual([]);
    expect((await callsOf(alpha.id)).map((row) => row.outcome)).toEqual(
      Array.from({ length: 10 }, () => "invalid_request"),
    );
    expect(
      await queryAs(store.db.urls.admin, "select id from ledger.sessions where client_id = $1", [alpha.id]),
    ).toEqual([]);
    // The control: the same arguments without the forged field are taken.
    expect((await reader.record(alpha.token, note())).ok).toBe(true);
  });

  it("an agent record's label is the agent compartment and the writer's whole clearance, in a session that read nothing and in one that read", async () => {
    const alpha = await newWriter(["own", "employer:example"]);
    const { reader } = freshReader();
    expect((await reader.record(alpha.token, note())).ok).toBe(true);
    expect((await reader.search(alpha.token, { query: "blake" })).ok).toBe(true);
    expect((await reader.record(alpha.token, note())).ok).toBe(true);
    const rows = await rowsOf(alpha.id);
    expect(rows.map((row) => row.compartments)).toEqual([
      [`agent:${alpha.name}`, "employer:example", "own"],
      [`agent:${alpha.name}`, "employer:example", "own"],
    ]);
    expect(new Set(rows.map((row) => row.session_id)).size).toBe(1);
  });

  it("a client cleared for own and employer:example writes only agent records carrying employer:example, as its first call", async () => {
    const alpha = await newWriter(["own", "employer:example"]);
    // A new process: a reader with no session for it.
    const { reader } = freshReader();
    expect((await reader.record(alpha.token, note({ cites: [own.message] }))).ok).toBe(true);
    const [row] = await rowsOf(alpha.id);
    expect(row?.compartments).toContain("employer:example");
    // The control: a client cleared for own alone writes none.
    const beta = await newWriter(["own"]);
    expect((await reader.record(beta.token, note())).ok).toBe(true);
    expect((await rowsOf(beta.id))[0]?.compartments).toEqual([`agent:${beta.name}`, "own"]);
  });

  it("no token, an unknown token and a revoked token write no row of any table", async () => {
    const alpha = await newWriter(["own"]);
    const revoked = await newWriter(["own"]);
    await queryAs(
      store.db.urls.admin,
      "update policy.clients set status = 'revoked', revoked_at = now() where id = $1",
      [revoked.id],
    );
    const { reader, during } = freshReader();
    const before = await rowCounts(store.db);
    const paths: string[][] = [];
    for (const token of ["", UNKNOWN_TOKEN, revoked.token]) {
      const { answer, statements } = await during(() => reader.record(token, note()));
      expect(answer).toEqual({ ok: false, code: "unauthorized" });
      expect(statements).toHaveLength(5);
      paths.push(statements);
    }
    for (const path of paths) expect(path).toEqual(paths[0]);
    expect(await rowCounts(store.db)).toEqual(before);
    // A5 is the revoked case; the control is a live client.
    expect((await reader.record(alpha.token, note())).ok).toBe(true);
  });

  it("a revoked client's record answers unauthorized and leaves no row", async () => {
    const alpha = await newWriter(["own"]);
    const { reader } = freshReader();
    expect((await reader.record(alpha.token, note())).ok).toBe(true);
    await queryAs(
      store.db.urls.admin,
      "update policy.clients set status = 'revoked', revoked_at = now() where id = $1",
      [alpha.id],
    );
    const calls = (await callsOf(alpha.id)).length;
    expect(await reader.record(alpha.token, note())).toEqual({ ok: false, code: "unauthorized" });
    expect(await rowsOf(alpha.id)).toHaveLength(1);
    expect(await callsOf(alpha.id)).toHaveLength(calls);
  });

  it("a client without record is answered not_permitted", async () => {
    const alpha = await newWriter(["own"], { tools: ["search"] });
    const { reader } = freshReader();
    expect(await reader.record(alpha.token, note())).toEqual({ ok: false, code: "not_permitted" });
    expect(await reader.refused(alpha.token, "record")).toEqual({ ok: false, code: "not_permitted" });
    expect(await rowsOf(alpha.id)).toEqual([]);
    expect((await callsOf(alpha.id)).map((row) => [row.tool, row.outcome])).toEqual([
      ["record", "not_permitted"],
      ["record", "not_permitted"],
    ]);
    // refused for a client that holds record, with no view check: invalid_request.
    const beta = await newWriter(["own"], { views: ["work"] });
    expect(await reader.refused(beta.token, "record")).toEqual({ ok: false, code: "invalid_request" });
    expect((await reader.record(beta.token, note())).ok).toBe(true);
  });

  it("no client writes under another client's agent compartment", async () => {
    const alpha = await newWriter(["own"]);
    const beta = await newWriter(["own", `agent:${alpha.name}`]);
    const { reader } = freshReader();
    expect((await reader.record(beta.token, note())).ok).toBe(true);
    const [row] = await rowsOf(beta.id);
    expect(row).toMatchObject({
      client_name: beta.name,
      compartments: [`agent:${alpha.name}`, `agent:${beta.name}`, "own"].sort(),
    });
    // As pi_reader with beta's token, a label of alpha's alone is refused.
    const session = row?.session_id;
    const refused = await readAs(store.db, beta.token, (query) =>
      query<{ outcome: string }>(
        "select outcome from policy.append_record($1, $2, 'request-forged-1', 'note', $3, $3, '{}', $4, '{}', '{}')",
        [session, testId("rec"), "c".repeat(64), [`agent:${alpha.name}`, "own"]],
      ),
    );
    expect(refused).toEqual([{ outcome: "label_mismatch" }]);
  });

  it("a client that lacks a compartment or a view the writer held does not see the agent record", async () => {
    const alpha = await newWriter(["own", "employer:example"], { views: ["self", "people", "work"] });
    const { reader } = freshReader();
    expect((await reader.record(alpha.token, note())).ok).toBe(true);
    const seen = async (writer: Writer): Promise<number> =>
      (
        await readAs(store.db, writer.token, (query) =>
          query("select id from ledger.agent_writes where client_name = $1", [alpha.name]),
        )
      ).length;
    expect(await seen(await newWriter(["own", "employer:example", `agent:${alpha.name}`]))).toBe(1);
    expect(await seen(await newWriter(["own", `agent:${alpha.name}`]))).toBe(0);
    expect(
      await seen(await newWriter(["own", "employer:example", `agent:${alpha.name}`], { views: ["self", "people"] })),
    ).toBe(0);
  });

  it("a hidden cite and an absent cite answer not_found with the same statements, and write only their call-log row", async () => {
    const alpha = await newWriter(["own"]);
    const { reader, during } = freshReader();
    const hidden = await during(() => reader.record(alpha.token, note({ cites: [work.message] })));
    const absent = await during(() => reader.record(alpha.token, note({ cites: [MISSING_MESSAGE] })));
    expect(hidden.answer).toEqual({ ok: false, code: "not_found" });
    expect(absent.answer).toEqual({ ok: false, code: "not_found" });
    expect(hidden.statements).toEqual(absent.statements);
    expect(await rowsOf(alpha.id)).toEqual([]);
    expect(
      await queryAs(store.db.urls.admin, "select id from ledger.sessions where client_id = $1", [alpha.id]),
    ).toEqual([]);
    expect((await callsOf(alpha.id)).map((row) => [row.tool, row.rows, row.outcome])).toEqual([
      ["record", 0, "not_found"],
      ["record", 0, "not_found"],
    ]);
    // The control: a visible message and a visible event are taken, as their evidence ids.
    expect((await reader.record(alpha.token, note({ cites: [own.message, own.event] }))).ok).toBe(true);
    const [row] = await rowsOf(alpha.id);
    const [event] = await queryAs<{ evidence_id: string }>(
      store.db.urls.admin,
      "select evidence_id from knowledge.events where id = $1",
      [own.event],
    );
    expect(row?.cites).toEqual([own.evidence, event?.evidence_id]);
  });

  it("no held message reaches a client through record", async () => {
    const alpha = await newWriter(["own"]);
    const { token: seedToken } = await store.admin.clients.addClient(
      registration(`held-seed-${testId("h").slice(-6).toLowerCase()}`, ["own"], { tools: ["find_messages"] as never }),
    );
    const [message] = outcomeValue(await store.reader.findMessages(seedToken, { limit: 50 })).messages.slice(-1);
    if (message === undefined) throw new Error("no message");
    await queryAs(store.db.urls.admin, "update knowledge.messages set held = true where id = $1", [message.id]);
    // The control this rests on: as pi_reader, with the client's token, the held row is not there.
    const visible = await readAs(store.db, alpha.token, (query) =>
      query("select id from knowledge.messages where id = $1", [message.id]),
    );
    expect(visible).toEqual([]);
    const { reader, during } = freshReader();
    const held = await during(() => reader.record(alpha.token, note({ cites: [message.id] })));
    const unknown = await during(() => reader.record(alpha.token, note({ cites: [MISSING_MESSAGE] })));
    expect(held.answer).toEqual({ ok: false, code: "not_found" });
    expect(held.statements).toEqual(unknown.statements);
    expect(await rowsOf(alpha.id)).toEqual([]);
    expect((await callsOf(alpha.id)).map((row) => row.outcome)).toEqual(["not_found", "not_found"]);
    // After the owner releases it, the same cite is taken.
    expect(await store.admin.held.releaseHeld({ id: message.id })).toEqual({ released: 1 });
    expect((await reader.record(alpha.token, note({ cites: [message.id] }))).ok).toBe(true);
  });

  it("replay, a reused id, a body of 8 001 code points and the 201st agent record", async () => {
    const alpha = await newWriter(["own"]);
    const { reader } = freshReader();
    const first = note({ cites: [own.message] });
    const ack = outcomeValue(await reader.record(alpha.token, first));
    expect(AgentRecordId.safeParse(ack.recordId).success).toBe(true);
    expect(await reader.record(alpha.token, first)).toEqual({ ok: true, value: ack });
    expect(await rowsOf(alpha.id)).toHaveLength(1);
    expect(await reader.record(alpha.token, { ...first, body: `${first.body} changed` })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(await reader.record(alpha.token, { ...first, kind: "finding" })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(await reader.record(alpha.token, { ...first, cites: [] })).toEqual({ ok: false, code: "invalid_request" });
    // 8 000 code points outside the basic plane is taken; 8 001 is not.
    expect((await reader.record(alpha.token, note({ body: "😀".repeat(8000) }))).ok).toBe(true);
    expect(await reader.record(alpha.token, note({ body: "a".repeat(8001) }))).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(
      await reader.record(alpha.token, note({ cites: Array.from({ length: 21 }, () => MISSING_MESSAGE) })),
    ).toEqual({ ok: false, code: "invalid_request" });
    expect(await reader.record(alpha.token, note({ requestId: "short" }))).toEqual({
      ok: false,
      code: "invalid_request",
    });
    for (let n = (await rowsOf(alpha.id)).length; n < 200; n += 1)
      expect((await reader.record(alpha.token, note())).ok).toBe(true);
    expect(await reader.record(alpha.token, note())).toEqual({ ok: false, code: "rate_limited" });
    expect(await rowsOf(alpha.id)).toHaveLength(200);
    // The replay of the first still answers within the bound.
    expect(await reader.record(alpha.token, first)).toEqual({ ok: true, value: ack });
  });

  it("a retry whose cited message no longer resolves answers not_found, and the first agent record stays as it was written", async () => {
    const alpha = await newWriter(["own"]);
    const { reader } = freshReader();
    // A world message no other test cites: the second newest of own.
    const { token: seedToken } = await store.admin.clients.addClient(
      registration(`retry-seed-${testId("r").slice(-6).toLowerCase()}`, ["own"], { tools: ["find_messages"] as never }),
    );
    const cite = outcomeValue(await store.reader.findMessages(seedToken, {})).messages[1]?.id;
    if (cite === undefined || cite === own.message) throw new Error("no second message");
    const args = note({ cites: [cite] });
    const ack = outcomeValue(await reader.record(alpha.token, args));
    const written = await rowsOf(alpha.id);
    expect(written.map((row) => row.id)).toEqual([ack.recordId]);
    await queryAs(store.db.urls.admin, "delete from knowledge.messages where id = $1", [cite]);
    expect(await reader.record(alpha.token, args)).toEqual({ ok: false, code: "not_found" });
    expect(await rowsOf(alpha.id)).toEqual(written);
  });

  // A message of Pat's under own, a month before the world's now, so no other test's newest
  // messages change: its id and evidence id as the store holds them.
  let retried = 0;
  async function revisedMessage(): Promise<{ fixture: MailFixture; id: MessageId; evidence: () => Promise<string> }> {
    retried += 1;
    const fixture = mail({
      id: `gm-retry-${retried}`,
      threadId: `thread-retry-${retried}`,
      at: new Date(WORLD_NOW.getTime() - (30 + retried) * 86_400_000).toISOString() as MailFixture["at"],
      from: { address: WORLD.ownOnly.address, name: WORLD.ownOnly.name },
      to: [{ address: WORLD.ownerPersonal }],
      subject: `retry subject ${retried}`,
      labels: ["INBOX"],
      text: `retry text ${retried}`,
    });
    if (personalMail === undefined) throw new Error("no personal mail account");
    expect(await ingestMail(store.writer, personalMail, fixture)).toBe("stored");
    const sourceFp = hashFingerprint(store.db.keys, "source_id", mailSourceId(fixture));
    const evidence = async (): Promise<string> =>
      one(
        await queryAs<{ evidence_id: string }>(
          store.db.urls.admin,
          "select m.evidence_id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_item_fp = $1",
          [sourceFp],
        ),
      ).evidence_id;
    const [row] = await queryAs<{ id: string }>(
      store.db.urls.admin,
      "select id from knowledge.messages where evidence_id = $1",
      [await evidence()],
    );
    return { fixture, id: MessageId.parse(row?.id), evidence };
  }
  const reviseIt = async (fixture: MailFixture): Promise<void> => {
    if (personalMail === undefined) throw new Error("no personal mail account");
    expect(await store.writer.ingestItem(personalMail, mailRevision(fixture, personalMail), mailFacts(fixture))).toBe(
      "stored",
    );
  };

  it("a retry after a new revision of a cited message answers the first acknowledgement and writes no second agent record", async () => {
    const alpha = await newWriter(["own"]);
    const { reader } = freshReader();
    const cited = await revisedMessage();
    const before = await cited.evidence();
    const args = note({ cites: [cited.id, own.event] });
    const ack = outcomeValue(await reader.record(alpha.token, args));
    const written = await rowsOf(alpha.id);
    await reviseIt(cited.fixture);
    // The message keeps its id; its evidence id is the new revision's.
    const after = await cited.evidence();
    expect(after).not.toBe(before);
    expect(
      (
        await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.messages where evidence_id = $1", [
          after,
        ])
      )[0]?.id,
    ).toBe(cited.id);
    expect(await reader.record(alpha.token, args)).toEqual({ ok: true, value: ack });
    // The same cites in another order are the same cites.
    expect(await reader.record(alpha.token, { ...args, cites: [own.event, cited.id] })).toEqual({
      ok: true,
      value: ack,
    });
    expect(await rowsOf(alpha.id)).toEqual(written);
    expect(written[0]?.cites[0]).toBe(before);
  });

  it("a retry with the same request id and other cites is refused, before and after a new revision of a cited message", async () => {
    const alpha = await newWriter(["own"]);
    const { reader } = freshReader();
    const cited = await revisedMessage();
    const args = note({ cites: [cited.id] });
    const ack = outcomeValue(await reader.record(alpha.token, args));
    const written = await rowsOf(alpha.id);
    // Before: another cite added, and the message swapped for another that resolves.
    expect(await reader.record(alpha.token, { ...args, cites: [cited.id, own.message] })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(await reader.record(alpha.token, { ...args, cites: [own.message] })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    await reviseIt(cited.fixture);
    expect(await reader.record(alpha.token, { ...args, cites: [cited.id, own.message] })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(await reader.record(alpha.token, { ...args, cites: [] })).toEqual({ ok: false, code: "invalid_request" });
    // The control: the cites first sent still answer the first acknowledgement.
    expect(await reader.record(alpha.token, args)).toEqual({ ok: true, value: ack });
    expect(await rowsOf(alpha.id)).toEqual(written);
  });

  // When the first is the first write ever under the client's label, the second waits on that
  // label's row in policy.labels (written by the first's trigger) before it reaches the unique key,
  // so `labelInUse` makes a prior write under the label first.
  const race = async (labelInUse: boolean) => {
    const alpha = await newWriter(["own"]);
    if (labelInUse) expect((await freshReader().reader.record(alpha.token, note())).ok).toBe(true);
    const before = (await rowsOf(alpha.id)).length;
    // The first reader's COMMIT waits at a gate, so its insert is made and not committed.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let atCommit: () => void = () => {};
    const reached = new Promise<void>((resolve) => (atCommit = resolve));
    const held = { on: true };
    const gated = new Proxy(store.readerPool, {
      get: (target, property) => {
        if (property !== "connect") return Reflect.get(target, property, target);
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get: (inner, name) => {
              if (name !== "query")
                return (
                  (Reflect.get(inner, name, inner) as unknown as (...args: unknown[]) => unknown)?.bind?.(inner) ??
                  Reflect.get(inner, name, inner)
                );
              return async (text: string, values?: unknown[]) => {
                if (held.on && /^\s*commit/i.test(text)) {
                  held.on = false;
                  atCommit();
                  await gate;
                }
                return inner.query(text, values);
              };
            },
          });
        };
      },
    }) as pg.Pool;
    const first = new Reader({ pool: gated, keys: store.db.keys, log: store.log, now: () => store.now });
    const second = freshReader().reader;
    const args = note();
    const firstCall = first.record(alpha.token, args);
    await reached;
    const secondCall = second.record(alpha.token, args);
    // Let the second reach the unique key and wait on the first.
    await new Promise((resolve) => setTimeout(resolve, 500));
    release();
    const [one1, two] = await Promise.all([firstCall, secondCall]);
    expect(one1.ok).toBe(true);
    expect(await rowsOf(alpha.id)).toHaveLength(before + 1);
    // Its retry answers the first acknowledgement.
    expect(await second.record(alpha.token, args)).toEqual(one1);
    return { first: one1, second: two };
  };

  it("the same request id sent by two connections at once writes one row", async () => {
    // The unique key refuses the second, which answers unavailable.
    const { second } = await race(true);
    expect(second).toEqual({ ok: false, code: "unavailable" });
  });

  it("under a label first used by the first call, the second waits on the label and answers the first acknowledgement; one row", async () => {
    const { first, second } = await race(false);
    expect(second).toEqual(first);
  });

  it("the two cite statements are in the order-by judge's kept list", async () => {
    expect(orderFault(CITE_MESSAGES)).toBeNull();
    expect(orderFault(CITE_EVENTS)).toBeNull();
    // They are what record sends.
    const alpha = await newWriter(["own"]);
    const { reader, during } = freshReader();
    const { statements } = await during(() => reader.record(alpha.token, note({ cites: [own.message] })));
    expect(statements).toContain(CITE_MESSAGES);
    expect(statements).toContain(CITE_EVENTS);
    for (const text of statements) expect(orderFault(text), text).toBeNull();
  });

  it("the body and its SHA-256 are in no column in plaintext", async () => {
    const alpha = await newWriter(["own"]);
    const { reader } = freshReader();
    const body = `canary-agent-record-${testId("c")}`;
    const hash = createHash("sha256").update(body, "utf8").digest("hex");
    expect((await reader.record(alpha.token, note({ body }))).ok).toBe(true);
    const [row] = await rowsOf(alpha.id);
    expect(row).toBeDefined();
    expect(bodyOf(row as Row, row?.compartments ?? [])).toBe(body);
    expect(await scanForPlaintext(store.db.urls.admin, [body, hash])).toEqual([]);
    // The control: the plain hash, once planted, is found.
    await queryAs(store.db.urls.writer, "update ledger.agent_writes set evidence_id = $2 where id = $1", [
      row?.id,
      hash,
    ]);
    expect(await scanForPlaintext(store.db.urls.admin, [hash])).toEqual([
      { table: "ledger.agent_writes", column: "evidence_id" },
    ]);
    await queryAs(store.db.urls.writer, "update ledger.agent_writes set evidence_id = null where id = $1", [row?.id]);
  });

  it("an agent record sealed under three compartments opens for a client cleared for all of them and for no other", async () => {
    const alpha = await newWriter(["own", "employer:example"]);
    const { reader } = freshReader();
    expect((await reader.record(alpha.token, note({ body: "three compartments" }))).ok).toBe(true);
    const [row] = await rowsOf(alpha.id);
    const label = row?.compartments ?? [];
    expect(label).toHaveLength(3);
    expect(bodyOf(row as Row, label)).toBe("three compartments");
    const keysOf = (names: string[]) => ({
      ...store.db.keys,
      compartments: new Map([...store.db.keys.compartments].filter(([name]) => names.includes(name))),
    });
    for (const fewer of [label.slice(1), label.slice(0, 2), [label[0] ?? "", label[2] ?? ""]]) {
      expect(() =>
        openUnder(
          keysOf(fewer),
          label,
          { table: "ledger.agent_writes", id: row?.id ?? "", column: "body_enc" },
          row?.body_enc as never,
        ),
      ).toThrow();
    }
    expect(
      openUnder(
        keysOf(label),
        label,
        { table: "ledger.agent_writes", id: row?.id ?? "", column: "body_enc" },
        row?.body_enc as never,
      ),
    ).toBe("three compartments");
  });

  it("a compartment the key file lacks answers unavailable and writes nothing", async () => {
    const keyless = await newWriter(["own"], { name: "keyless" });
    const { reader } = freshReader();
    const events = store.log.events.length;
    expect(await reader.record(keyless.token, note())).toEqual({ ok: false, code: "unavailable" });
    expect(store.log.events.slice(events)).toEqual([{ event: "read_failed", code: "unavailable" }]);
    expect(await rowsOf(keyless.id)).toEqual([]);
    expect(await callsOf(keyless.id)).toEqual([]);
    expect(
      await queryAs(store.db.urls.admin, "select id from ledger.sessions where client_id = $1", [keyless.id]),
    ).toEqual([]);
  });

  it("a client given record after a long-running reader started records at its first call, with no restart", async () => {
    // As `pi http` holds them: the key file as it is on disk at each call. The control holds the
    // file as it was read once, before the client's key was added, as the box did.
    const reloading = new Reader({
      pool: store.readerPool,
      keys: await reloadingKeys(store.db.keyFile),
      log: store.log,
      now: () => store.now,
    });
    const once = new Reader({
      pool: store.readerPool,
      keys: await loadKeys(store.db.keyFile),
      log: store.log,
      now: () => store.now,
    });
    // What `pia clients add late --tools ...,record` does: the key first, then the registration.
    await addCompartmentKey(store.db.keyFile, "agent:late");
    const late = await newWriter(["own"], { name: "late" });
    expect(await once.record(late.token, note())).toEqual({ ok: false, code: "unavailable" });
    expect(await rowsOf(late.id)).toEqual([]);
    expect((await reloading.record(late.token, note())).ok).toBe(true);
    const [row] = await rowsOf(late.id);
    expect(row?.compartments).toEqual(["agent:late", "own"]);
    expect(
      openUnder(
        await loadKeys(store.db.keyFile),
        row?.compartments ?? [],
        { table: "ledger.agent_writes", id: row?.id ?? "", column: "body_enc" },
        row?.body_enc as never,
      ),
    ).toMatch(/^a note /);
  });

  it("each outcome writes exactly one policy.calls row, and unauthorized writes none", async () => {
    const alpha = await newWriter(["own"]);
    const without = await newWriter(["own"], { tools: ["search"] });
    const { reader } = freshReader();
    const args = note();
    expect((await reader.record(alpha.token, args)).ok).toBe(true);
    expect((await reader.record(alpha.token, args)).ok).toBe(true);
    expect((await reader.record(alpha.token, { ...args, body: "other" })).ok).toBe(false);
    expect((await reader.record(alpha.token, note({ cites: [MISSING_MESSAGE] }))).ok).toBe(false);
    expect((await reader.record(alpha.token, { kind: "nope" } as never)).ok).toBe(false);
    expect((await reader.record(without.token, note())).ok).toBe(false);
    expect((await reader.record(UNKNOWN_TOKEN, note())).ok).toBe(false);
    expect((await callsOf(alpha.id)).map((row) => [row.tool, row.rows, row.outcome])).toEqual([
      ["record", 1, "ok"],
      ["record", 1, "ok"],
      ["record", 0, "invalid_request"],
      ["record", 0, "not_found"],
      ["record", 0, "invalid_request"],
    ]);
    expect((await callsOf(without.id)).map((row) => row.outcome)).toEqual(["not_permitted"]);
    // rate_limited is logged as such.
    await queryAs(store.db.urls.bootstrap, "select 1");
    for (let n = 1; n < 200; n += 1) expect((await reader.record(alpha.token, note())).ok).toBe(true);
    expect((await reader.record(alpha.token, note())).ok).toBe(false);
    expect((await callsOf(alpha.id)).at(-1)).toEqual({ tool: "record", rows: 0, outcome: "rate_limited" });
  });

  it("a record call writes no read log row", async () => {
    const alpha = await newWriter(["own"]);
    const { reader } = freshReader();
    expect((await reader.record(alpha.token, note({ cites: [own.message] }))).ok).toBe(true);
    expect(await readLogOf(alpha.id)).toEqual([]);
    // The control: a read by the same client is logged, under the session the record opened.
    expect((await reader.search(alpha.token, { query: "blake" })).ok).toBe(true);
    expect(await readLogOf(alpha.id)).toEqual([{ tool: "search" }]);
    expect(
      await queryAs(store.db.urls.admin, "select count(*)::int as n from ledger.sessions where client_id = $1", [
        alpha.id,
      ]),
    ).toEqual([{ n: 1 }]);
  });

  it("a database error answers unavailable and carries no value", async () => {
    const alpha = await newWriter(["own"]);
    const failing = { on: true };
    const { reader } = freshReader({ rejectWhen: (text) => failing.on && /append_record/.test(text) });
    const events = store.log.events.length;
    expect(await reader.record(alpha.token, note())).toEqual({ ok: false, code: "unavailable" });
    expect(store.log.events.slice(events)).toEqual([{ event: "read_failed", code: "unavailable" }]);
    expect(await rowsOf(alpha.id)).toEqual([]);
    expect(await callsOf(alpha.id)).toEqual([]);
    failing.on = false;
    expect((await reader.record(alpha.token, note())).ok).toBe(true);
  });

  it("pi_reader cannot write any table, reads from ledger only its columns of agent_writes, and executes exactly its functions", async () => {
    const alpha = await newWriter(["own"]);
    const writes = await readerWriteProbes(store.db, alpha.token);
    expect(writes.length).toBeGreaterThan(0);
    for (const probe of writes) {
      expect(probe.refused, probe.sql).toBe("42501");
      expect(probe.control, `control: ${probe.sql}`).toBeNull();
    }
    for (const probe of await readerReadProbes(store.db, alpha.token)) expect(probe.refused, probe.sql).toBe("42501");
    for (const table of ["ledger.sessions", "ledger.read_log"]) {
      expect(
        await sqlState(() => readAs(store.db, alpha.token, (query) => query(`select count(*) from ${table}`))),
        table,
      ).toBe("42501");
    }
    expect(
      await sqlState(() =>
        readAs(store.db, alpha.token, (query) => query("select id, body_enc from ledger.agent_writes")),
      ),
    ).toBeNull();
    // And the rows of the owner surface's two tables its row policies allow.
    for (const table of ["ledger.basis", "ledger.record_events"]) {
      expect(
        await sqlState(() => readAs(store.db, alpha.token, (query) => query(`select count(*) from ${table}`))),
        table,
      ).toBeNull();
    }
    const functions = await queryAs<{ name: string }>(
      store.db.urls.admin,
      `select n.nspname || '.' || p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('policy', 'vault', 'knowledge', 'projections', 'ledger') and has_function_privilege('pi_reader', p.oid, 'EXECUTE') order by 1`,
    );
    // ledger.label is the reader's too, as gate.db.test.ts pins.
    expect(functions.map((row) => row.name)).toEqual([
      // A move's watches, on the caller's own move.
      "ledger.add_watches",
      // An agent's messages and the improvement store.
      "ledger.agent_inbox",
      // The learnings active for the caller, for agent_bootstrap@15.
      "ledger.agent_learnings_for",
      // An agent's answer on the card whose task it holds.
      "ledger.answer_card",
      // The owner's reply to a question the caller holds.
      "ledger.answer_owner_question",
      // The one way an agent writes a same-person answer.
      "ledger.answer_same_person",
      "ledger.append_draft",
      "ledger.append_gate_decision",
      "ledger.append_step",
      // Who holds each item on the board.
      "ledger.board_holders",
      // The card kinds an agent is asked first, and the card of a task the caller sees.
      "ledger.card_attempt_kinds",
      "ledger.card_question",
      "ledger.card_relay_question",
      // The change feed, and which roles own which signal.
      "ledger.change_feed",
      "ledger.changes_quick",
      "ledger.check_back_blocked",
      "ledger.claim",
      // An agent's close of a commitment, and its retry's first answer.
      "ledger.close_commitment",
      "ledger.close_replayed",
      // The gate's contact check.
      "ledger.contact_candidates",
      "ledger.count_session_taint",
      // Which of the given items the caller declined.
      "ledger.declined_by_caller",
      "ledger.draft_accounts",
      // A dream finding's brief, for the agent holding its task.
      "ledger.dream_finding_brief",
      // An agent files a learning for the agents of its scope.
      "ledger.file_learning",
      // One client research request.
      "ledger.file_research",
      "ledger.finish_run",
      "ledger.gate_facts",
      // A task's hand-off and proposal.
      "ledger.hand_off",
      "ledger.health_read",
      "ledger.improvement_events_of",
      // The label of a defect the caller sees, to seal a status note under.
      "ledger.improvement_label",
      // An agent's anchors and time rulings.
      "ledger.judge_time_proposal",
      // The defects the defect role is working on, for agent_bootstrap's known issues.
      "ledger.known_issues",
      "ledger.label",
      // Whether another client's lapsed lease holds each piece of work.
      "ledger.lapse_held",
      "ledger.lift_anchor",
      "ledger.lift_time_ruling",
      // The ideas the caller can see, newest evidence first.
      "ledger.list_ideas",
      "ledger.list_improvements",
      "ledger.live_held_out_questions",
      // An agent marks a box health card seen that needs nothing of the owner.
      "ledger.mark_health_seen",
      // A recorded meeting the caller is cleared for, for read_meeting and a meeting fact's passage.
      "ledger.meeting_transcript",
      // The caller's own record over the last 28 days.
      "ledger.my_agent_record",
      // The caller's own bets and their budget.
      "ledger.my_bets",
      // The caller's own bets and questions over the last seven days, for its pack's standing.
      "ledger.my_standing",
      "ledger.next_run",
      // An owner_queue task's counts for its brief.
      "ledger.owner_queue_question",
      "ledger.pay_question",
      // The project and dependencies of work the caller just proposed. A task the caller just
      // proposed, marked a bet within its budget.
      "ledger.place_bet",
      "ledger.place_work",
      "ledger.plan_move",
      "ledger.post_agent_message",
      // The agent that made each project the caller sees.
      "ledger.project_creators",
      // An agent's goal proposal and its card.
      "ledger.propose_goal",
      // An agent's proposal of who a goal is after.
      "ledger.propose_goal_target",
      "ledger.propose_hypothesis",
      "ledger.propose_opportunity",
      // An agent's project, and its changes to one.
      "ledger.propose_project",
      "ledger.propose_task",
      "ledger.record_held_out_question",
      "ledger.record_outcome_task",
      // What the task executor spent, and whether it may go on.
      "ledger.record_spend",
      "ledger.record_test",
      "ledger.relay_card_answer",
      "ledger.release",
      // An agent reopens its own close.
      "ledger.reopen_close",
      // The eight-argument form beside the seven-argument wrapper.
      "ledger.report_move",
      "ledger.report_move",
      "ledger.report_wrong_merge",
      // An agent's report that a model's relation is wrong.
      "ledger.report_wrong_relation",
      "ledger.rule_time",
      // The owner's actions on a run.
      "ledger.run_owner_actions",
      // The mixed-session mark's two booleans about the caller's own session.
      "ledger.session_path",
      "ledger.set_anchor",
      // A proposal's details, on the caller's own new row.
      "ledger.set_details",
      // A proposal's expectations, on the caller's own new row.
      "ledger.set_expectations",
      // The eight-argument form with the note beside the seven-argument wrapper.
      "ledger.set_intention",
      "ledger.set_intention",
      // An agent's settlement of a dream finding whose task it holds.
      "ledger.settle_belief",
      "ledger.signal_roles",
      "ledger.start_outcome_test",
      "ledger.submit_improvement",
      // The board's order by whether work was used, within the caller's clearance.
      "ledger.task_standing",
      "ledger.update_improvement",
      "ledger.update_project",
      "ledger.use_only_candidates",
      "ledger.work_grants",
      // The latest progress on each piece of work.
      "ledger.work_progress",
      "ledger.work_stopped",
      // The titles a title role is served in get_work_time, and which name an erased person.
      "ledger.work_time_title_suppressed",
      "ledger.work_time_titles",
      "ledger.work_trail",
      // What an agent wrote back on a signal.
      "ledger.write_back",
      // Which of the given claims an agent confirmed.
      "policy.agent_confirmed_claims",
      "policy.append_record",
      // A belief's inputs under the caller's clearance.
      "policy.belief_inputs",
      // The device's erased keys for its push's ack.
      "policy.capture_erased_since_push",
      // The caller's keys, its id mode and the two handle functions.
      "policy.clearance_keys",
      "policy.client_clearance",
      // What closed a commitment the caller reads.
      "policy.commitment_closes",
      // Which of a token's claim keys the owner confirmed.
      "policy.confirmed_claims",
      // A client's confirmed client-scoped preferences.
      "policy.confirmed_preferences",
      "policy.current_client",
      "policy.current_client_kind",
      "policy.current_id_mode",
      // The caller's roles and every active agent's.
      "policy.current_roles",
      // The caller's own goal proposals the owner rejected.
      "policy.declined_goal_proposals",
      // Whether every reader withholds an entity the caller sees.
      "policy.entity_withheld",
      // The erasure mark, for pi mcp's start check.
      "policy.erasure_mark",
      // The rest of the agent records' writes.
      // Whether a group's chat lines are newer than the caller's warmth build, one boolean.
      "policy.group_chat_newer",
      "policy.import_memory",
      // Whether a label holds a restricted compartment, for every runtime role.
      "policy.is_restricted",
      // The start check's mark over every kind of journal entry.
      "policy.journal_mark",
      "policy.label_key",
      // The levers' stored values and each one's last change, for list_levers.
      "policy.levers_read",
      // The live corrections and a record's read receipts.
      "policy.live_corrections",
      // The four-argument log_call beside the three-argument one, and the read quota check.
      "policy.log_call",
      "policy.log_call",
      // With why a call was refused.
      "policy.log_call",
      "policy.log_pack",
      "policy.log_read",
      // A mirror call's two reads of its own mirror state.
      "policy.mirror_cursor",
      "policy.mirror_tokens",
      // The caller's own confirm rates, counts only.
      "policy.my_confirm_rates",
      // pi http's five OAuth steps.
      "policy.oauth_authorize",
      "policy.oauth_exchange",
      "policy.oauth_refresh",
      "policy.oauth_register",
      "policy.oauth_registration",
      // What closed an open item the caller reads.
      "policy.open_item_closes",
      "policy.open_session",
      // The owner's own closes in force, within the caller's clearance.
      "policy.owner_commitment_closes",
      "policy.propose_about_you",
      // A proposal about a person.
      "policy.propose_person",
      // A device's push. ledger.capture_erased is pi_admin's alone.
      "policy.push_capture",
      "policy.read_allowance",
      "policy.record_label",
      "policy.record_reads",
      // Which of the given claims the owner's relayed confirm answered.
      "policy.relayed_claims",
      // The releases in force, inside find_facts' and the cites' reads.
      "policy.released_records",
      // One sync of the current client's memory file.
      "policy.serve_memory",
      // One call of a mirror client's read. Its taint and its ending are pi_admin's alone.
      "policy.serve_mirror",
      // An agent's change to a lever it may move.
      "policy.set_lever",
      // The caller's own records the owner's reply settled, for get_suggestions.
      "policy.settled_records",
      "policy.view_keys",
      // The owner's ignores and tier rulings under the caller's clearance, which warmth is ranked
      // with at read.
      "policy.warmth_ignored",
      "policy.warmth_rulings",
      // The entities every reader withholds from the caller.
      "policy.withheld_entities",
      // A finding's typed claims, refusing a caller without record.
      "policy.write_typed_claims",
    ]);
    expect(
      one(
        await queryAs<{ n: number }>(
          store.db.urls.admin,
          "select count(*)::int as n from ledger.agent_writes where client_id = $1",
          [alpha.id],
        ),
      ).n,
    ).toBe(0);
  });
});
