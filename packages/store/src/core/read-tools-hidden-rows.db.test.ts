import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityId, MessageId } from "@intelligence/contracts/personal";
import { gmailItemId } from "@intelligence/personal-core";
import { HIDDEN_ONLY } from "@intelligence/personal-core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { Reader } from "../read/read.ts";
import { KNOWLEDGE } from "../test-support/catalogue-grants.ts";
import { readAs } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { type Ask, asksOf, hiddenAsks, transcript } from "../test-support/hidden-rows-asks.ts";
import {
  addHidden,
  HIDDEN,
  type HiddenAdded,
  INV6_NOW,
  type Inv6,
  openInv6,
  settle,
} from "../test-support/hidden-rows-world.ts";

// I1, the read tools' part: with every ask a viewer cleared for `own` alone can make of the read
// tools, the replies are byte-identical before and after the hidden twin's rows are added under
// employer:example, and again after each of: a hidden item deleted at the source, a hidden item
// erased, a hidden person erased, and another client's work under employer:example. Every comparison
// has its control: two runs of one world compare equal, and a client that can see the added rows is
// given different replies. Not yet covered here: the work, run and propose tools and `record`, a
// re-derive under employer:example and a `pi extract` over hidden items.
//
// Do not weaken, skip or delete this test to make a change pass.

// Above SLOW_DB_TEST_TIMEOUT (test-support/timeouts.ts): every read tool ask is replayed over
// two hidden-rows worlds and each change to them.
const TIMEOUT = 1_800_000;
// Enough hidden rows that every person, sender, domain and thread has many it cannot see.
const PER_TABLE = 600;

let s: Inv6;
let asks: Ask[];
let base: string[];
let wideBase: string[];
let added: HiddenAdded;
let hidden: string[];
let journalDir: string;

// What a viewer cleared for `own` sees of each table, as counts: the same before and after.
const seen = (token: string): Promise<Record<string, number>> =>
  readAs(s.store.db, token, async (query) => {
    const counts: Record<string, number> = {};
    for (const table of [...KNOWLEDGE.map((one) => one.name), "ledger.agent_writes"]) {
      const column = KNOWLEDGE.find((one) => one.name === table)?.column ?? "id";
      counts[table] = (await query(`select ${column} from ${table}`)).length;
    }
    return counts;
  });

let seenBefore: Record<string, number>;

beforeAll(async () => {
  s = await openInv6();
  asks = await asksOf(s);
  base = await transcript(s, asks);
  wideBase = await transcript(s, asks, s.wide);
  seenBefore = await seen(s.viewer);
  added = await addHidden(s, PER_TABLE);
  hidden = await transcript(s, asks);
  journalDir = await mkdtemp(join(tmpdir(), "pi-inv6-"));
}, TIMEOUT);

afterAll(async () => {
  await s?.close();
  if (journalDir !== undefined) await rm(journalDir, { recursive: true, force: true });
});

// The first line that differs, for a readable failure.
const firstDifference = (a: string[], b: string[]): string | null => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1)
    if (a[index] !== b[index]) return `${a[index] ?? "(none)"}\n--- became ---\n${b[index] ?? "(none)"}`;
  return null;
};

describe("I1: the viewer's transcript does not change with rows it cannot see", { timeout: TIMEOUT }, () => {
  it("the asks reach every read tool, and the base world gives the viewer something to see", () => {
    const tools = new Set(asks.map((one) => one.ask.split(" ")[0]));
    expect([...tools].sort()).toEqual([
      "build_context_pack",
      "find_facts",
      "find_messages",
      "get_changes",
      "get_commitments",
      "get_entity",
      "get_open_items",
      "get_self",
      "get_timeline",
      "read_message",
      "search",
    ]);
    expect(base.filter((line) => line.includes('"ok":true')).length).toBeGreaterThan(asks.length / 4);
    expect(base.some((line) => line.startsWith("find_facts\t") && line.includes('"facts":[{'))).toBe(true);
  });

  it("an own-cleared client sees the same rows in both worlds", async () => {
    expect(await seen(s.viewer)).toEqual(seenBefore);
  });

  it("the hidden twin added rows under employer:example in every table it names", async () => {
    const counts = await queryAs<{
      messages: number;
      events: number;
      claims: number;
      records: number;
    }>(
      s.store.db.urls.admin,
      `select (select count(*)::int from knowledge.messages where compartments = '{employer:example}') as messages,
              (select count(*)::int from knowledge.events where compartments = '{employer:example}') as events,
              (select count(*)::int from knowledge.claims where compartments = '{employer:example}') as claims,
              (select count(*)::int from ledger.agent_writes where 'employer:example' = any (compartments)) as records`,
    );
    const [row] = counts;
    for (const [table, count] of Object.entries(row ?? {})) expect(count, table).toBeGreaterThanOrEqual(PER_TABLE / 2);
  });

  it("every reply is byte-identical after the hidden rows are added", () => {
    expect(firstDifference(base, hidden)).toBeNull();
    expect(hidden).toEqual(base);
  });

  it("control: two runs of one world compare equal", async () => {
    expect(await transcript(s, asks)).toEqual(hidden);
  });

  it("control: a client cleared for both compartments is given different replies", async () => {
    const wideHidden = await transcript(s, asks, s.wide);
    expect(wideHidden).not.toEqual(wideBase);
  });

  it("each id known only in hidden rows answers exactly as an id that is not there", async () => {
    const pairs = hiddenAsks(added);
    // Each kind is asked: people only employer:example knows, its messages and its events.
    expect(added.entities.length).toBeGreaterThan(0);
    expect(added.messages.length).toBeGreaterThan(0);
    expect(added.events.length).toBeGreaterThan(0);
    for (const { hidden: one, absent } of pairs) {
      const [got, want] = [await transcript(s, [one]), await transcript(s, [absent])];
      expect(got[0]?.split("\t")[1], one.ask).toBe(want[0]?.split("\t")[1]);
    }
  });

  it("after a hidden item is deleted at the source, the replies are unchanged", async () => {
    const work = s.base.accounts.find((one) => one.compartment === HIDDEN);
    if (work === undefined) throw new Error("no hidden account");
    const mail = await s.store.writer.ensureSourceAccount(work.label, "google_mail", work.compartment, work.address);
    // The second hidden message: one the owner sent, so it was stored; and it is gone after.
    const hiddenMessages = async (): Promise<number> =>
      (
        await queryAs<{ n: number }>(
          s.store.db.urls.admin,
          "select count(*)::int as n from knowledge.messages where compartments = '{employer:example}'",
        )
      )[0]?.n ?? 0;
    const was = await hiddenMessages();
    await s.store.writer.applyDeletion(mail, {
      sourceAccount: mail.id,
      sourceItemId: gmailItemId(`19f${(1).toString(16).padStart(13, "0")}`),
      deletedAt: new Date().toISOString() as never,
    });
    expect(await hiddenMessages()).toBe(was - 1);
    await settle(s);
    expect(firstDifference(base, await transcript(s, asks))).toBeNull();
  });

  it("after a hidden item and a hidden person are erased, the replies are unchanged", async () => {
    const admin = new Admin({
      pool: s.store.adminPool,
      keys: s.store.db.keys,
      log: s.store.log,
      journal: join(journalDir, "keys.json.erasures"),
      recordEnabled: true,
    });
    const message = added.messages.at(-1);
    if (message === undefined) throw new Error("no hidden message");
    await admin.erasure.eraseItem({ kind: "message", id: message as MessageId }, { requestId: "inv6-erase-item-0001" });
    // One of the hidden twin's own people, whom no base world item names (hidden-world.test.ts checks
    // it). Erasing a person removes every item that names it, by any route, in every compartment, so a
    // person picked by random entity id among those with only employer:example accounts could be one the
    // owner's own mail names: the base world's "Spare tickets" names flor.ibarra only on its To, and
    // that person's erasure rightly removed it.
    const [person] = await queryAs<{ id: string }>(
      s.store.db.urls.admin,
      `select distinct e.id from knowledge.entities e join knowledge.accounts a on a.entity_id = e.id
       where e.kind = 'person' and a.value_fp = $1
         and not exists (select 1 from knowledge.accounts o where o.entity_id = e.id and not o.compartments <@ '{employer:example}'::text[])`,
      [fingerprint(s.store.db.keys, "address", (HIDDEN_ONLY[0] as { address: string }).address)],
    );
    if (person === undefined) throw new Error("the hidden twin's own person is not known only under employer:example");
    await admin.erasure.erasePerson(person.id as EntityId, { requestId: "inv6-erase-person-0001" });
    await settle(s);
    expect(firstDifference(base, await transcript(s, asks))).toBeNull();
  });

  // Another client's work, in its own setup: the wide client, served by a reader of its own as a second
  // process would serve it, so its session is new and has read nothing the delete and erase tests above
  // removed. It reads, then records what it read under employer:example; only then is the viewer's transcript
  // compared.
  it("another client reads and records under employer:example", async () => {
    const other = new Reader({
      pool: s.store.readerPool,
      keys: s.store.db.keys,
      log: s.store.log,
      now: () => INV6_NOW,
    });
    for (const { call } of asks.slice(0, 40)) await call(other, s.wide);
    // Hidden messages it reads whole, so what it records rests on employer:example.
    for (const id of added.messages.slice(0, 5)) await other.readMessage(s.wide, { id: id as MessageId });
    for (let k = 0; k < 20; k += 1) {
      const answer = await other.record(s.wide, {
        kind: "handoff",
        body: `Wide handoff ${k}.`,
        requestId: `inv6-wide-${String(k).padStart(8, "0")}`,
      });
      expect(answer.ok, `record ${k}`).toBe(true);
    }
    const [row] = await queryAs<{ n: number }>(
      s.store.db.urls.admin,
      "select count(*)::int as n from ledger.agent_writes where request_id like 'inv6-wide-%' and 'employer:example' = any (compartments)",
    );
    expect(row?.n).toBe(20);
  });

  it("after another client's work under employer:example, the replies are unchanged", async () => {
    expect(firstDifference(base, await transcript(s, asks))).toBeNull();
  });
});
