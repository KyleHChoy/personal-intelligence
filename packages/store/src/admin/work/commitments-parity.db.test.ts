import type { EntityId, OwnerCommitmentsArgs } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminContext } from "../../core/admin-context.ts";
import { createDb } from "../../core/job-db.ts";
import { commitmentsOf } from "../../read/read-beliefs.ts";
import { testId } from "../../test-support/clients.ts";
import {
  type Client,
  type CommitmentSpec,
  closeSaidClosed,
  commitClaims,
  insertReader,
  type Message,
  type Records,
  seededOf,
  worldMessages,
} from "../../test-support/commitment-fixtures.ts";
import { oracleLapsedNow, oracleOwnerCommitments } from "../../test-support/commitments-owner.oracle.ts";
import { oracleCommitmentsOf } from "../../test-support/commitments-reader.oracle.ts";
import { session } from "../../test-support/connections.ts";
import { queryAs } from "../../test-support/database.ts";
import { knownBy } from "../../test-support/known-by.ts";
import { recordingLogger } from "../../test-support/recording.ts";
import { seeder } from "../../test-support/seeder.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { daysFrom } from "../../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../../test-support/world.ts";

import { lapsedNow, ownerCommitments } from "./admin-commitments.ts";

// The owner's commitments read and get_commitments' are one implementation,
// the role deciding only how the filter is applied. Before the old copies go, this proves the merged
// path returns byte-identical answers to each of today's versions (kept in test-support as oracles)
// for every role and clearance the world offers: pi_admin as the owner, and pi_reader under a token
// cleared for the owner's compartment, for the employer's and for both. The world holds mail
// commitments both ways, between two others, dated, undated, late, lapsed, proposals, closed by a
// source's reversal, under the employer's label, chat remarks fresh and old and one on a project, an
// owner's close and an owner's reopen; it is read at two clocks. Reserved domains and made-up ids only.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const WORK = ["employer:example"];
const DAY = 86_400_000;

let store: TestStore;
let specs: CommitmentSpec[];
let records: Records;
let clients: Client[];
let facts: string[];
let blake: string;
let admin: AdminContext;
let closeAdmin: () => Promise<void>;

type ReaderQuery = Parameters<typeof commitmentsOf>[1];

// Every query get_commitments, the open items and the packs pass, by state, side, party and lapse.
const readerQueries = (now: Date): ReaderQuery[] =>
  (["open", "closed", "any"] as const).flatMap((state) =>
    [undefined, "owed_by_owner", "owed_to_owner"].flatMap((direction) =>
      [undefined, [blake]].flatMap((party) =>
        [{ lapseAt: now, now }, { lapseAt: now, now, sourceFirst: true, limit: 3 }, {}].map(
          (more): ReaderQuery => ({
            state,
            limit: 50,
            ...(direction === undefined ? {} : { direction: direction as ReaderQuery["direction"] }),
            ...(party === undefined ? {} : { with: party }),
            ...more,
          }),
        ),
      ),
    ),
  );

// Every way the owner's page, terminal, open items and outcome reports call it.
const ownerCalls = (): [OwnerCommitmentsArgs, { whole?: boolean; within?: readonly string[] }][] => [
  ...(["open", "closed"] as const).flatMap((state) =>
    [undefined, "owed_by_owner", "owed_to_owner"].flatMap((direction) =>
      [undefined, blake].map((party): [OwnerCommitmentsArgs, Record<string, never>] => [
        {
          state,
          ...(direction === undefined ? {} : { direction: direction as OwnerCommitmentsArgs["direction"] }),
          ...(party === undefined ? {} : { party: party as EntityId }),
        },
        {},
      ]),
    ),
  ),
  [{ state: "open", limit: 3 }, {}],
  [{ state: "open" }, { whole: true }],
  [{ state: "closed" }, { whole: true, within: OWN }],
  [{ state: "closed" }, { whole: true, within: WIDE }],
];

async function readerParity(): Promise<number> {
  let compared = 0;
  for (const client of clients) {
    for (const query of readerQueries(store.now)) {
      const [merged, oracle] = await store.reader.withClient(
        client.token,
        { isolation: "repeatable read" },
        async ({ client: found, ctx }) => {
          if (found === null) throw new Error("no client");
          const merged = await commitmentsOf(ctx(found), query, "fresh");
          const oracle = await oracleCommitmentsOf(ctx(found), query, "fresh");
          return [merged, oracle];
        },
      );
      const what = `${client.name} ${JSON.stringify(query)}`;
      expect(JSON.stringify({ ...merged, evidenceOf: [...merged.evidenceOf] }), what).toBe(
        JSON.stringify({ ...oracle, evidenceOf: [...oracle.evidenceOf] }),
      );
      compared += merged.commitments.length;
    }
  }
  return compared;
}

async function ownerParity(): Promise<number> {
  let compared = 0;
  for (const [args, options] of ownerCalls()) {
    const merged = await ownerCommitments(admin, args, options);
    const oracle = await oracleOwnerCommitments(admin, args, options);
    expect(JSON.stringify(merged), JSON.stringify([args, options])).toBe(JSON.stringify(oracle));
    compared += merged.commitments.length;
  }
  for (const fact of facts) {
    const [merged, oracle] = await admin.transaction(async (query) => [
      await lapsedNow(admin, query, fact),
      await oracleLapsedNow(admin, query, fact),
    ]);
    expect(merged, fact).toBe(oracle);
  }
  return compared;
}

beforeAll(async () => {
  store = await openStore({ now: new Date(WORLD_NOW), compartments: ["own", "employer:example"] });
  const world = await seedWorld(store.writer, store.admin);
  const owner = world.ownerEntity();
  blake = world.entityOf(WORLD.both.address);
  const pat = world.entityOf(WORLD.ownOnly.address);
  const wren = world.entityOf(WORLD.workOnly.address);
  const messages = await worldMessages(store);
  const on = (compartment: string, n: number): Message =>
    messages.filter((one) => one.compartment === compartment)[n] as Message;
  const ago = (days: number): string => daysFrom(WORLD_NOW, -days).toISOString();
  const chat = async (days: number): Promise<Message> => {
    const made = await session(store.db.urls.admin, async (query) => {
      const seeded = await seeder(store.db, query).capture(OWN);
      await query("update knowledge.captures set source = 'imessage' where id = $1", [seeded.id]);
      return seeded;
    });
    return { id: made.id, evidenceId: made.evidenceId, sentAt: ago(days), compartment: "own" };
  };
  const onProject = await chat(20);
  specs = [
    {
      key: "p-owner-blake",
      subject: owner,
      counterparty: blake,
      due: "2026-03-14",
      claims: [
        { message: on("own", 0), what: "canary-p-old" },
        { message: on("own", 1), what: "canary-p-new" },
      ],
    },
    {
      key: "p-blake-owner",
      subject: blake,
      counterparty: owner,
      due: "2026-03-12T09:00:00.000Z",
      claims: [{ message: on("own", 0), what: "canary-p-blake" }],
    },
    {
      key: "p-late",
      subject: owner,
      counterparty: pat,
      due: "2026-03-07",
      claims: [{ message: on("own", 2), what: "canary-p-late" }],
    },
    {
      key: "p-stale",
      subject: pat,
      counterparty: owner,
      due: "2026-03-01",
      claims: [{ message: on("own", 2), what: "canary-p-stale" }],
    },
    {
      key: "p-past-date",
      subject: owner,
      counterparty: blake,
      due: "2026-02-20",
      claims: [{ message: on("own", 2), what: "canary-p-past", at: ago(45) }],
    },
    {
      key: "p-old",
      subject: owner,
      counterparty: blake,
      claims: [{ message: on("own", 0), what: "canary-p-undated", at: ago(45) }],
    },
    {
      key: "p-lapsed",
      subject: owner,
      counterparty: blake,
      statementKind: "proposal",
      claims: [{ message: on("own", 0), what: "canary-p-lapsed", at: ago(45) }],
    },
    {
      key: "p-recent",
      subject: owner,
      counterparty: blake,
      statementKind: "proposal",
      claims: [{ message: on("own", 0), what: "canary-p-recent", at: ago(10) }],
    },
    {
      key: "p-closed",
      subject: owner,
      counterparty: pat,
      due: "2026-03-13",
      status: "closed",
      claims: [{ message: on("own", 1), what: "canary-p-closed" }],
    },
    {
      key: "p-done",
      subject: owner,
      counterparty: blake,
      due: "2026-02-19",
      status: "closed",
      statementKind: "reversal",
      claims: [{ message: on("own", 1), what: "canary-p-done" }],
    },
    {
      key: "p-between",
      subject: pat,
      counterparty: blake,
      due: "2026-03-11",
      claims: [{ message: on("own", 2), what: "canary-p-between" }],
    },
    {
      key: "p-work",
      subject: wren,
      counterparty: owner,
      due: "2026-03-11",
      claims: [{ message: on("employer:example", 0), what: "canary-p-work" }],
    },
    {
      key: "p-work-done",
      subject: owner,
      counterparty: wren,
      status: "closed",
      statementKind: "reversal",
      claims: [{ message: on("employer:example", 0), what: "canary-p-work-done", at: ago(5) }],
    },
    {
      key: "p-remark-fresh",
      subject: blake,
      counterparty: owner,
      claims: [{ message: await chat(3), what: "canary-p-chat-fresh" }],
    },
    {
      key: "p-remark-old",
      subject: blake,
      counterparty: owner,
      claims: [{ message: await chat(20), what: "canary-p-chat-old" }],
    },
    {
      key: "p-remark-project",
      subject: blake,
      counterparty: owner,
      claims: [{ message: onProject, what: "canary-p-chat-project" }],
    },
    {
      key: "p-remark-mine",
      subject: owner,
      counterparty: blake,
      claims: [{ message: await chat(40), what: "canary-p-chat-mine" }],
    },
    {
      key: "p-to-close",
      subject: owner,
      counterparty: blake,
      due: "2026-03-20",
      claims: [{ message: on("own", 1), what: "canary-p-to-close" }],
    },
  ];
  records = await commitClaims(store, owner, specs);
  const [claim] = await queryAs<{ id: string }>(
    store.db.urls.admin,
    "select id from knowledge.claims where evidence_id = $1",
    [onProject.evidenceId],
  );
  await session(store.db.urls.admin, (query) => seeder(store.db, query).projectBinding(OWN, claim?.id as string));
  await knownBy(store.db, store.now);
  await closeSaidClosed(store, specs, records);
  const seeded = seededOf(store, specs, records);
  facts = [...seeded.values()].map((one) => one.fact);
  const tools = { tools: ["get_commitments"], views: ["self", "people", "work"] };
  clients = [
    await insertReader(store, "parity-own", OWN, tools),
    await insertReader(store, "parity-wide", WIDE, tools),
    await insertReader(store, "parity-work", WORK, tools),
  ];
  const db = createDb(store.db.urls.admin, recordingLogger().log);
  admin = {
    transaction: (fn) => db.transaction(fn),
    keys: store.db.keys,
    log: recordingLogger().log,
    now: () => store.now,
  };
  closeAdmin = () => db.close();
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await closeAdmin?.();
  await store?.close();
});

describe("the commitments read, one implementation for the owner and for clients", {
  timeout: SLOW_DB_TEST_TIMEOUT,
}, () => {
  it("answers each role and clearance byte for byte as today's two versions, at the world's clock", async () => {
    expect(await readerParity()).toBeGreaterThan(0);
    expect(await ownerParity()).toBeGreaterThan(0);
  });

  it("and ten days on, when more have lapsed", async () => {
    store.now.setTime(WORLD_NOW.getTime() + 10 * DAY);
    try {
      expect(await readerParity()).toBeGreaterThan(0);
      expect(await ownerParity()).toBeGreaterThan(0);
    } finally {
      store.now.setTime(WORLD_NOW.getTime());
    }
  });

  // Last: it writes the owner's close and reopen, which every belief computed after reads at once.
  it("and after the owner's own close and reopen", async () => {
    const [toClose, toReopen] = [
      specs.findIndex((one) => one.key === "p-to-close"),
      specs.findIndex((one) => one.key === "p-past-date"),
    ];
    await store.admin.commitments.closeCommitment(facts[toClose] as string, "done", { requestId: testId("req") });
    await store.admin.commitments.reopenCommitment(facts[toReopen] as string, { requestId: testId("req") });
    expect(await readerParity()).toBeGreaterThan(0);
    expect(await ownerParity()).toBeGreaterThan(0);
  });
});
