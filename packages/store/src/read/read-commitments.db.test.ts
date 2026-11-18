import {
  type AgentRecordArgs,
  type CommitmentItem,
  CommitmentList,
  type EntityId,
  type GetCommitmentsArgs,
  type MessageId,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipeline } from "../pipeline/pipeline.ts";
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
import { asClaimsOwner } from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { ingestMail, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { knownBy } from "../test-support/known-by.ts";
import { orderFault } from "../test-support/order.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { callLog, recordingReader as freshReader, openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { MISSING_ENTITY, outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { BELIEF_KEYS } from "./computed-beliefs.ts";
import { Reader } from "./read.ts";

// A statement that changes or removes a claim, as the claims' owner: pi_admin may not.
const claimsAs = (db: TestDatabase, text: string, values: unknown[] = []): Promise<unknown> =>
  asClaimsOwner(db, (query) => query(text, values));

// get_commitments. The world is seeded through the writer; its commitments are claims committed
// through the Pipeline, and the large audiences' claims are written in bulk. Every belief is
// computed at read, under the reader's clearance. No model is called.

const OWN = ["own"];
const TOOLS = [
  "get_self",
  "search",
  "get_entity",
  "find_messages",
  "read_message",
  "find_facts",
  "record",
  "build_context_pack",
  "get_commitments",
  "get_beliefs",
];
const VIEWS = ["self", "people", "work"];
const NOT_FOUND = { ok: false, code: "not_found" };

type People = { owner: string; blake: string; pat: string; wren: string };

const list = async (reader: Reader, client: Client, args: GetCommitmentsArgs = {}): Promise<CommitmentList> =>
  CommitmentList.parse(outcomeValue(await reader.getCommitments(client.token, args)));
const facts = (answer: CommitmentList): string[] => answer.commitments.map((one) => one.belief.fact);

// The fact keys of the commitment beliefs computed for `audience`, as of the database's clock.
async function computedFacts(store: TestStore, audience: readonly string[]): Promise<string[]> {
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    return (await pipeline.sweepBeliefs(["commitment"]))
      .filter((one) => one.audience.join("\n") === audience.join("\n"))
      .flatMap((one) => one.records.map((record) => record.factKeyFp));
  } finally {
    await pipeline.close();
  }
}

type LogRow = { tool: string; bound: string[]; shown: string[]; fact_key_fps: string[] };
const readLogOf = (store: TestStore, client: Client): Promise<LogRow[]> =>
  queryAs<LogRow>(
    store.db.urls.admin,
    "select tool, bound, shown, fact_key_fps from ledger.read_log where client_id = $1 order by id",
    [client.id],
  );

describe("get_commitments on the world", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let people: People;
  let seeded: Map<string, Seeded>;
  let specs: CommitmentSpec[];
  let records: Records;
  let messages: Record<string, Message>;
  let own: Client;
  let wide: Client;
  const fact = (key: string): string => {
    const one = seeded.get(key);
    if (one === undefined) throw new Error(`no commitment ${key}`);
    return one.fact;
  };
  const byKey = (answer: CommitmentList, key: string): CommitmentItem => {
    const found = answer.commitments.find((one) => one.belief.fact === fact(key));
    if (found === undefined) throw new Error(`no commitment ${key} in the answer`);
    return found;
  };

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    people = {
      owner: world.ownerEntity(),
      blake: world.entityOf(WORLD.both.address),
      pat: world.entityOf(WORLD.ownOnly.address),
      wren: world.entityOf(WORLD.workOnly.address),
    };
    const all = await worldMessages(store);
    messages = {
      ownBlakeFirst: messageOn(all, -5, "own"),
      ownSent: messageOn(all, -4, "own"),
      ownPat: messageOn(all, -3, "own"),
      ownBlakeSecond: messageOn(all, -2, "own"),
      workSent: messageOn(all, -6, "employer:example"),
      workWren: messageOn(all, -7, "employer:example"),
      // Committed by no spec: the invariant 6 test commits its claim.
      workBlakeNew: messageOn(all, -1, "employer:example"),
    };
    const m = messages as Record<string, Message>;
    specs = [
      // The owner's to Blake, said twice: the later words are the commitment's.
      {
        key: "k-owner-blake",
        subject: people.owner,
        counterparty: people.blake,
        due: "2026-03-14",
        claims: [
          { message: m.ownSent as Message, what: "canary-commit-owner-old" },
          { message: m.ownBlakeSecond as Message, what: "canary-commit-owner-new" },
        ],
      },
      {
        key: "k-blake-owner",
        subject: people.blake,
        counterparty: people.owner,
        due: "2026-03-12",
        claims: [{ message: m.ownBlakeFirst as Message, what: "canary-commit-blake" }],
      },
      // Said 190 days ago: a commitment is stale after 180.
      {
        key: "k-blake-stale",
        subject: people.blake,
        counterparty: people.owner,
        due: "2026-03-16T09:00:00.000Z",
        status: "stale",
        claims: [
          {
            message: m.ownBlakeFirst as Message,
            what: "canary-commit-stale",
            at: new Date(WORLD_NOW.getTime() - 190 * 86_400_000).toISOString(),
          },
        ],
      },
      {
        key: "k-pat-owner",
        subject: people.pat,
        counterparty: people.owner,
        claims: [{ message: m.ownPat as Message, what: "canary-commit-pat" }],
      },
      {
        key: "k-owner-pat",
        subject: people.owner,
        counterparty: people.pat,
        claims: [{ message: m.ownPat as Message, what: "canary-commit-owner-pat" }],
      },
      {
        key: "k-owner-closed",
        subject: people.owner,
        counterparty: people.pat,
        due: "2026-03-13",
        status: "closed",
        // Taken back: the belief computed from it is closed.
        statementKind: "reversal",
        claims: [{ message: m.ownSent as Message, what: "canary-commit-closed" }],
      },
      // Between two other people: find_facts shows it, get_commitments does not.
      {
        key: "k-pat-blake",
        subject: people.pat,
        counterparty: people.blake,
        due: "2026-03-11",
        claims: [{ message: m.ownPat as Message, what: "canary-commit-between" }],
      },
      // The employer's, for the wide audience alone.
      {
        key: "k-wren-owner",
        subject: people.wren,
        counterparty: people.owner,
        due: "2026-03-11",
        claims: [{ message: m.workWren as Message, what: "canary-work-commit-wren" }],
      },
      {
        key: "k-owner-blake-work",
        subject: people.owner,
        counterparty: people.blake,
        due: "2026-03-15",
        claims: [{ message: m.workSent as Message, what: "canary-work-commit-owner" }],
      },
    ];
    records = await commitClaims(store, people.owner, specs);
    await knownBy(store.db, store.now);
    seeded = seededOf(store, specs, records);
    own = await insertReader(store, "own-commitments", OWN, { tools: TOOLS, views: VIEWS });
    wide = await insertReader(store, "wide-commitments", ["own", "employer:example"], { tools: TOOLS, views: VIEWS });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  const OWN_OPEN = ["k-blake-owner", "k-owner-blake", "k-blake-stale"];
  const UNDATED = ["k-pat-owner", "k-owner-pat"];

  it("the order is by due date, undated last, then fact", async () => {
    const { reader } = freshReader(store);
    const answer = await list(reader, own);
    const undated = UNDATED.map(fact).sort();
    expect(facts(answer)).toEqual([...OWN_OPEN.map(fact), ...undated]);
    expect(answer.more).toBe(false);
    expect(answer.commitments.map((one) => one.due)).toEqual([
      "2026-03-12",
      "2026-03-14",
      "2026-03-16T09:00:00.000Z",
      null,
      null,
    ]);
  });

  it("at most 50, and more says whether more matched", async () => {
    const { reader } = freshReader(store);
    const two = await list(reader, own, { limit: 2 });
    expect(facts(two)).toEqual(OWN_OPEN.slice(0, 2).map(fact));
    expect(two.more).toBe(true);
    const five = await list(reader, own, { limit: 5 });
    expect(five.commitments).toHaveLength(5);
    expect(five.more).toBe(false);
    expect((await list(reader, own, { limit: 50 })).commitments).toHaveLength(5);
    expect(await reader.getCommitments(own.token, { limit: 51 })).toEqual({ ok: false, code: "invalid_request" });
  });

  it("a person's lead counts the open commitments get_commitments lists with them", async () => {
    const { reader } = freshReader(store);
    for (const client of [own, wide]) {
      const listed = await list(reader, client, { with: people.blake as EntityId, state: "open" });
      expect(listed.commitments.length).toBeGreaterThan(0);
      const page = outcomeValue(await reader.getEntity(client.token, { id: people.blake as EntityId }));
      expect(page.lead?.openCommitments).toBe(listed.commitments.length);
    }
  });

  it("owed_by_owner and owed_to_owner each return only their side, and counterparty is the other party", async () => {
    const { reader } = freshReader(store);
    const by = await list(reader, own, { direction: "owed_by_owner" });
    expect(facts(by)).toEqual([fact("k-owner-blake"), fact("k-owner-pat")]);
    expect(by.commitments.map((one) => [one.direction, one.counterparty?.id])).toEqual([
      ["owed_by_owner", people.blake],
      ["owed_by_owner", people.pat],
    ]);
    const to = await list(reader, own, { direction: "owed_to_owner" });
    expect(facts(to)).toEqual([fact("k-blake-owner"), fact("k-blake-stale"), fact("k-pat-owner")]);
    expect(to.commitments.map((one) => [one.direction, one.counterparty?.id])).toEqual([
      ["owed_to_owner", people.blake],
      ["owed_to_owner", people.blake],
      ["owed_to_owner", people.pat],
    ]);
    // A counterparty is a person as the other tools give one: a name and an address, under untrusted.
    expect(byKey(to, "k-blake-owner").counterparty).toMatchObject({
      id: people.blake,
      kind: "person",
      name: { untrusted: WORLD.both.ownName },
      address: { untrusted: WORLD.both.address },
    });
  });

  it("a commitment between two other people is not returned", async () => {
    const { reader } = freshReader(store);
    expect(facts(await list(reader, own, { state: "any" }))).not.toContain(fact("k-pat-blake"));
    // The control: the belief is computed for the audience.
    expect(await computedFacts(store, OWN)).toContain(fact("k-pat-blake"));
  });

  it("open is active or stale, closed is the rest", async () => {
    const { reader } = freshReader(store);
    const closed = await list(reader, own, { state: "closed" });
    expect(facts(closed)).toEqual([fact("k-owner-closed")]);
    expect(closed.commitments[0]?.belief.status).toBe("closed");
    expect(byKey(await list(reader, own), "k-blake-stale").belief.status).toBe("stale");
    const any = await list(reader, own, { state: "any" });
    expect(facts(any).sort()).toEqual([...OWN_OPEN, ...UNDATED, "k-owner-closed"].map(fact).sort());
  });

  it("with narrows to one counterparty, and a hidden id and an absent one answer not_found alike", async () => {
    const { reader, during } = freshReader(store);
    const blake = await list(reader, own, { with: people.blake as EntityId });
    expect(facts(blake)).toEqual(["k-blake-owner", "k-owner-blake", "k-blake-stale"].map(fact));
    expect(facts(await list(reader, own, { with: people.pat as EntityId }))).toEqual(UNDATED.map(fact).sort());
    // Wren is the employer's: hidden from the own client, and answered as an absent id is.
    const hidden = await during(() => reader.getCommitments(own.token, { with: people.wren as EntityId }));
    const absent = await during(() => reader.getCommitments(own.token, { with: MISSING_ENTITY }));
    expect(hidden.answer).toEqual(NOT_FOUND);
    expect(absent.answer).toEqual(NOT_FOUND);
    expect(hidden.statements).toEqual(absent.statements);
    // The control: the wide client sees Wren and the commitment.
    expect(facts(await list(reader, wide, { with: people.wren as EntityId }))).toEqual([fact("k-wren-owner")]);
    // The owner is no counterparty.
    expect(await reader.getCommitments(own.token, { with: people.owner as EntityId })).toEqual(NOT_FOUND);
  });

  it("what is the what of the belief's latest supporting claim, under untrusted, and message is that claim's message", async () => {
    const { reader } = freshReader(store);
    const answer = await list(reader, own);
    const owner = byKey(answer, "k-owner-blake");
    expect(owner.what).toEqual({ untrusted: "canary-commit-owner-new" });
    expect(owner.message).toBe(messages.ownBlakeSecond?.id);
    expect(owner.source).toBe("mail");
    expect(byKey(answer, "k-pat-owner")).toMatchObject({
      what: { untrusted: "canary-commit-pat" },
      message: messages.ownPat?.id,
      due: null,
    });
    // Every value as the contract has it: a belief item with a fact, a state and no version.
    expect(owner.belief).toMatchObject({
      fact: fact("k-owner-blake"),
      kind: "commitment",
      type: "commitment",
      status: "active",
      disputed: false,
      provenance: "source",
      confirmedAt: messages.ownBlakeSecond?.sentAt,
    });
    expect(Object.keys(owner.belief).sort()).toEqual([
      "confirmedAt",
      "disputed",
      "fact",
      "kind",
      "provenance",
      "reviewAfter",
      "state",
      "status",
      "tier",
      "type",
    ]);
    expect(Date.parse(owner.belief.reviewAfter ?? "")).toBeGreaterThan(Date.parse(owner.belief.confirmedAt));
    // The state is the fingerprint of what the belief says, as get_beliefs serves the same belief.
    const compiled = outcomeValue(await reader.getBeliefs(own.token, { kind: "commitment", state: "any" }));
    expect(owner.belief.state).toMatch(/^[0-9a-f]{64}$/);
    expect(owner.belief.state).toBe(compiled.beliefs.find((one) => one.fact === fact("k-owner-blake"))?.state);
  });

  // A belief is computed at read from every claim of its fact key, so a read opens
  // the claims of every commitment it computes, not only of those it returns. A claim that does not
  // open fails the read whatever its limit (it opened only the returned ones' while beliefs were
  // stored).
  it("a claim that does not open fails every read that computes its belief", async () => {
    const { reader } = freshReader(store);
    // A claim of a belief the limit would leave out is broken.
    const [claim] = seeded.get("k-pat-owner")?.claims ?? [];
    const [saved] = await queryAs<{ content_enc: unknown }>(
      store.db.urls.admin,
      "select content_enc from knowledge.claims where id = $1",
      [claim],
    );
    const [other] = await queryAs<{ content_enc: unknown }>(
      store.db.urls.admin,
      "select content_enc from knowledge.claims where id = $1",
      [seeded.get("k-blake-owner")?.claims[0]],
    );
    await claimsAs(store.db, "update knowledge.claims set content_enc = $2 where id = $1", [
      claim,
      JSON.stringify(other?.content_enc),
    ]);
    try {
      expect(await reader.getCommitments(own.token, { limit: 3 })).toEqual({ ok: false, code: "unavailable" });
      expect(await reader.getCommitments(own.token, {})).toEqual({ ok: false, code: "unavailable" });
    } finally {
      await claimsAs(store.db, "update knowledge.claims set content_enc = $2 where id = $1", [
        claim,
        JSON.stringify(saved?.content_enc),
      ]);
    }
    expect((await list(reader, own)).commitments).toHaveLength(5);
  });

  it("a belief is computed under the caller's clearance alone", async () => {
    const { reader } = freshReader(store);
    const mine = await list(reader, own, { state: "any" });
    const theirs = await list(reader, wide, { state: "any" });
    // One fact key whose claims both clients see: one belief, computed alike for each.
    const [a, b] = [byKey(mine, "k-blake-stale"), byKey(theirs, "k-blake-stale")];
    expect([a.belief.status, b.belief.status]).toEqual(["stale", "stale"]);
    expect(a.belief.state).toBe(b.belief.state);
    // The employer's commitments are the wide client's alone.
    for (const key of ["k-wren-owner", "k-owner-blake-work"]) {
      expect(facts(mine), key).not.toContain(fact(key));
      expect(facts(theirs), key).toContain(fact(key));
    }
    for (const text of ["canary-work", WORLD.workOnly.address]) expect(JSON.stringify(mine)).not.toContain(text);
  });

  it("a client without the work view is refused, and the refusal is recorded", async () => {
    const { reader, during } = freshReader(store);
    const narrow = await insertReader(store, "no-work-commitments", OWN, { tools: TOOLS, views: ["self", "people"] });
    const { answer, statements } = await during(() => reader.getCommitments(narrow.token, {}));
    expect(answer).toEqual({ ok: false, code: "not_permitted" });
    expect(statements.some((text) => /projections\.|knowledge\./.test(text))).toBe(false);
    expect((await callLog(store.db.urls.admin)).filter((row) => row.client === narrow.name)).toEqual([
      { client: narrow.name, tool: "get_commitments", rows: 0, outcome: "not_permitted" },
    ]);
    // The control: a client without the tool is refused alike.
    const toolless = await insertReader(store, "no-tool-commitments", OWN, { tools: ["get_self"], views: VIEWS });
    expect(await reader.getCommitments(toolless.token, {})).toEqual({ ok: false, code: "not_permitted" });
  });

  it("it logs the fact key fingerprints it returned and each message as bound, and no other", async () => {
    const { reader } = freshReader(store);
    const client = await insertReader(store, "log-commitments", OWN, { tools: TOOLS, views: VIEWS });
    const answer = await list(reader, client, { limit: 3 });
    const rows = await readLogOf(store, client);
    expect(rows).toHaveLength(1);
    const evidence = (
      await queryAs<{ evidence_id: string }>(
        store.db.urls.admin,
        "select evidence_id from knowledge.messages where id = any($1) order by evidence_id",
        [answer.commitments.map((one) => one.message)],
      )
    ).map((row) => row.evidence_id);
    expect(rows[0]).toEqual({
      tool: "get_commitments",
      bound: expect.any(Array),
      shown: [],
      fact_key_fps: facts(answer),
    });
    expect([...(rows[0]?.bound ?? [])].sort()).toEqual(evidence);
    // Not the cut ones: the undated commitments' messages and facts are in no row.
    expect(rows[0]?.fact_key_fps).not.toContain(fact("k-pat-owner"));
    expect(rows[0]?.bound).not.toContain(messages.ownPat?.evidenceId);
  });

  // Invariant 6 for this tool. Last: it adds a claim and rebuilds both audiences.
  it("a claim one client cannot see changes nothing in what it gets", async () => {
    const { reader } = freshReader(store);
    const before = await reader.getCommitments(own.token, { state: "any" });
    const wideBefore = await reader.getCommitments(wide.token, { state: "any" });
    // The employer's mail states the owner's promise to Blake again, under its fact key: the
    // wide audience's claims for it now carry two compartments, and it has no belief there.
    const extra = await commitClaims(store, people.owner, [
      {
        key: "k-owner-blake",
        subject: people.owner,
        counterparty: people.blake,
        due: "2026-03-14",
        claims: [{ message: messages.workBlakeNew as Message, what: "canary-work-commit-again" }],
      },
    ]);
    expect(extra.get("k-owner-blake")).toHaveLength(1);
    await knownBy(store.db, store.now);
    expect(JSON.stringify(await reader.getCommitments(own.token, { state: "any" }))).toBe(JSON.stringify(before));
    // The control: the wide client's answer changed.
    const wideAfter = CommitmentList.parse(outcomeValue(await reader.getCommitments(wide.token, { state: "any" })));
    expect(JSON.stringify(wideAfter)).not.toBe(JSON.stringify(wideBefore));
    expect(facts(wideAfter)).not.toContain(fact("k-owner-blake"));
  });

  it("the beliefs are computed from one statement of fact keys, newest claim first, and no statement uses an offset; every query has an order by with a unique key", async () => {
    const { reader, during } = freshReader(store);
    const { answer, statements } = await during(() => reader.getCommitments(wide.token, { state: "any" }));
    expect(answer.ok).toBe(true);
    // No statement reads a stored projection: every belief is computed from the claims.
    expect(statements.filter((text) => /\bprojections\./.test(text))).toEqual([]);
    expect(statements.filter((text) => text === BELIEF_KEYS)).toHaveLength(1);
    expect(BELIEF_KEYS).toMatch(/order by max\(c\.valid_from\) desc, c\.fact_key_fp/);
    for (const text of statements) {
      expect(text).not.toMatch(/\boffset\b/i);
      expect(orderFault(text), text).toBeNull();
    }
  });
});

describe("get_commitments: a held message", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a commitment whose latest claim's message is held is returned with what and message null, and the message is in no read log row; after Admin.releaseHeld it is returned with both", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const world = await seedWorld(store.writer, store.admin);
      const owner = world.ownerEntity();
      const blake = world.entityOf(WORLD.both.address);
      const all = await worldMessages(store);
      const held = messageOn(all, -2, "own");
      const other = messageOn(all, -5, "own");
      const seeded = await seedCommitments(
        store,
        owner,
        [
          {
            key: "k-held",
            subject: owner,
            counterparty: blake,
            due: "2026-03-14",
            claims: [
              { message: other, what: "canary-held-old" },
              { message: held, what: "canary-held-new" },
            ],
          },
          {
            key: "k-plain",
            subject: blake,
            counterparty: owner,
            due: "2026-03-15",
            claims: [{ message: other, what: "canary-plain" }],
          },
        ],
        [OWN],
      );
      const client = await insertReader(store, "held-commitments", OWN, { tools: TOOLS, views: VIEWS });
      const reader = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });
      const before = await list(reader, client);

      // No code path leaves a claim of a held message, so the case is made by hand, as pi_admin.
      await queryAs(store.db.urls.admin, "update knowledge.messages set held = true where id = $1", [held.id]);
      // The belief is computed at read from every claim of its fact key, the held
      // message's among them, so the reader opens that claim to compute it (policy.belief_inputs
      // returns it); it serves none of its words. While beliefs were stored, the reader never opened
      // it, and this test broke it to prove so. Whether a held message's claim may count in a
      // computed belief is the open question in the lane's report.
      const during = await list(reader, client);
      const item = during.commitments.find((one) => one.belief.fact === seeded.get("k-held")?.fact);
      expect(item).toMatchObject({ what: null, message: null, due: "2026-03-14", direction: "owed_by_owner" });
      // A held message's commitment names no kind of source.
      expect(item).not.toHaveProperty("source");
      expect(item?.counterparty?.id).toBe(blake);
      // As an absent message: the same items in the same order, and more as it was.
      expect(facts(during)).toEqual(facts(before));
      expect(during.more).toBe(before.more);
      expect(JSON.stringify(during)).not.toContain(held.id);
      // The call made while it was held: the first call, before the hold, bound it.
      const rows = await readLogOf(store, client);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.bound).toContain(held.evidenceId);
      expect([...(rows[1]?.bound ?? []), ...(rows[1]?.shown ?? [])]).toEqual([other.evidenceId]);

      expect(await store.admin.held.releaseHeld({ id: held.id })).toEqual({ released: 1 });
      const after = await list(reader, client);
      expect(after.commitments.find((one) => one.belief.fact === seeded.get("k-held")?.fact)).toMatchObject({
        what: { untrusted: "canary-held-new" },
        message: held.id,
      });
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    } finally {
      await store.close();
    }
  });
});

describe("get_commitments: the beliefs of a large audience", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  // A world of its own for each test, so one test's commitments are never another's.
  const world = async () => {
    const store = await openStore({ now: WORLD_NOW });
    const seeded = await seedWorld(store.writer, store.admin, { labels: ["personal"] });
    const client = await insertReader(store, "paged-commitments", OWN, { tools: TOOLS, views: VIEWS });
    return { store, owner: seeded.ownerEntity(), blake: seeded.entityOf(WORLD.both.address), client };
  };
  const inputs = (statements: string[]): number =>
    statements.filter((text) => text.includes("policy.belief_inputs(")).length;

  it("with 501 beliefs for the audience, an open commitment that is due first and was stated longest ago is returned first", async () => {
    const { store, owner, blake, client } = await world();
    try {
      // The first is the oldest; it alone has a due date.
      const { facts: keys } = await bulkCommitments(store, {
        owner,
        subject: owner,
        counterparty: blake,
        count: 501,
        due: (n) => (n === 0 ? "2026-03-11" : undefined),
        at: new Date("2026-03-01T00:00:00.000Z"),
      });
      const { reader, during } = freshReader(store);
      const { answer, statements } = await during(() => reader.getCommitments(client.token, { limit: 1 }));
      const value = CommitmentList.parse(outcomeValue(answer));
      expect(value.commitments.map((one) => one.belief.fact)).toEqual([keys[0]]);
      expect(value.commitments[0]?.due).toBe("2026-03-11");
      expect(value.more).toBe(true);
      // One statement of keys, and one read of the inputs for the 501 keys.
      expect(statements.filter((text) => text === BELIEF_KEYS)).toHaveLength(1);
      expect(inputs(statements)).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("with 5 001 beliefs for the audience the reading stops at 5 000 and more is true; with exactly 5 000 it is false", async () => {
    const { store, owner, blake, client } = await world();
    try {
      // Commitments between Blake and Blake: none has the owner on a side, so none matches, and
      // only the ceiling can make more true.
      const at = new Date("2026-03-02T00:00:00.000Z");
      await bulkCommitments(store, { owner, subject: blake, counterparty: blake, count: 4999, at });
      // And one that matches, the newest.
      await bulkCommitments(store, {
        owner,
        subject: owner,
        counterparty: blake,
        count: 1,
        at: new Date(at.getTime() + 5000 * 1000),
      });
      const { reader, during } = freshReader(store);
      const whole = await during(() => reader.getCommitments(client.token, {}));
      expect(CommitmentList.parse(outcomeValue(whole.answer))).toMatchObject({ more: false });
      expect(CommitmentList.parse(outcomeValue(whole.answer)).commitments).toHaveLength(1);
      // The 5 000 keys are read a thousand at a time.
      expect(inputs(whole.statements)).toBe(5);

      // One more, the oldest: the 5 000 newest are read, and the one past them makes more true.
      await bulkCommitments(store, {
        owner,
        subject: blake,
        counterparty: blake,
        count: 1,
        at: new Date("2026-02-01T00:00:00.000Z"),
      });
      const cut = await during(() => reader.getCommitments(client.token, {}));
      expect(CommitmentList.parse(outcomeValue(cut.answer))).toMatchObject({ more: true });
      expect(CommitmentList.parse(outcomeValue(cut.answer)).commitments).toHaveLength(1);
      expect(inputs(cut.statements)).toBe(5);
    } finally {
      await store.close();
    }
  });
});

describe("get_commitments and the agent records that rest on it", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("an agent record written after its session called get_commitments rests on each message the call returned: deleting one removes it", async () => {
    const store = await openStore({
      now: WORLD_NOW,
      compartments: ["own", "employer:example", "agent:a9-commitments"],
    });
    try {
      const world = await seedWorld(store.writer, store.admin, { labels: ["personal"] });
      const owner = world.ownerEntity();
      const account = world.accounts.personalMail;
      if (account === undefined) throw new Error("no personal mailbox");
      await ingestMail(store.writer, account, MAIL.canary);
      const [canary] = await queryAs<{ id: MessageId; evidence_id: string; sent_at: Date }>(
        store.db.urls.admin,
        "select m.id, m.evidence_id, m.sent_at from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_item_fp = $1",
        [hashFingerprint(store.db.keys, "source_id", mailSourceId(MAIL.canary))],
      );
      if (canary === undefined) throw new Error("the canary is not stored");
      const counterparty = world.entityOf(WORLD.both.address);
      const clearance = ["agent:a9-commitments", "own"];
      await seedCommitments(
        store,
        owner,
        [
          {
            key: "k-a9",
            subject: owner,
            counterparty,
            due: "2026-03-20",
            claims: [
              {
                message: {
                  id: canary.id,
                  evidenceId: canary.evidence_id,
                  sentAt: canary.sent_at.toISOString(),
                  compartment: "own",
                },
                what: "canary-a9",
                // Said before the reader's clock, though its mail is dated later.
                at: new Date(WORLD_NOW.getTime() - 86_400_000).toISOString(),
              },
            ],
          },
        ],
        [clearance],
      );
      const client = await insertReader(store, "a9-commitments", clearance, { tools: TOOLS, views: VIEWS });
      const write = async (reader: Reader, body: string): Promise<string> =>
        outcomeValue(
          await reader.record(client.token, {
            kind: "note",
            body,
            requestId: `a9-commitments-${body}`,
          } satisfies AgentRecordArgs),
        ).recordId;

      // Kept: written before its session asked. Removed: written after.
      const session = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });
      const before = await write(session, "before");
      const answer = await list(session, client);
      expect(answer.commitments.map((one) => one.message)).toEqual([canary.id]);
      const after = await write(session, "after");
      // Another session that never asked: kept.
      const other = await write(
        new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now }),
        "other",
      );

      await store.writer.takeRecords();
      expect(
        await store.writer.applyDeletion(account, {
          sourceAccount: account.id,
          sourceItemId: mailSourceId(MAIL.canary),
        } as never),
      ).toEqual({ recordsRemoved: 1 });
      const bodies = await queryAs<{ id: string; body: boolean }>(
        store.db.urls.admin,
        "select id, body_enc is not null as body from ledger.agent_writes where id = any($1) order by id",
        [[before, after, other]],
      );
      expect(Object.fromEntries(bodies.map((row) => [row.id, row.body]))).toEqual({
        [before]: true,
        [after]: false,
        [other]: true,
      });
    } finally {
      await store.close();
    }
  });
});
