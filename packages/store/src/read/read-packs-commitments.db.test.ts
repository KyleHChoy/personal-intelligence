import {
  CommitmentList,
  ContextPack,
  EventId,
  type MessageId,
  type PackItem,
  type PackSection,
} from "@intelligence/contracts/personal";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { openUnder } from "../core/seal.ts";
import { bulkCommitments } from "../test-support/bulk-claims.ts";
import { hashFingerprint } from "../test-support/clients.ts";
import {
  type Client,
  type CommitmentSpec,
  commitClaims,
  insertReader,
  type Message,
  messageOn,
  type Records,
  type Seeded,
  seedCommitments,
  seededOf,
  worldMessages,
} from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { ingestMail, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { knownBy } from "../test-support/known-by.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// Version 2 of both templates, with the commitments section. The read set and item_ids are taken
// from the assembled pack, after the cut, so they name only what was served. The world is seeded
// through the writer, its commitments through the Pipeline, and the large audiences straight into
// the table. No model is called.

const OWN = ["own"];
const WRITER = "v2-writer";
const COMPARTMENTS = ["own", "employer:example", `agent:${WRITER}`];
const TOOLS = [
  "get_self",
  "search",
  "find_messages",
  "read_message",
  "find_facts",
  "record",
  "build_context_pack",
  "get_commitments",
];
const VIEWS = ["self", "people", "work"];

const reader = (store: TestStore): Reader =>
  new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });
const bootstrap = async (store: TestStore, client: Client, on = reader(store)): Promise<ContextPack> =>
  ContextPack.parse(outcomeValue(await on.buildContextPack(client.token, { purpose: "agent_bootstrap" })));
const prep = async (store: TestStore, client: Client, event: string, on = reader(store)): Promise<ContextPack> =>
  ContextPack.parse(
    outcomeValue(await on.buildContextPack(client.token, { purpose: "meeting_prep", event: EventId.parse(event) })),
  );
const section = (pack: ContextPack, name: PackSection): PackItem[] =>
  pack.items.filter((item) => item.section === name);
const commitmentsIn = (pack: ContextPack): Extract<PackItem, { kind: "commitment" }>[] =>
  pack.items.filter((item): item is Extract<PackItem, { kind: "commitment" }> => item.kind === "commitment");

type LogRow = { tool: string; bound: string[]; shown: string[]; fact_key_fps: string[] };
const readLogOf = (store: TestStore, client: Client): Promise<LogRow[]> =>
  queryAs<LogRow>(
    store.db.urls.admin,
    "select tool, bound, shown, fact_key_fps from ledger.read_log where client_id = $1 order by id",
    [client.id],
  );
const packRowsOf = (store: TestStore, client: Client): Promise<{ template: string; item_ids: string[] }[]> =>
  queryAs(store.db.urls.admin, "select template, item_ids from ledger.context_packs where client_id = $1 order by id", [
    client.id,
  ]);

async function eventIdOf(store: TestStore, title: string, compartment: string): Promise<string> {
  const rows = await queryAs<{ id: string; compartments: string[]; title_enc: unknown }>(
    store.db.urls.admin,
    "select event_id as id, compartments, title_enc from knowledge.event_details order by event_id",
  );
  const found = rows.find(
    (row) =>
      row.compartments.includes(compartment) &&
      row.title_enc !== null &&
      openUnder(
        store.db.keys,
        row.compartments,
        { table: "knowledge.event_details", id: row.id, column: "title_enc" },
        row.title_enc as never,
      ) === title,
  );
  if (found === undefined) throw new Error(`no event titled ${title}`);
  return found.id;
}

describe("packs with the commitments section on the world", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let owner: string;
  let blake: string;
  let pat: string;
  let wren: string;
  let messages: Record<string, Message>;
  let specs: CommitmentSpec[];
  let records: Records;
  let seeded: Map<string, Seeded>;
  let own: Client;
  let wide: Client;
  let ownNext: string;
  let mailbox: Awaited<ReturnType<typeof seedWorld>>["accounts"]["personalMail"];
  const fact = (key: string): string => seeded.get(key)?.fact ?? "";

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW, compartments: COMPARTMENTS });
    const world = await seedWorld(store.writer, store.admin);
    mailbox = world.accounts.personalMail;
    owner = world.ownerEntity();
    blake = world.entityOf(WORLD.both.address);
    pat = world.entityOf(WORLD.ownOnly.address);
    wren = world.entityOf(WORLD.workOnly.address);
    const all = await worldMessages(store);
    messages = {
      ownBlakeFirst: messageOn(all, -5, "own"),
      ownSent: messageOn(all, -4, "own"),
      ownPat: messageOn(all, -3, "own"),
      ownBlakeSecond: messageOn(all, -2, "own"),
      workWren: messageOn(all, -7, "employer:example"),
      workBlakeNew: messageOn(all, -1, "employer:example"),
    };
    const m = messages as Record<string, Message>;
    specs = [
      {
        key: "k-blake-owner",
        subject: blake,
        counterparty: owner,
        due: "2026-03-12",
        claims: [{ message: m.ownBlakeFirst as Message, what: "canary-pack-blake" }],
      },
      {
        key: "k-owner-blake",
        subject: owner,
        counterparty: blake,
        due: "2026-03-14",
        claims: [{ message: m.ownSent as Message, what: "canary-pack-owner-blake" }],
      },
      {
        key: "k-owner-pat",
        subject: owner,
        counterparty: pat,
        claims: [{ message: m.ownPat as Message, what: "canary-pack-owner-pat" }],
      },
      {
        key: "k-pat-closed",
        subject: pat,
        counterparty: owner,
        status: "closed",
        // Taken back: the belief computed from it is closed.
        statementKind: "reversal",
        claims: [{ message: m.ownPat as Message, what: "canary-pack-closed" }],
      },
      {
        key: "k-blake-held",
        subject: blake,
        counterparty: owner,
        due: "2026-03-18",
        claims: [{ message: m.ownBlakeSecond as Message, what: "canary-pack-held" }],
      },
      {
        key: "k-wren-owner",
        subject: wren,
        counterparty: owner,
        due: "2026-03-11",
        claims: [{ message: m.workWren as Message, what: "canary-pack-work-wren" }],
      },
    ];
    records = await commitClaims(store, owner, specs);
    await knownBy(store.db, store.now);
    seeded = seededOf(store, specs, records);
    own = await insertReader(store, "v2-own", OWN, { tools: TOOLS, views: VIEWS });
    wide = await insertReader(store, "v2-wide", ["own", "employer:example"], { tools: TOOLS, views: VIEWS });
    ownNext = await eventIdOf(store, WORLD.ownMeeting, "own");
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  const OWN_OPEN = ["k-blake-owner", "k-owner-blake", "k-blake-held", "k-owner-pat"];

  it("agent_bootstrap@4 holds the owner's open commitments on either side, after upcoming, in get_commitments' order", async () => {
    const pack = await bootstrap(store, own);
    // agent_bootstrap@16 is the current template.
    expect(pack.template).toBe("agent_bootstrap@16");
    expect(commitmentsIn(pack).map((item) => item.id)).toEqual(OWN_OPEN.map(fact));
    expect([...new Set(pack.items.map((item) => item.section))]).toEqual(
      ["standing", "guide", "open_items", "owner", "upcoming", "commitments", "contacts", "work"].filter(
        (name) => section(pack, name as PackSection).length > 0,
      ),
    );
    // The items are get_commitments' items.
    const listed = CommitmentList.parse(outcomeValue(await reader(store).getCommitments(own.token, { limit: 21 })));
    expect(commitmentsIn(pack).map((item) => item.commitment)).toEqual(listed.commitments);
    expect(pack.truncated).toBe(false);
  });

  it("a commitment item's id is its belief's fact, its provenance source, and its as-of the belief's confirmed time", async () => {
    for (const item of commitmentsIn(await bootstrap(store, own))) {
      expect(item).toMatchObject({
        id: item.commitment.belief.fact,
        section: "commitments",
        required: true,
        provenance: "source",
        asOf: item.commitment.belief.confirmedAt,
      });
      expect(item.commitment.belief.provenance).toBe("source");
    }
  });

  it("meeting_prep@4 holds the open commitments whose other party is an attendee", async () => {
    const pack = await prep(store, own, ownNext);
    expect(pack.template).toBe("meeting_prep@8");
    const attendees = section(pack, "attendees").map((item) => item.id);
    expect(attendees).toContain(blake);
    expect(attendees).not.toContain(pat);
    expect(commitmentsIn(pack).map((item) => item.id)).toEqual(
      ["k-blake-owner", "k-owner-blake", "k-blake-held"].map(fact),
    );
    expect([...new Set(pack.items.map((item) => item.section))].slice(0, 3)).toEqual([
      "event",
      "attendees",
      "commitments",
    ]);
  });

  it("a client without the work view gets a pack with no commitments section", async () => {
    const narrow = await insertReader(store, "v2-no-work", OWN, { tools: TOOLS, views: ["self", "people"] });
    const pack = await bootstrap(store, narrow);
    // agent_bootstrap@16 is the current template.
    expect(pack.template).toBe("agent_bootstrap@16");
    expect(section(pack, "commitments")).toEqual([]);
    expect(section(await prep(store, narrow, ownNext), "commitments")).toEqual([]);
    expect((await readLogOf(store, narrow)).flatMap((row) => row.fact_key_fps)).toEqual([]);
    // The control: the same client with the work view gets them.
    expect(section(await bootstrap(store, own), "commitments")).toHaveLength(OWN_OPEN.length);
  });

  it("the pack logs the fact key fingerprints it showed, each commitment's message as shown, and nothing as bound", async () => {
    const client = await insertReader(store, "v2-log", OWN, { tools: TOOLS, views: VIEWS });
    const pack = await bootstrap(store, client);
    const [row] = await readLogOf(store, client);
    expect(row?.bound).toEqual([]);
    expect(row?.fact_key_fps).toEqual(OWN_OPEN.map(fact));
    const evidence = (
      await queryAs<{ evidence_id: string }>(
        store.db.urls.admin,
        "select evidence_id from knowledge.messages where id = any($1) order by evidence_id",
        [commitmentsIn(pack).map((item) => item.commitment.message)],
      )
    ).map((one) => one.evidence_id);
    expect(evidence.length).toBeGreaterThan(0);
    for (const id of evidence) expect(row?.shown).toContain(id);
    const [logged] = await packRowsOf(store, client);
    // agent_bootstrap@16 is the current template.
    expect(logged).toEqual({ template: "agent_bootstrap@16", item_ids: pack.items.map((item) => item.id) });
  });

  it("an agent record written after a version 2 agent_bootstrap does not rest on the commitments' messages: deleting one leaves it", async () => {
    // A commitment from a message of its own, which the test can delete at the source.
    const account = mailbox;
    if (account === undefined) throw new Error("no personal mailbox");
    await ingestMail(store.writer, account, MAIL.canary);
    const [canary] = await queryAs<{ id: MessageId; evidence_id: string; sent_at: Date }>(
      store.db.urls.admin,
      "select m.id, m.evidence_id, m.sent_at from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_item_fp = $1",
      [hashFingerprint(store.db.keys, "source_id", mailSourceId(MAIL.canary))],
    );
    if (canary === undefined) throw new Error("the canary is not stored");
    const clearance = [`agent:${WRITER}`, "own"];
    await seedCommitments(
      store,
      owner,
      [
        {
          key: "k-canary",
          subject: owner,
          counterparty: blake,
          due: "2026-03-11",
          claims: [
            {
              message: {
                id: canary.id,
                evidenceId: canary.evidence_id,
                sentAt: canary.sent_at.toISOString(),
                compartment: "own",
              },
              what: "canary-pack-canary",
              // Said before the reader's clock, though its mail is dated later.
              at: new Date(WORLD_NOW.getTime() - 86_400_000).toISOString(),
            },
          ],
        },
      ],
      [clearance],
    );
    const writer = await insertReader(store, WRITER, clearance, { tools: TOOLS, views: VIEWS });
    const session = reader(store);
    const pack = await bootstrap(store, writer, session);
    expect(commitmentsIn(pack).map((item) => item.commitment.message)).toContain(canary.id);
    const written = outcomeValue(
      await session.record(writer.token, { kind: "note", body: "after the pack", requestId: "v2-after-the-pack" }),
    ).recordId;
    await store.writer.takeRecords();
    expect(
      await store.writer.applyDeletion(account, {
        sourceAccount: account.id,
        sourceItemId: mailSourceId(MAIL.canary),
      } as never),
    ).toEqual({ recordsRemoved: 0 });
    const [row] = await queryAs<{ body: boolean }>(
      store.db.urls.admin,
      "select body_enc is not null as body from ledger.agent_writes where id = $1",
      [written],
    );
    expect(row?.body).toBe(true);
  });

  it("a commitment whose message is held is in the pack with what and message null, and the pack logs no id for that message", async () => {
    const client = await insertReader(store, "v2-held", OWN, { tools: TOOLS, views: VIEWS });
    const held = messages.ownBlakeSecond as Message;
    const before = await bootstrap(store, client);
    await queryAs(store.db.urls.admin, "update knowledge.messages set held = true where id = $1", [held.id]);
    try {
      const pack = await bootstrap(store, client);
      const item = commitmentsIn(pack).find((one) => one.id === fact("k-blake-held"));
      expect(item?.commitment).toMatchObject({ what: null, message: null, due: "2026-03-18" });
      // The same items in the same order: a held message changes no count and no order.
      expect(pack.items.map((one) => one.id)).toEqual(before.items.map((one) => one.id));
      expect(JSON.stringify(pack)).not.toContain(held.id);
      const rows = await readLogOf(store, client);
      expect(rows.at(-1)?.shown).not.toContain(held.evidenceId);
      expect(rows.at(-1)?.fact_key_fps).toContain(fact("k-blake-held"));
      expect((await packRowsOf(store, client)).at(-1)?.item_ids).not.toContain(held.id);
    } finally {
      await store.admin.held.releaseHeld({ id: held.id });
    }
    // The control: released, it is served with both.
    expect(
      commitmentsIn(await bootstrap(store, client)).find((one) => one.id === fact("k-blake-held"))?.commitment,
    ).toMatchObject({ what: { untrusted: "canary-pack-held" }, message: held.id });
  });

  // A belief is computed from the claims the caller's clearance holds, so a client
  // has none only when its clearance holds no claim of one (a stored audience could be unbuilt).
  it("a client whose clearance holds no claim of a commitment gets an empty commitments section and a pack", async () => {
    const fresh = await insertReader(store, "v2-fresh", [`agent:${WRITER}`], { tools: TOOLS, views: VIEWS });
    const pack = await bootstrap(store, fresh);
    // agent_bootstrap@16 is the current template.
    expect(pack.template).toBe("agent_bootstrap@16");
    expect(section(pack, "commitments")).toEqual([]);
    expect(pack.truncated).toBe(false);
    expect(CommitmentList.parse(outcomeValue(await reader(store).getCommitments(fresh.token, {})))).toEqual({
      commitments: [],
      more: false,
    });
  });

  // Gate test K1 again, for version 2. Last: it adds claims and rebuilds both audiences.
  it("employer commitments written after the first packs change no byte of a pack for a client cleared for own", async () => {
    const first = {
      bootstrap: JSON.stringify(await bootstrap(store, own)),
      prep: JSON.stringify(await prep(store, own, ownNext)),
    };
    const wideFirst = JSON.stringify(await bootstrap(store, wide));
    // The employer's mail states a commitment of its own, and Blake's again, under its fact key.
    const extra = await commitClaims(store, owner, [
      {
        key: "k-work-new",
        subject: blake,
        counterparty: owner,
        due: "2026-03-11",
        claims: [{ message: messages.workBlakeNew as Message, what: "canary-pack-work-new" }],
      },
      {
        key: "k-blake-owner",
        subject: blake,
        counterparty: owner,
        due: "2026-03-12",
        claims: [{ message: messages.workBlakeNew as Message, what: "canary-pack-work-again" }],
      },
    ]);
    await knownBy(store.db, store.now);
    const merged: Records = new Map([...records].map(([key, list]) => [key, [...list, ...(extra.get(key) ?? [])]]));
    merged.set("k-work-new", extra.get("k-work-new") ?? []);
    expect(JSON.stringify(await bootstrap(store, own))).toBe(first.bootstrap);
    expect(JSON.stringify(await prep(store, own, ownNext))).toBe(first.prep);
    // The positive control: the client cleared for both gets a different pack.
    const wideAfter = await bootstrap(store, wide);
    expect(JSON.stringify(wideAfter)).not.toBe(wideFirst);
    expect(commitmentsIn(wideAfter).map((item) => item.id)).toContain(fingerprint(store.db.keys, "fact", "k-work-new"));
  });
});

describe("the commitments section: the cap and the ceiling", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let owner: string;
  let blake: string;
  let client: Client;

  // A world of each test's own: its commitments are claims, which stay.
  beforeEach(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin, { labels: ["personal"] });
    owner = world.ownerEntity();
    blake = world.entityOf(WORLD.both.address);
    client = await insertReader(store, "v2-caps", OWN, { tools: TOOLS, views: VIEWS });
  }, SLOW_DB_TEST_TIMEOUT);

  afterEach(async () => {
    await store.close();
  });

  // `count` open commitments of the owner's, dated.
  const dated = (count: number) =>
    bulkCommitments(store, {
      owner,
      subject: owner,
      counterparty: blake,
      count,
      due: (n) => `2026-03-${String(11 + n).padStart(2, "0")}`,
      at: new Date("2026-03-01T00:00:00.000Z"),
    });

  it("20 open commitments are all in the pack and truncated is false", async () => {
    await dated(20);
    const pack = await bootstrap(store, client);
    expect(commitmentsIn(pack)).toHaveLength(20);
    expect(pack.truncated).toBe(false);
  });

  it("21 open commitments are cut to 20, truncated is true, and the contacts and notes sections are as they were; the 21st's message and fact key are in no read log row and not in item_ids", async () => {
    const { items } = await dated(20);
    const twenty = await bootstrap(store, client);
    // The 21st: undated, so last, and resting on a message no other commitment rests on.
    const {
      facts: [last],
      items: [lastItem],
    } = await bulkCommitments(store, {
      owner,
      subject: owner,
      counterparty: blake,
      count: 1,
      at: new Date("2026-03-05T00:00:00.000Z"),
    });
    const pack = await bootstrap(store, client);
    expect(commitmentsIn(pack)).toHaveLength(20);
    expect(pack.truncated).toBe(true);
    expect(commitmentsIn(pack).map((item) => item.id)).toEqual(commitmentsIn(twenty).map((item) => item.id));
    for (const name of ["owner", "upcoming", "contacts", "notes"] as PackSection[])
      expect(section(pack, name), name).toEqual(section(twenty, name));
    // The 21st was read and cut: it is in no read log row and in no item_ids.
    const rows = await readLogOf(store, client);
    expect(rows.flatMap((row) => row.fact_key_fps)).not.toContain(last);
    expect(rows.flatMap((row) => [...row.shown, ...row.bound])).not.toContain(lastItem);
    expect(rows.at(-1)?.shown).toContain(items[0]);
    expect((await packRowsOf(store, client)).flatMap((row) => row.item_ids)).not.toContain(last);
  });

  it("when the function answers more at the ceiling, the pack is truncated though its section holds fewer than 21", async () => {
    // 5 000 that match nothing, between Blake and Blake, then one of the owner's, older than all.
    await bulkCommitments(store, {
      owner,
      subject: blake,
      counterparty: blake,
      count: 5000,
      at: new Date("2026-03-02T00:00:00.000Z"),
    });
    const whole = await bootstrap(store, client);
    expect(commitmentsIn(whole)).toHaveLength(0);
    expect(whole.truncated).toBe(false);
    await bulkCommitments(store, {
      owner,
      subject: owner,
      counterparty: blake,
      count: 1,
      at: new Date("2026-02-01T00:00:00.000Z"),
    });
    const cut = await bootstrap(store, client);
    expect(commitmentsIn(cut)).toHaveLength(0);
    expect(cut.truncated).toBe(true);
  });
});
