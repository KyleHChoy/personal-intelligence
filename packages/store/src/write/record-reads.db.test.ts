import {
  type AgentRecordArgs,
  AgentRecordId,
  type ClientId,
  type ContextPack,
  type PackItem,
  RECORD_READS_LISTED,
  type RecordReads,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Reader } from "../read/read.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { readAs, sqlState } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD_NOW } from "../test-support/world.ts";

// The store is seeded through the writer; the clients are inserted in SQL as pi_admin, each with
// its own `agent:` compartment, as read-packs.db.test.ts inserts its own. Every refusal has its
// control.

const AGENTS = Array.from({ length: 40 }, (_, index) => `r${index + 1}`);
const COMPARTMENTS = ["own", "employer:example", ...AGENTS.map((name) => `agent:${name}`)];
const TOOLS = ["get_self", "record", "build_context_pack", "record_reads"];

type Client = { id: ClientId; name: string; token: string };

let store: TestStore;
let next = 0;

beforeAll(async () => {
  store = await openStore({ now: WORLD_NOW, compartments: COMPARTMENTS });
  await seedWorld(store.writer, store.admin);
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store.close();
});

// A client of its own agent compartment and the clearance given, and, cleared for them, the agent
// compartments of the clients named.
async function newClient(
  clearance: string[],
  options: { readsOf?: Client[]; tools?: string[]; views?: string[] } = {},
): Promise<Client> {
  const name = AGENTS[next++];
  if (name === undefined) throw new Error("out of agent compartments");
  const compartments = [
    ...new Set([...clearance, `agent:${name}`, ...(options.readsOf ?? []).map((other) => `agent:${other.name}`)]),
  ];
  const client = { id: testId("cli") as ClientId, name, token: `pit_test-${name}-${testId("x")}` };
  await queryAs(
    store.db.urls.admin,
    `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
     values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6)`,
    [
      client.id,
      name,
      sha256Hex(client.token),
      compartments,
      options.views ?? ["self", "people"],
      options.tools ?? TOOLS,
    ],
  );
  return client;
}

const setClearance = (client: Client, compartments: string[]) =>
  queryAs(store.db.urls.admin, "update policy.clients set compartments = $2 where id = $1", [
    client.id,
    [...compartments, `agent:${client.name}`],
  ]);
const setViews = (client: Client, views: string[]) =>
  queryAs(store.db.urls.admin, "update policy.clients set views = $2 where id = $1", [client.id, views]);
const erase = (id: string) =>
  queryAs(store.db.urls.admin, "update ledger.agent_writes set body_enc = null, tainted_at = now() where id = $1", [
    id,
  ]);
// As the pipeline flags a record.
const flag = (id: string) =>
  queryAs(store.db.urls.pipeline, "update ledger.agent_writes set flagged_at = now() where id = $1", [id]);

const reader = (): Reader =>
  new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });

let requests = 0;
const argsOf = (kind: AgentRecordArgs["kind"], over: Partial<AgentRecordArgs> = {}): AgentRecordArgs => {
  requests += 1;
  return {
    kind,
    body: `a ${kind} for the receipts, number ${requests}`,
    requestId: `receipt-request-${String(requests).padStart(6, "0")}`,
    ...over,
  } as AgentRecordArgs;
};
const write = async (
  client: Client,
  kind: AgentRecordArgs["kind"],
  over: Partial<AgentRecordArgs> = {},
): Promise<string> => outcomeValue(await reader().record(client.token, argsOf(kind, over))).recordId;

const bootstrap = async (client: Client): Promise<ContextPack> =>
  outcomeValue(await reader().buildContextPack(client.token, { purpose: "agent_bootstrap" }));
const notesOf = (pack: ContextPack): string[] =>
  pack.items.filter((item: PackItem) => item.section === "notes").map((item) => item.id);

type Row = Record<string, unknown>;
const rowOf = async (id: string): Promise<Row | undefined> =>
  (await queryAs<Row>(store.db.urls.admin, "select * from ledger.agent_writes where id = $1", [id]))[0];
const rec = (id: string): AgentRecordId => AgentRecordId.parse(id);

describe("supersession", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a note supersedes the client's own earlier note on a new row; the earlier row is unchanged; a live correction refuses another", async () => {
    const alpha = await newClient(["own"]);
    const first = await write(alpha, "note");
    const before = await rowOf(first);
    const second = await write(alpha, "note", { supersedes: rec(first) });
    expect((await rowOf(second))?.supersedes).toBe(first);
    // The earlier row is never changed: every column as it was.
    expect(await rowOf(first)).toEqual(before);
    expect(before?.supersedes).toBeNull();
    // While its correction is live, a second record superseding it is refused, and nothing is written.
    const count = async () =>
      (
        await queryAs<{ n: number }>(
          store.db.urls.admin,
          "select count(*)::int as n from ledger.agent_writes where client_id = $1",
          [alpha.id],
        )
      )[0]?.n;
    const written = await count();
    expect(await reader().record(alpha.token, argsOf("note", { supersedes: rec(first) }))).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(await count()).toBe(written);
    // The control: the new record may itself be superseded.
    const third = await write(alpha, "note", { supersedes: rec(second) });
    expect((await rowOf(third))?.supersedes).toBe(second);
  });

  it("another client's record, another kind, an erased one and an unknown id answer not_found alike; a handoff supersedes nothing", async () => {
    const alpha = await newClient(["own"]);
    const beta = await newClient(["own"], { readsOf: [alpha] });
    const note = await write(alpha, "note");
    const finding = await write(alpha, "finding");
    const erased = await write(alpha, "note");
    await queryAs(
      store.db.urls.admin,
      "update ledger.agent_writes set body_enc = null, tainted_at = now() where id = $1",
      [erased],
    );
    const unknown = rec(`rec_${"0".repeat(26)}`);
    expect(await reader().record(beta.token, argsOf("note", { supersedes: rec(note) }))).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await reader().record(alpha.token, argsOf("note", { supersedes: rec(finding) }))).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await reader().record(alpha.token, argsOf("finding", { supersedes: rec(note) }))).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await reader().record(alpha.token, argsOf("note", { supersedes: rec(erased) }))).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await reader().record(alpha.token, argsOf("note", { supersedes: unknown }))).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(
      await reader().record(alpha.token, { ...argsOf("handoff"), supersedes: rec(note) } as AgentRecordArgs),
    ).toEqual({ ok: false, code: "invalid_request" });
    expect((await rowOf(note))?.supersedes).toBeNull();
    // The controls: each of the client's own, of its own kind.
    expect((await rowOf(await write(alpha, "note", { supersedes: rec(note) })))?.supersedes).toBe(note);
    expect((await rowOf(await write(alpha, "finding", { supersedes: rec(finding) })))?.supersedes).toBe(finding);
  });

  it("a correction erased, flagged or outside the caller's clearance refuses nothing, and a new one may be written", async () => {
    const alpha = await newClient(["own"]);
    const first = await write(alpha, "note");
    const erased = await write(alpha, "note", { supersedes: rec(first) });
    await erase(erased);
    const flagged = await write(alpha, "note", { supersedes: rec(first) });
    expect((await rowOf(flagged))?.supersedes).toBe(first);
    await flag(flagged);
    const live = await write(alpha, "note", { supersedes: rec(first) });
    expect((await rowOf(live))?.supersedes).toBe(first);
    // The control: a live correction refuses another.
    expect(await reader().record(alpha.token, argsOf("note", { supersedes: rec(first) }))).toEqual({
      ok: false,
      code: "invalid_request",
    });

    // A correction written under a wider clearance, which the client no longer holds: the refusal
    // would tell of a record it cannot read (invariant 6), so it is as if absent.
    const beta = await newClient(["own"]);
    const old = await write(beta, "note");
    await setClearance(beta, ["own", "employer:example"]);
    const wide = await write(beta, "note", { supersedes: rec(old) });
    expect(await reader().record(beta.token, argsOf("note", { supersedes: rec(old) }))).toEqual({
      ok: false,
      code: "invalid_request",
    });
    await setClearance(beta, ["own"]);
    expect(
      outcomeValue(await reader().recordReads(beta.token, { record: rec(old) })).records[0]?.supersededBy,
    ).toBeNull();
    const narrow = await write(beta, "note", { supersedes: rec(old) });
    expect((await rowOf(narrow))?.supersedes).toBe(old);
    expect((await rowOf(wide))?.supersedes).toBe(old);
    expect(outcomeValue(await reader().recordReads(beta.token, { record: rec(old) })).records[0]?.supersededBy).toBe(
      narrow,
    );
  });

  it("a record of the client's own that it cannot read under R8 (views narrowed, or flagged) answers not_found, as record_reads does", async () => {
    const alpha = await newClient(["own"]);
    const note = await write(alpha, "note");
    const flagged = await write(alpha, "finding");
    await flag(flagged);
    expect(await reader().record(alpha.token, argsOf("finding", { supersedes: rec(flagged) }))).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await reader().recordReads(alpha.token, { record: rec(flagged) })).toEqual({ ok: false, code: "not_found" });
    // Its writer held the people view; the client holds it no longer.
    await setViews(alpha, ["self"]);
    expect(await reader().recordReads(alpha.token, { record: rec(note) })).toEqual({ ok: false, code: "not_found" });
    expect(await reader().record(alpha.token, argsOf("note", { supersedes: rec(note) }))).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(
      (
        await queryAs<{ n: number }>(
          store.db.urls.admin,
          "select count(*)::int as n from ledger.agent_writes where supersedes = $1",
          [note],
        )
      )[0]?.n,
    ).toBe(0);
    // The control: with the view again, the record is superseded.
    await setViews(alpha, ["self", "people"]);
    expect((await rowOf(await write(alpha, "note", { supersedes: rec(note) })))?.supersedes).toBe(note);
  });

  it("a retry with its request id answers the same record; the same request id superseding another is refused", async () => {
    const alpha = await newClient(["own"]);
    const first = await write(alpha, "note");
    const other = await write(alpha, "note");
    const args = argsOf("note", { supersedes: rec(first) });
    const id = outcomeValue(await reader().record(alpha.token, args)).recordId;
    expect(outcomeValue(await reader().record(alpha.token, args)).recordId).toBe(id);
    expect(await reader().record(alpha.token, { ...args, supersedes: rec(other) })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    const { supersedes: _none, ...plain } = args;
    expect(await reader().record(alpha.token, plain)).toEqual({ ok: false, code: "invalid_request" });
  });
});

describe("agent_bootstrap@9's notes", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a note superseded by a record the caller sees is left out; the superseding one is served in its place", async () => {
    const alpha = await newClient(["own"]);
    const beta = await newClient(["own"], { readsOf: [alpha] });
    const old = await write(alpha, "note");
    const kept = await write(alpha, "note");
    expect(notesOf(await bootstrap(beta))).toEqual([kept, old]);
    const fixed = await write(alpha, "note", { supersedes: rec(old) });
    const pack = await bootstrap(beta);
    // agent_bootstrap@16 is the current template.
    expect(pack.template).toBe("agent_bootstrap@16");
    expect(notesOf(pack)).toEqual([fixed, kept]);
    // The writer's own pack too.
    expect(notesOf(await bootstrap(alpha))).toEqual([fixed, kept]);
    // Once the superseding record's body is removed, the earlier note is served again.
    await queryAs(
      store.db.urls.admin,
      "update ledger.agent_writes set body_enc = null, tainted_at = now() where id = $1",
      [fixed],
    );
    expect(notesOf(await bootstrap(beta))).toEqual([kept, old]);
  });

  it("agent-records, invariant 6: a caller that cannot see the superseding record is served the earlier note, as before", async () => {
    const alpha = await newClient(["own"]);
    const old = await write(alpha, "note");
    // Alpha's clearance widens: its correction is written under employer:example too.
    await setClearance(alpha, ["own", "employer:example"]);
    const fixed = await write(alpha, "note", { supersedes: rec(old) });
    expect((await rowOf(fixed))?.compartments).toEqual(expect.arrayContaining(["employer:example"]));
    // Narrow sees only the earlier note, and its pack is the one it was given before the correction.
    const narrow = await newClient(["own"], { readsOf: [alpha] });
    expect(notesOf(await bootstrap(narrow))).toEqual([old]);
    // The control: a caller cleared for both is served the correction alone.
    const wide = await newClient(["own", "employer:example"], { readsOf: [alpha] });
    expect(notesOf(await bootstrap(wide))).toEqual([fixed]);
  });
});

describe("chains of corrections", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an erased middle correction keeps the chain whole; a flagged one ends it", async () => {
    const alpha = await newClient(["own"]);
    const beta = await newClient(["own"], { readsOf: [alpha] });
    const first = await write(alpha, "note");
    const middle = await write(alpha, "note", { supersedes: rec(first) });
    const last = await write(alpha, "note", { supersedes: rec(middle) });
    expect(notesOf(await bootstrap(beta))).toEqual([last]);
    await erase(middle);
    // The original stays left out: its chain's newest correction is live.
    expect(notesOf(await bootstrap(beta))).toEqual([last]);
    expect(notesOf(await bootstrap(alpha))).toEqual([last]);
    expect(outcomeValue(await reader().recordReads(alpha.token, { record: rec(first) })).records[0]?.supersededBy).toBe(
      last,
    );
    expect(await reader().record(alpha.token, argsOf("note", { supersedes: rec(first) }))).toEqual({
      ok: false,
      code: "invalid_request",
    });

    // A flagged link is one no reader reads: the chain ends there, as if it were absent.
    const gamma = await newClient(["own"]);
    const delta = await newClient(["own"], { readsOf: [gamma] });
    const one = await write(gamma, "note");
    const two = await write(gamma, "note", { supersedes: rec(one) });
    const three = await write(gamma, "note", { supersedes: rec(two) });
    await flag(two);
    expect(notesOf(await bootstrap(delta))).toEqual([three, one]);
    expect(
      outcomeValue(await reader().recordReads(gamma.token, { record: rec(one) })).records[0]?.supersededBy,
    ).toBeNull();
    // The control: with its chain ended, the original may be corrected again.
    expect((await rowOf(await write(gamma, "note", { supersedes: rec(one) })))?.supersedes).toBe(one);
  });

  it("a correction whose body does not open is left out, and so is the note it corrected, until intake removes its body", async () => {
    const alpha = await newClient(["own"]);
    const beta = await newClient(["own"], { readsOf: [alpha] });
    const old = await write(alpha, "note");
    const fixed = await write(alpha, "note", { supersedes: rec(old) });
    expect(notesOf(await bootstrap(beta))).toEqual([fixed]);
    // The correction's tag no longer authenticates: its body does not open.
    await queryAs(
      store.db.urls.admin,
      "update ledger.agent_writes set body_enc = jsonb_set(body_enc, '{tag}', to_jsonb('AAAAAAAAAAAAAAAAAAAAAA=='::text)) where id = $1",
      [fixed],
    );
    const logged = store.log.events.length;
    expect(notesOf(await bootstrap(beta))).toEqual([]);
    expect(store.log.events.slice(logged)).toContainEqual(expect.objectContaining({ event: "pack_record_skipped" }));
    // Intake removes a body that does not open: the note it corrected is served again.
    await erase(fixed);
    expect(notesOf(await bootstrap(beta))).toEqual([old]);
  });
});

describe("record_reads", { timeout: DB_TEST_TIMEOUT }, () => {
  it("the author is told which other clients were shown its record, when and how often, and nothing of its body", async () => {
    const alpha = await newClient(["own"]);
    const beta = await newClient(["own"], { readsOf: [alpha] });
    const gamma = await newClient(["own"], { readsOf: [alpha] });
    const body = "a canary body record_reads never answers";
    const note = await write(alpha, "note", { body });
    const handoff = await write(alpha, "handoff");
    // Alpha holds `own` and its own agent compartment alone: it is not cleared for beta's or
    // gamma's, and is told of their reads all the same, since a receipt is labelled by the record
    // shown, not by the reader's clearance.
    // Nobody else has read it yet.
    const unread = outcomeValue(await reader().recordReads(alpha.token, { record: rec(note) }));
    expect(unread).toEqual({
      records: [
        { record: note, kind: "note", recordedAt: expect.any(String), supersededBy: null, erased: false, readers: [] },
      ],
      more: false,
    });
    // Beta is shown it twice, gamma once, and alpha's own pack is not a read.
    await bootstrap(beta);
    await bootstrap(beta);
    await bootstrap(gamma);
    await bootstrap(alpha);
    const read = outcomeValue(await reader().recordReads(alpha.token, { record: rec(note) }));
    const [entry] = read.records;
    // By client name, in code point order, as the function orders them.
    const counts = new Map([
      [beta.name, 2],
      [gamma.name, 1],
    ]);
    expect(entry?.readers.map((one) => [one.client, one.count])).toEqual(
      [...counts.keys()].sort().map((client) => [client, counts.get(client)]),
    );
    for (const one of entry?.readers ?? []) expect(one.firstAt <= one.lastAt).toBe(true);
    expect(JSON.stringify(read)).not.toContain(body);
    // A handoff is the caller's own and shown to nobody else: no reader.
    const listed = outcomeValue(await reader().recordReads(alpha.token, {}));
    expect(listed.records.map((one) => one.record)).toEqual([handoff, note]);
    expect(listed.records.find((one) => one.record === handoff)?.readers).toEqual([]);
  });

  it("a reader under a wider clearance is counted for the author's own record, and nothing else its read showed is told", async () => {
    const alpha = await newClient(["own"]);
    const note = await write(alpha, "note");
    const wide = await newClient(["own", "employer:example"], { readsOf: [alpha] });
    // The wide reader's pack also shows a note under a label alpha does not hold.
    const hidden = await write(wide, "note");
    expect((await rowOf(hidden))?.compartments).toEqual(expect.arrayContaining(["employer:example"]));
    await bootstrap(wide);
    const read = outcomeValue(await reader().recordReads(alpha.token, {}));
    expect(
      read.records.map((one) => [one.record, one.readers.map((reading) => [reading.client, reading.count])]),
    ).toEqual([[note, [[wide.name, 1]]]]);
    expect(JSON.stringify(read)).not.toContain(hidden);
    // The control: a record of alpha's own that it can no longer read is answered for nobody.
    const later = await newClient(["own", "employer:example"]);
    const wideNote = await write(later, "note");
    await setClearance(later, ["own"]);
    expect(await reader().recordReads(later.token, { record: rec(wideNote) })).toEqual({
      ok: false,
      code: "not_found",
    });
  });

  it("another client's record answers not_found, as an absent one does, whoever was shown it", async () => {
    const alpha = await newClient(["own"]);
    const beta = await newClient(["own"], { readsOf: [alpha] });
    const note = await write(alpha, "note");
    await bootstrap(beta);
    expect(await reader().recordReads(beta.token, { record: rec(note) })).toEqual({ ok: false, code: "not_found" });
    expect(await reader().recordReads(beta.token, { record: rec(`rec_${"0".repeat(26)}`) })).toEqual({
      ok: false,
      code: "not_found",
    });
    // Beta's list holds its own records alone: none.
    expect(outcomeValue(await reader().recordReads(beta.token, {}))).toEqual({ records: [], more: false });
    // The control: the author is answered.
    expect(
      outcomeValue(await reader().recordReads(alpha.token, { record: rec(note) })).records.map((one) => one.record),
    ).toEqual([note]);
  });

  it("the list shows which records were superseded and erased, newest first, at most 20 with more", async () => {
    const alpha = await newClient(["own"]);
    const old = await write(alpha, "note");
    const fixed = await write(alpha, "note", { supersedes: rec(old) });
    const erased = await write(alpha, "finding");
    await queryAs(
      store.db.urls.admin,
      "update ledger.agent_writes set body_enc = null, tainted_at = now() where id = $1",
      [erased],
    );
    const listed: RecordReads = outcomeValue(await reader().recordReads(alpha.token, {}));
    expect(listed.records.map((one) => [one.record, one.supersededBy, one.erased])).toEqual([
      [erased, null, true],
      [fixed, null, false],
      [old, fixed, false],
    ]);
    await erase(fixed);
    expect(
      outcomeValue(await reader().recordReads(alpha.token, { record: rec(old) })).records[0]?.supersededBy,
    ).toBeNull();
    expect(notesOf(await bootstrap(alpha))).toContain(old);
    for (let n = 0; n < 20; n += 1) await write(alpha, "note");
    const many = outcomeValue(await reader().recordReads(alpha.token, {}));
    expect(many.records).toHaveLength(RECORD_READS_LISTED);
    expect(many.more).toBe(true);
    expect(many.records.map((one) => one.record)).not.toContain(old);
  });

  it("the call needs the tool and the self view, logs an ok call and a read log row naming nothing, and logs no body or name", async () => {
    const alpha = await newClient(["own"]);
    const note = await write(alpha, "note", { body: "a canary body for the logs" });
    const logged = store.log.events.length;
    expect(outcomeValue(await reader().recordReads(alpha.token, { record: rec(note) })).records).toHaveLength(1);
    const rows = await queryAs<{ tool: string; bound: string[]; shown: string[] }>(
      store.db.urls.admin,
      "select tool, bound, shown from ledger.read_log where client_id = $1 and tool = 'record_reads'",
      [alpha.id],
    );
    expect(rows).toEqual([{ tool: "record_reads", bound: [], shown: [] }]);
    const calls = await queryAs<{ outcome: string }>(
      store.db.urls.admin,
      "select outcome from policy.calls where client_id = $1 and tool = 'record_reads'",
      [alpha.id],
    );
    expect(calls).toEqual([{ outcome: "ok" }]);
    const events = JSON.stringify(store.log.events.slice(logged));
    expect(events).not.toContain("canary");
    expect(events).not.toContain(alpha.name);
    // Without the tool, or without the self view: not_permitted, and nothing read.
    const noTool = await newClient(["own"], { tools: ["record", "build_context_pack"] });
    expect(await reader().recordReads(noTool.token, {})).toEqual({ ok: false, code: "not_permitted" });
    const noView = await newClient(["own"], { views: ["people"] });
    expect(await reader().recordReads(noView.token, {})).toEqual({ ok: false, code: "not_permitted" });
    // The database restates the gate: the function itself refuses either, called directly.
    const direct = (client: Client) =>
      sqlState(() => readAs(store.db, client.token, (query) => query("select * from policy.record_reads(null, 21)")));
    expect(await direct(noTool)).toBe("42501");
    expect(await direct(noView)).toBe("42501");
    expect(await direct(alpha)).toBeNull();
  });
});
