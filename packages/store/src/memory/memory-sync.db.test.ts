import type { Claim } from "@intelligence/contracts";
import {
  type ClaimRecord,
  CommitmentList,
  type EntityId,
  MemoryProjection,
  MemoryProjectionId,
  type SyncMemoryArgs,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMORY_CLIENT as CLIENT_LOCK } from "../core/locks.ts";
import { OWNER_TIME_ZONE } from "../core/zone.ts";
import { BELIEF_KEYS } from "../read/computed-beliefs.ts";
import { Reader } from "../read/read.ts";
import { OWNER_ENTITY, WITHHELD } from "../read/read-beliefs.ts";
import { bulkClaims, bulkCommitments } from "../test-support/bulk-claims.ts";
import {
  type CommitmentSpec,
  commitClaims,
  type Message,
  messageOn,
  type Records,
  type Seeded,
  seededOf,
  worldMessages,
} from "../test-support/commitment-fixtures.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { ingestMail, mail, mailSourceId } from "../test-support/items.ts";
import { knownBy, whileReading } from "../test-support/known-by.ts";
import { type MemoryClient, memoryClient, projectionsOf } from "../test-support/memory-fixtures.ts";
import { claimRecord } from "../test-support/pipeline-fixtures.ts";
import { HOLD_GIVE, HOLD_TAKE, recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { SERVE_MEMORY } from "./memory-sync.ts";

// Reader.syncMemory on the synthetic world. The world is seeded through the writer; its commitments are claims committed
// through the Pipeline, their beliefs computed when asked. No model is called. The clients are inserted in SQL as pi_admin.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const DAY = 86_400_000;
const TAINT_SHARED = "select pg_advisory_xact_lock_shared(hashtext('intelligence personal ledger taint'))";
const SET_TOKEN = /^select set_config\('pi\.client_token'/;
const CURRENT_CLIENT = "select id, name, compartments, views, tools from policy.current_client()";
const READ_ALLOWANCE = "select policy.read_allowance($1)";
const LOG_READ = /^select policy\.log_read\(/;
const LOG_CALL = /^select policy\.log_call\(/;
const OPEN_SESSION = /^select policy\.open_session\(/;
// The statements a computed read of beliefs sends after its fact keys (read/computed-beliefs.ts):
// the clearance, and the inputs under it with the clearance they are read for.
const BELIEF_INPUTS = [
  "select policy.client_clearance() as compartments",
  expect.stringMatching(/^select \* from policy\.belief_inputs\(/),
  "select policy.client_clearance() as compartments",
];
const SYNC = { have: [], canDelete: true } satisfies SyncMemoryArgs;

type People = { owner: EntityId; blake: EntityId; pat: EntityId; wren: EntityId };

function freshReader(store: TestStore, options?: Parameters<typeof recordingPool>[1]) {
  const recorded = recordingPool(store.readerPool, options);
  const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
  const during = async <T>(run: () => Promise<T>): Promise<{ answer: T; statements: string[] }> => {
    recorded.statements.length = 0;
    const answer = await run();
    return { answer, statements: [...recorded.statements] };
  };
  return { reader, during, held: recorded.held };
}

const sync = async (reader: Reader, client: MemoryClient, args: SyncMemoryArgs = SYNC): Promise<MemoryProjection> =>
  MemoryProjection.parse(outcomeValue(await reader.syncMemory(client.token, args)));
const ids = (projection: MemoryProjection): MemoryProjectionId[] =>
  projection.entries.map((entry) => entry.stamp.projection);
const facts = (projection: MemoryProjection): string[] => projection.entries.map((entry) => entry.stamp.fact);
const withoutIds = (projection: MemoryProjection) =>
  projection.entries.map(({ stamp, ...rest }) => ({ ...rest, fact: stamp.fact, state: stamp.state }));
const NEVER_ISSUED = MemoryProjectionId.parse(`mpr_${"f".repeat(40)}`);

// The world: its people, and the commitments of the own audience and the wide one.
type World = {
  store: TestStore;
  people: People;
  messages: Record<string, Message>;
  specs: CommitmentSpec[];
  records: Records;
  seeded: Map<string, Seeded>;
  fact: (key: string) => string;
};

async function world(): Promise<World> {
  const store = await openStore({ now: WORLD_NOW });
  const seed = await seedWorld(store.writer, store.admin);
  const people = {
    owner: seed.ownerEntity(),
    blake: seed.entityOf(WORLD.both.address),
    pat: seed.entityOf(WORLD.ownOnly.address),
    wren: seed.entityOf(WORLD.workOnly.address),
  };
  const all = await worldMessages(store);
  const messages = {
    ownBlakeFirst: messageOn(all, -5, "own"),
    ownSent: messageOn(all, -4, "own"),
    ownPat: messageOn(all, -3, "own"),
    ownBlakeSecond: messageOn(all, -2, "own"),
    workWren: messageOn(all, -7, "employer:example"),
    workBlakeNew: messageOn(all, -1, "employer:example"),
  } as Record<string, Message>;
  const m = messages as Record<string, Message>;
  const specs: CommitmentSpec[] = [
    {
      key: "m-owner-blake",
      subject: people.owner,
      counterparty: people.blake,
      due: "2026-03-14",
      claims: [
        { message: m.ownSent as Message, what: "canary-memory-owner-old" },
        { message: m.ownBlakeSecond as Message, what: "canary-memory-owner-new" },
      ],
    },
    {
      key: "m-blake-owner",
      subject: people.blake,
      counterparty: people.owner,
      due: "2026-03-12T09:30:00.000Z",
      claims: [{ message: m.ownBlakeFirst as Message, what: "canary-memory-blake" }],
    },
    {
      key: "m-pat-owner",
      subject: people.pat,
      counterparty: people.owner,
      // Said a day short of the 180 a commitment takes to go stale.
      claims: [
        {
          message: m.ownPat as Message,
          what: "canary-memory-pat",
          at: new Date(WORLD_NOW.getTime() - 179 * DAY).toISOString(),
        },
      ],
    },
    {
      key: "m-owner-closed",
      subject: people.owner,
      counterparty: people.pat,
      due: "2026-03-13",
      status: "closed",
      // Taken back: the belief computed from it is closed.
      statementKind: "reversal",
      claims: [{ message: m.ownSent as Message, what: "canary-memory-closed" }],
    },
    {
      key: "m-pat-blake",
      subject: people.pat,
      counterparty: people.blake,
      due: "2026-03-11",
      claims: [{ message: m.ownPat as Message, what: "canary-memory-between" }],
    },
    {
      key: "m-wren-owner",
      subject: people.wren,
      counterparty: people.owner,
      due: "2026-03-11",
      claims: [{ message: m.workWren as Message, what: "canary-memory-wren" }],
    },
  ];
  const records = await commitClaims(store, people.owner, specs);
  await knownBy(store.db, store.now);
  const seeded = seededOf(store, specs, records);
  const fact = (key: string): string => {
    const one = seeded.get(key);
    if (one === undefined) throw new Error(`no commitment ${key}`);
    return one.fact;
  };
  return { store, people, messages, specs, records, seeded, fact };
}

// The evidence ids of a commitment's claims, as pi_admin reads them.
const evidenceOf = async (w: World, key: string): Promise<string[]> =>
  (
    await queryAs<{ evidence_id: string }>(
      w.store.db.urls.admin,
      "select distinct evidence_id from knowledge.claims where id = any($1) order by evidence_id",
      [w.seeded.get(key)?.claims ?? []],
    )
  ).map((row) => row.evidence_id);

const OWN_OPEN = ["m-blake-owner", "m-owner-blake", "m-pat-owner"];

describe("sync_memory on the world", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let w: World;
  let own: MemoryClient;
  let twin: MemoryClient;
  let noWork: MemoryClient;
  let retains: MemoryClient;

  beforeAll(async () => {
    w = await world();
    own = await memoryClient(w.store.db, "memory-own", OWN, { tools: ["get_self", "get_commitments", "sync_memory"] });
    twin = await memoryClient(w.store.db, "memory-twin", OWN);
    await memoryClient(w.store.db, "memory-wide", WIDE);
    noWork = await memoryClient(w.store.db, "memory-no-work", OWN, { views: ["self"] });
    retains = await memoryClient(w.store.db, "memory-retains", OWN, { retention: "retains" });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await w.store.close();
  });

  it("the projection parses under the strict MemoryProjection schema, in get_commitments' order, of the open commitments with the owner on one side", async () => {
    const { reader } = freshReader(w.store);
    const answer = await reader.syncMemory(own.token, SYNC);
    const projection = MemoryProjection.parse(outcomeValue(answer));
    expect(projection.template).toBe("active_memory@2");
    expect(facts(projection)).toEqual(OWN_OPEN.map(w.fact));
    expect(projection.entries.map((entry) => [entry.direction, entry.counterparty, entry.due, entry.status])).toEqual([
      ["owed_to_owner", w.people.blake, "2026-03-12T09:30:00.000Z", "active"],
      ["owed_by_owner", w.people.blake, "2026-03-14", "active"],
      ["owed_to_owner", w.people.pat, null, "active"],
    ]);
    expect(projection.truncated).toBe(false);
    expect(projection.inStep).toBe(false);
    for (const word of ["canary-memory", WORLD.both.ownName, WORLD.ownOnly.name])
      expect(JSON.stringify(projection)).not.toContain(word);
    // The stamp: the belief's fact and state as served, the state as get_commitments serves the
    // same belief, computed under the same clearance.
    const [first] = projection.entries;
    const listed = CommitmentList.parse(
      outcomeValue(await freshReader(w.store).reader.getCommitments(own.token, { state: "any", limit: 50 })),
    ).commitments.find((one) => one.belief.fact === first?.stamp.fact);
    expect(first?.stamp.state).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.stamp.state).toBe(listed?.belief.state);
  });

  it("two runs over the same beliefs give the same projection, and a different have changes only remove and inStep", async () => {
    const { reader } = freshReader(w.store);
    const first = await sync(reader, twin);
    const second = await sync(reader, twin);
    expect(second).toEqual(first);
    const inStep = await sync(reader, twin, { have: ids(first), canDelete: true });
    expect(inStep.inStep).toBe(true);
    const stray = await sync(reader, twin, { have: [...ids(first), NEVER_ISSUED], canDelete: true });
    expect(stray.remove).toEqual([NEVER_ISSUED]);
    expect(stray.inStep).toBe(false);
    for (const one of [inStep, stray]) {
      const { remove: _remove, inStep: _inStep, hash: _hash, ...rest } = one;
      const { remove: _r, inStep: _i, hash: _h, ...base } = first;
      expect(rest).toEqual(base);
    }
  });

  it("two calls over the same beliefs give the same entries, whatever have holds and whatever the ledger holds", async () => {
    const { reader } = freshReader(w.store);
    const first = await sync(reader, own);
    // The ledger now holds ended rows and reports of this client's: the entries do not move.
    await sync(reader, own, { have: [...ids(first), NEVER_ISSUED], canDelete: false });
    await sync(reader, noWork);
    const again = await sync(reader, own, { have: [NEVER_ISSUED], canDelete: true });
    expect(again.entries).toEqual(first.entries);
  });

  it("two clients with one clearance get entries that differ only in projection ids", async () => {
    const { reader } = freshReader(w.store);
    const one = await sync(reader, own);
    const other = await sync(reader, twin);
    expect(withoutIds(other)).toEqual(withoutIds(one));
    expect(ids(other).filter((id) => ids(one).includes(id))).toEqual([]);
  });

  it("another client's projection rows change no byte", async () => {
    const { reader } = freshReader(w.store);
    const before = await sync(reader, retains);
    for (let n = 0; n < 3; n += 1) await sync(reader, twin, { have: [NEVER_ISSUED], canDelete: n % 2 === 0 });
    expect(await sync(reader, retains)).toEqual(before);
  });

  it("a client without the work view gets an empty projection and no error", async () => {
    const { reader } = freshReader(w.store);
    const projection = await sync(reader, noWork, { have: [NEVER_ISSUED], canDelete: true });
    expect(projection).toMatchObject({
      entries: [],
      corrections: [],
      remove: [NEVER_ISSUED],
      truncated: false,
      asOf: null,
    });
    expect(await projectionsOf(w.store.db, noWork)).toEqual([]);
  });

  it("a client whose recorded retention is retains gets a projection", async () => {
    const { reader } = freshReader(w.store);
    expect(facts(await sync(reader, retains))).toEqual(OWN_OPEN.map(w.fact));
  });

  it("a sync that ends ok writes one read log row with each entry's fact key and its evidence ids as shown, and nothing bound", async () => {
    const client = await memoryClient(w.store.db, "memory-r34", OWN);
    const { reader } = freshReader(w.store);
    const projection = await sync(reader, client);
    const rows = await queryAs<{ tool: string; bound: string[]; shown: string[]; fact_key_fps: string[] }>(
      w.store.db.urls.admin,
      "select tool, bound, shown, fact_key_fps from ledger.read_log where client_id = $1",
      [client.id],
    );
    const shown = [...new Set((await Promise.all(OWN_OPEN.map((key) => evidenceOf(w, key)))).flat())].sort();
    expect(
      rows.map((row) => ({ ...row, shown: [...row.shown].sort(), fact_key_fps: [...row.fact_key_fps].sort() })),
    ).toEqual([{ tool: "sync_memory", bound: [], shown, fact_key_fps: facts(projection).sort() }]);
    // Each row of the ledger holds its entry's evidence ids.
    const ledger = await projectionsOf(w.store.db, client);
    for (const key of OWN_OPEN)
      expect(ledger.find((row) => row.fact_key_fp === w.fact(key))?.evidence_ids, key).toEqual(
        await evidenceOf(w, key),
      );
    expect(
      await queryAs(w.store.db.urls.admin, "select tool, rows, outcome from policy.calls where client_id = $1", [
        client.id,
      ]),
    ).toEqual([{ tool: "sync_memory", rows: 3, outcome: "ok" }]);
  });

  it("syncMemory opens read committed and takes the shared taint lock before the token, then the client's lock, before any read", async () => {
    const client = await memoryClient(w.store.db, "memory-order", OWN);
    const { reader, during } = freshReader(w.store);
    const { statements } = await during(() => reader.syncMemory(client.token, SYNC));
    // The read quota check comes right after current_client(), before any read.
    expect(statements.slice(0, 6)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      TAINT_SHARED,
      expect.stringMatching(SET_TOKEN),
      CURRENT_CLIENT,
      READ_ALLOWANCE,
      CLIENT_LOCK,
    ]);
    expect(statements.slice(0, 6).some((text) => /knowledge\.|projections\./.test(text))).toBe(false);
  });

  it("the function runs no query but the fixed ones", async () => {
    const client = await memoryClient(w.store.db, "memory-fixed", OWN);
    const { reader, during } = freshReader(w.store);
    const first = await during(() => reader.syncMemory(client.token, SYNC));
    expect(first.statements.map((text, n) => (n === 2 ? "SET_TOKEN" : text))).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      TAINT_SHARED,
      "SET_TOKEN",
      CURRENT_CLIENT,
      READ_ALLOWANCE,
      CLIENT_LOCK,
      // The fact keys, then their beliefs' inputs under the client's clearance.
      BELIEF_KEYS,
      ...BELIEF_INPUTS,
      OWNER_ENTITY,
      // Whether any counterparty is withheld, asked once of the commitments' people.
      WITHHELD,
      // The owner's zone, for the order of due dates.
      OWNER_TIME_ZONE,
      // The courtesy lapse (lapsedCommitments): reopens, the latest claims, chat captures, bindings.
      expect.stringMatching(/owner_commitment_closes/),
      expect.stringMatching(/select c\.id, c\.evidence_id, c\.compartments, c\.content_enc, c\.valid_from/),
      expect.stringMatching(/from knowledge\.captures k/),
      expect.stringMatching(/from knowledge\.project_bindings b/),
      SERVE_MEMORY,
      expect.stringMatching(OPEN_SESSION),
      expect.stringMatching(LOG_READ),
      expect.stringMatching(LOG_CALL),
      "COMMIT",
    ]);
    // Without the work view: no belief is read.
    const blind = await during(() => reader.syncMemory(noWork.token, SYNC));
    expect(blind.statements.filter((text) => /knowledge\.|projections\./.test(text))).toEqual([]);
    expect(blind.statements).toContain(SERVE_MEMORY);
  });

  it("every other tool still opens repeatable read and runs the statements it ran before", async () => {
    const { reader, during } = freshReader(w.store);
    const calls: (() => Promise<{ ok: boolean }>)[] = [
      () => reader.getSelf(own.token),
      () => reader.getCommitments(own.token, {}),
    ];
    for (const call of calls) {
      const { answer, statements } = await during(call);
      expect(answer.ok).toBe(true);
      // Inside the taint lock's hold every reader call takes, and no lock of a sync's.
      expect(statements.slice(0, 2)).toEqual([HOLD_TAKE, "BEGIN ISOLATION LEVEL REPEATABLE READ"]);
      expect(statements.at(-1)).toBe(HOLD_GIVE);
      expect(statements.slice(1, -1).filter((text) => /pg_advisory|serve_memory/.test(text))).toEqual([]);
    }
    // get_commitments' statements are its own, and the statement of fact keys is the one it shares.
    const { statements } = await during(() => reader.getCommitments(own.token, {}));
    expect(statements).toContain(BELIEF_KEYS);
    expect(statements).not.toContain(CLIENT_LOCK);
  });
});

describe("sync_memory when the beliefs change", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await w.store.close();
  });

  it("belief independence per client, and R2: a claim outside the clearance changes no byte of the projection", async () => {
    const own = await memoryClient(w.store.db, "m1-own", OWN);
    const wide = await memoryClient(w.store.db, "m1-wide", WIDE);
    const { reader } = freshReader(w.store);
    const before = await sync(reader, own);
    // An employer:example message, its claim and the wide audience's beliefs are written.
    const fixture = mail({
      id: "memory-m1",
      threadId: "thread-memory-m1",
      at: new Date(WORLD_NOW.getTime() - DAY / 2).toISOString(),
      from: { address: WORLD.workOnly.address, name: WORLD.workOnly.name },
      to: [{ address: WORLD.ownerWork }],
      subject: "canary-memory-m1",
      labels: ["INBOX"],
    });
    await ingestMail(
      w.store.writer,
      await w.store.writer.ensureSourceAccount("work", "google_mail", "employer:example", WORLD.ownerWork),
      fixture,
    );
    const [message] = await queryAs<{ evidence_id: string; sent_at: Date }>(
      w.store.db.urls.admin,
      "select m.evidence_id, m.sent_at from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_item_fp = $1",
      [fingerprint(w.store.db.keys, "source_id", mailSourceId(fixture))],
    );
    if (message === undefined) throw new Error("the M1 message was not stored");
    const added: CommitmentSpec = {
      key: "m1-wren-owner",
      subject: w.people.wren,
      counterparty: w.people.owner,
      due: "2026-03-10",
      claims: [
        {
          message: {
            id: "",
            evidenceId: message.evidence_id,
            sentAt: message.sent_at.toISOString(),
            compartment: "employer:example",
          },
          what: "canary-memory-m1-what",
        },
      ],
    };
    await commitClaims(w.store, w.people.owner, [added]);
    await knownBy(w.store.db, w.store.now);
    // A claim alone, before any belief rests on it.
    expect(await sync(reader, own)).toEqual(before);
    const wideProjection = await sync(reader, wide);
    // The first client syncs again and gets the same bytes, hash included.
    expect(await sync(reader, own)).toEqual(before);
    // The positive control: the client cleared for both gets other entries.
    expect(facts(wideProjection)).toContain(fingerprint(w.store.db.keys, "fact", "m1-wren-owner"));
    expect(facts(wideProjection)).toContain(w.fact("m-wren-owner"));
    expect(facts(before)).not.toContain(w.fact("m-wren-owner"));
    expect(wideProjection.hash).not.toBe(before.hash);
  });

  it("a client whose clearance narrows gets no entry of the lost compartment at its next sync, and its correction holds no value", async () => {
    const client = await memoryClient(w.store.db, "narrowing", WIDE);
    const { reader } = freshReader(w.store);
    const first = await sync(reader, client);
    const lost = first.entries
      .filter((entry) => entry.stamp.fact === w.fact("m-wren-owner"))
      .map((entry) => entry.stamp.projection);
    expect(lost).toHaveLength(1);
    await queryAs(w.store.db.urls.admin, "update policy.clients set compartments = $2 where id = $1", [client.id, OWN]);
    const narrowed = await sync(reader, client, { have: ids(first), canDelete: true });
    expect(facts(narrowed)).not.toContain(w.fact("m-wren-owner"));
    expect(narrowed.remove).toEqual(expect.arrayContaining(lost));
    const correction = narrowed.corrections.find((one) => one.projection === lost[0]);
    expect(correction).toEqual({
      projection: lost[0],
      endedAt: expect.any(String),
      reason: "withdrawn",
      current: null,
    });
    expect(JSON.stringify(narrowed)).not.toContain(w.people.wren);
  });

  it("a change of the client's clearance gives every entry a new id, each old one a changed correction, and each new row the new audience", async () => {
    const client = await memoryClient(w.store.db, "reclearing", OWN);
    const { reader } = freshReader(w.store);
    const first = await sync(reader, client);
    expect(first.entries.length).toBeGreaterThan(0);
    await queryAs(w.store.db.urls.admin, "update policy.clients set compartments = $2 where id = $1", [
      client.id,
      WIDE,
    ]);
    const widened = await sync(reader, client, { have: ids(first), canDelete: true });
    expect(ids(widened).filter((id) => ids(first).includes(id))).toEqual([]);
    expect([...widened.remove].sort()).toEqual([...ids(first)].sort());
    for (const entry of first.entries) {
      const now = widened.entries.find((one) => one.stamp.fact === entry.stamp.fact);
      expect(now, entry.stamp.fact).toBeDefined();
      expect(widened.corrections).toContainEqual({
        projection: entry.stamp.projection,
        endedAt: expect.any(String),
        reason: "changed",
        current: now?.stamp.projection,
      });
    }
    const live = (await projectionsOf(w.store.db, client)).filter((row) => row.ended_at === null);
    expect(live.map((row) => row.id).sort()).toEqual([...ids(widened)].sort());
    for (const row of live) expect(row.audience, row.id).toEqual(WIDE);
  });

  it("a belief that ages into stale gets a new id and a changed correction", async () => {
    const client = await memoryClient(w.store.db, "aging", OWN);
    const { reader } = freshReader(w.store);
    const first = await sync(reader, client);
    const old = first.entries.find((entry) => entry.stamp.fact === w.fact("m-pat-owner"));
    expect(old?.status).toBe("active");
    // Two days on, the belief computed at read is stale; nothing else of the world moved.
    w.store.now = new Date(WORLD_NOW.getTime() + 2 * DAY);
    const later = await (async () => {
      try {
        return await sync(reader, client, { have: ids(first), canDelete: true });
      } finally {
        w.store.now = WORLD_NOW;
      }
    })();
    const now = later.entries.find((entry) => entry.stamp.fact === w.fact("m-pat-owner"));
    expect(now?.status).toBe("stale");
    expect(now?.stamp.projection).not.toBe(old?.stamp.projection);
    expect(later.corrections).toContainEqual({
      projection: old?.stamp.projection,
      endedAt: expect.any(String),
      reason: "changed",
      current: now?.stamp.projection,
    });
    expect(later.remove).toEqual([old?.stamp.projection]);
    // The others keep their ids.
    expect(
      ids(later)
        .filter((id) => id !== now?.stamp.projection)
        .sort(),
    ).toEqual(
      ids(first)
        .filter((id) => id !== old?.stamp.projection)
        .sort(),
    );
  });
});

describe("sync_memory over the cap", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let owner: EntityId;
  let counterparty: EntityId;
  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const seed = await seedWorld(store.writer, store.admin);
    owner = seed.ownerEntity();
    counterparty = seed.entityOf(WORLD.both.address);
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it("a commitment pushed out by a sooner one gets a dropped correction, not withdrawn", async () => {
    const client = await memoryClient(store.db, "capped", OWN);
    const at = new Date("2026-03-01T00:00:00.000Z");
    const day = (n: number): string => new Date(Date.UTC(2026, 3, 1 + n)).toISOString().slice(0, 10);
    await bulkCommitments(store, { owner, subject: owner, counterparty, count: 40, due: (n) => day(n + 1), at });
    const { reader } = freshReader(store);
    const first = await sync(reader, client);
    expect(first.entries).toHaveLength(40);
    expect(first.truncated).toBe(false);
    const last = first.entries.at(-1)?.stamp.projection;
    // One sooner than every other: the latest is cut by the cap.
    await bulkCommitments(store, {
      owner,
      subject: owner,
      counterparty,
      count: 1,
      due: () => day(0),
      at: new Date("2026-03-05T00:00:00.000Z"),
    });
    const second = await sync(reader, client, { have: ids(first), canDelete: true });
    expect(second.entries).toHaveLength(40);
    expect(second.truncated).toBe(true);
    expect(ids(second)).not.toContain(last);
    expect(second.corrections).toEqual([
      { projection: last, endedAt: expect.any(String), reason: "dropped", current: null },
    ]);
    expect(second.remove).toEqual([last]);
  });

  it("a belief whose support is over the per-entry evidence cap is left out of the sync and counted under a fixed code, and every other entry is served", async () => {
    const client = await memoryClient(store.db, "over-support", OWN);
    // 501 claims of one commitment: a support of 501.
    const overFact = fingerprint(store.db.keys, "fact", "over-support");
    await bulkClaims(store, 501, new Date("2026-03-06T00:00:00.000Z"), (n, { evidenceId, validFrom }) => {
      const base = claimRecord(evidenceId, "own", owner, {
        n: n + 1,
        factKey: "over-support",
        validFrom,
        entities: [counterparty],
      });
      return {
        ...base,
        claim: {
          ...base.claim,
          content: { ...base.claim.content, fields: { counterparty, what: `canary-over-${n}`, due: "2026-03-02" } },
        } as Claim,
        fieldKinds: { counterparty: "entity", what: "text", due: "date" },
      } as ClaimRecord;
    });
    const { reader } = freshReader(store);
    const events = store.log.events.length;
    const answer = await reader.syncMemory(client.token, SYNC);
    expect(answer.ok).toBe(true);
    const projection = MemoryProjection.parse(outcomeValue(answer));
    expect(facts(projection)).not.toContain(overFact);
    expect(projection.entries.length).toBeGreaterThan(0);
    expect(store.log.events.slice(events)).toContainEqual({
      event: "memory_entries_skipped",
      code: "support_over_cap",
      counts: { entries: 1 },
    });
    expect((await projectionsOf(store.db, client)).map((row) => row.fact_key_fp)).not.toContain(overFact);
    // Another client's sync is not stopped by it either.
    const other = await memoryClient(store.db, "over-support-other", OWN);
    expect((await reader.syncMemory(other.token, SYNC)).ok).toBe(true);
  });

  it("when serve_memory fails the call answers unavailable and returns nothing", async () => {
    const client = await memoryClient(store.db, "failing", OWN);
    const [original] = await queryAs<{ body: string }>(
      store.db.urls.admin,
      "select pg_get_functiondef('policy.serve_memory'::regproc) as body",
    );
    if (original === undefined) throw new Error("no serve_memory");
    const replace = (body: string) => queryAs(store.db.urls.bootstrap, `set role pi_owner; ${body}`);
    await replace(
      original.body.replace(
        /begin\n[\s\S]*\nend\n?\s*\$function\$/,
        "begin\n  raise exception 'injected' using errcode = 'XX000';\nend\n$function$",
      ),
    );
    try {
      const events = store.log.events.length;
      expect(
        await new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log }).syncMemory(
          client.token,
          SYNC,
        ),
      ).toEqual({ ok: false, code: "unavailable" });
      // The earlier test's belief over the evidence cap is still skipped, and logged, first.
      expect(store.log.events.slice(events).filter((event) => event.event !== "memory_entries_skipped")).toEqual([
        { event: "read_failed", code: "unavailable" },
      ]);
      expect(await projectionsOf(store.db, client)).toEqual([]);
      expect(
        await queryAs(store.db.urls.admin, "select id from ledger.read_log where client_id = $1", [client.id]),
      ).toEqual([]);
    } finally {
      await replace(original.body);
    }
    // The control: with the function back, the same call answers.
    expect(
      (await new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log }).syncMemory(client.token, SYNC))
        .ok,
    ).toBe(true);
  });
});

describe("sync_memory beside a deletion and beside another sync (two connections)", {
  timeout: SLOW_DB_TEST_TIMEOUT,
}, () => {
  let store: TestStore;
  let owner: EntityId;
  let blake: EntityId;

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const seed = await seedWorld(store.writer, store.admin);
    owner = seed.ownerEntity();
    blake = seed.entityOf(WORLD.both.address);
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  // A message from Blake under `own`, a commitment of Blake's on it, and the own audience's belief.
  async function commitmentOn(
    id: string,
  ): Promise<{ fixture: ReturnType<typeof mail>; fact: string; spec: CommitmentSpec; records: Records }> {
    const account = await store.writer.ensureSourceAccount("personal", "google_mail", "own", WORLD.ownerPersonal);
    const fixture = mail({
      id,
      threadId: `thread-${id}`,
      at: new Date(WORLD_NOW.getTime() - DAY).toISOString(),
      from: { address: WORLD.both.address, name: WORLD.both.ownName },
      to: [{ address: WORLD.ownerPersonal }],
      subject: `canary-${id}`,
      labels: ["INBOX"],
    });
    await ingestMail(store.writer, account, fixture);
    const [message] = await queryAs<{ evidence_id: string; sent_at: Date }>(
      store.db.urls.admin,
      "select m.evidence_id, m.sent_at from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_item_fp = $1",
      [fingerprint(store.db.keys, "source_id", mailSourceId(fixture))],
    );
    if (message === undefined) throw new Error(`message ${id} was not stored`);
    const spec: CommitmentSpec = {
      key: `k-${id}`,
      subject: blake,
      counterparty: owner,
      due: "2026-03-20",
      claims: [
        {
          message: {
            id: "",
            evidenceId: message.evidence_id,
            sentAt: message.sent_at.toISOString(),
            compartment: "own",
          },
          what: `canary-${id}-what`,
        },
      ],
    };
    const records = await commitClaims(store, owner, [spec]);
    await knownBy(store.db, store.now);
    return { fixture, fact: fingerprint(store.db.keys, "fact", spec.key), spec, records };
  }

  const deletion = async (fixture: ReturnType<typeof mail>): Promise<void> => {
    const account = await store.writer.ensureSourceAccount("personal", "google_mail", "own", WORLD.ownerPersonal);
    await store.writer.applyDeletion(account, {
      sourceAccount: account.id,
      sourceItemId: mailSourceId(fixture),
      deletedAt: WORLD_NOW.toISOString(),
    });
  };

  const waiting = async (): Promise<boolean> => {
    for (let n = 0; n < 200; n += 1) {
      const [row] = await queryAs<{ n: number }>(
        store.db.urls.admin,
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())",
      );
      if ((row?.n ?? 0) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };

  it("a deletion that commits while a sync is between its read and its write leaves the projection tainted and an exposure row", async () => {
    const client = await memoryClient(store.db, "racing-deletion", OWN);
    const { fixture, fact } = await commitmentOn("memory-d4");
    const { reader, held } = freshReader(store, { holdWhen: (text) => text === SERVE_MEMORY });
    const syncing = reader.syncMemory(client.token, SYNC);
    await held.reached;
    const deleting = deletion(fixture);
    expect(await waiting()).toBe(true);
    held.release();
    const projection = MemoryProjection.parse(outcomeValue(await syncing));
    await deleting;
    const entry = projection.entries.find((one) => one.stamp.fact === fact);
    expect(entry).toBeDefined();
    const [row] = await queryAs<{ tainted: boolean; reason: string | null; evidence: string[] }>(
      store.db.urls.admin,
      "select tainted_at is not null as tainted, reason, evidence_ids as evidence from ledger.memory_projections where id = $1",
      [entry?.stamp.projection],
    );
    expect(row).toEqual({ tainted: true, reason: "withdrawn", evidence: [] });
    expect(
      await queryAs(
        store.db.urls.admin,
        "select projection_id, removal from ledger.memory_exposures where client_id = $1",
        [client.id],
      ),
    ).toEqual([{ projection_id: entry?.stamp.projection, removal: "pending" }]);
  });

  it("a belief rebuilt between the sync's read and serve_memory refuses that sync with unavailable and writes nothing, and the next sync serves the rebuilt belief", async () => {
    const client = await memoryClient(store.db, "racing-rebuild", OWN);
    const { fact, spec } = await commitmentOn("memory-rebuild");
    await whileReading(store.db, async (known) => {
      const { reader, held } = freshReader(store, { holdWhen: (text) => text === SERVE_MEMORY });
      const syncing = reader.syncMemory(client.token, SYNC);
      await held.reached;
      // The item is extracted again, its claim replaced by one that moves the due date: the claim the
      // sync read is gone, so serve_memory refuses the support it was given.
      await commitClaims(store, owner, [{ ...spec, due: "2026-03-27" }]);
      await known(store.now);
      held.release();
      expect(await syncing).toEqual({ ok: false, code: "unavailable" });
    });
    expect(await projectionsOf(store.db, client)).toEqual([]);
    const next = await sync(freshReader(store).reader, client);
    expect(next.entries.find((entry) => entry.stamp.fact === fact)?.due).toBe("2026-03-27");
  });

  it("a deletion that commits before the sync starts leaves no entry for the item", async () => {
    const client = await memoryClient(store.db, "after-deletion", OWN);
    const { fixture, fact } = await commitmentOn("memory-d4-control");
    await deletion(fixture);
    const { reader } = freshReader(store);
    expect(facts(await sync(reader, client))).not.toContain(fact);
    expect(
      await queryAs(store.db.urls.admin, "select id from ledger.memory_exposures where client_id = $1", [client.id]),
    ).toEqual([]);
  });

  it("two syncs of one client both answer ok, leave one live row per entry, and the later one's rows stand", async () => {
    const client = await memoryClient(store.db, "two-syncs", OWN);
    const { fact, spec } = await commitmentOn("memory-d5");
    const [a, b] = await whileReading(store.db, async (known) => {
      const first = freshReader(store, { holdWhen: (text) => text === BELIEF_KEYS });
      const second = freshReader(store);
      const one = first.reader.syncMemory(client.token, SYNC);
      await first.held.reached;
      const two = second.reader.syncMemory(client.token, SYNC);
      expect(await waiting()).toBe(true);
      // A belief changes in between: the item is extracted again, and its due date moves.
      await commitClaims(store, owner, [{ ...spec, due: "2026-03-25" }]);
      await known(store.now);
      first.held.release();
      return Promise.all([one, two]);
    });
    expect(a.ok && b.ok).toBe(true);
    const later = MemoryProjection.parse(outcomeValue(b));
    expect(later.entries.find((entry) => entry.stamp.fact === fact)?.due).toBe("2026-03-25");
    const live = (await projectionsOf(store.db, client)).filter((row) => row.ended_at === null);
    expect(live.map((row) => row.id).sort()).toEqual(ids(later).sort());
    expect(new Set(live.map((row) => row.fact_key_fp)).size).toBe(live.length);
  });
});
