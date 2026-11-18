import {
  CommitmentList,
  type EntityId,
  type GetCommitmentsArgs,
  OwnerCommitments,
  type OwnerCommitmentsArgs,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminContext } from "../../core/admin-context.ts";
import type { Query } from "../../core/db.ts";
import { createDb } from "../../core/job-db.ts";
import { Reader } from "../../read/read.ts";
import { testId } from "../../test-support/clients.ts";
import {
  type Client,
  type CommitmentSpec,
  insertReader,
  type Message,
  type Seeded,
  seedCommitments,
  worldMessages,
} from "../../test-support/commitment-fixtures.ts";
import { recordingLogger } from "../../test-support/recording.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { daysFrom, outcomeValue } from "../../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../../test-support/world.ts";

import { ownerCommitments, STALE_LATE_DAYS } from "./admin-commitments.ts";

// Its items equal get_commitments' for a client whose clearance is the owner's audience, the
// courtesy lapse included; lateness and staleness are computed at read; it pages, and sends the
// same statements whatever the number of commitments. Claims are committed through the Pipeline and
// beliefs written as the rebuild writes them. Reserved domains and made-up ids only.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const TOOLS = ["get_commitments"];
const VIEWS = ["self", "people", "work"];

let store: TestStore;
let seeded: Map<string, Seeded>;
let wide: Client;
let blake: string;

const fact = (key: string): string => {
  const one = seeded.get(key);
  if (one === undefined) throw new Error(`no commitment ${key}`);
  return one.fact;
};

const reader = (): Reader =>
  new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });
const theirs = async (args: GetCommitmentsArgs): Promise<CommitmentList> =>
  CommitmentList.parse(outcomeValue(await reader().getCommitments(wide.token, { limit: 50, ...args })));
const ours = async (args: OwnerCommitmentsArgs = {}): Promise<OwnerCommitments> =>
  OwnerCommitments.parse(await store.admin.commitments.list(args));

// The read in a transaction of its own whose statements are counted.
async function counted(args: OwnerCommitmentsArgs): Promise<{ answer: OwnerCommitments; sent: string[] }> {
  const db = createDb(store.db.urls.admin, recordingLogger().log);
  const sent: string[] = [];
  const context: AdminContext = {
    transaction: (fn) =>
      db.transaction((query) => {
        const counting: Query = (text, values) => {
          sent.push(text);
          return query(text, values);
        };
        return fn(counting);
      }),
    keys: store.db.keys,
    log: recordingLogger().log,
    now: () => store.now,
  };
  try {
    return { answer: await ownerCommitments(context, args), sent };
  } finally {
    await db.close();
  }
}

beforeAll(async () => {
  store = await openStore({ now: WORLD_NOW });
  const world = await seedWorld(store.writer, store.admin);
  const owner = world.ownerEntity();
  blake = world.entityOf(WORLD.both.address);
  const pat = world.entityOf(WORLD.ownOnly.address);
  const wren = world.entityOf(WORLD.workOnly.address);
  const messages = await worldMessages(store);
  const on = (compartment: string, n: number): Message =>
    messages.filter((one) => one.compartment === compartment)[n] as Message;
  const ago = (days: number): string => daysFrom(WORLD_NOW, -days).toISOString();
  const specs: CommitmentSpec[] = [
    // Not late: due after the world's today.
    {
      key: "b-owner-blake",
      subject: owner,
      counterparty: blake,
      due: "2026-03-14",
      claims: [
        { message: on("own", 0), what: "canary-b1-old" },
        { message: on("own", 1), what: "canary-b1-new" },
      ],
    },
    {
      key: "b-blake-owner",
      subject: blake,
      counterparty: owner,
      due: "2026-03-12T09:00:00.000Z",
      claims: [{ message: on("own", 0), what: "canary-b1-blake" }],
    },
    // Three days late: late, not stale.
    {
      key: "b-late",
      subject: owner,
      counterparty: pat,
      due: "2026-03-07",
      claims: [{ message: on("own", 2), what: "canary-b1-late" }],
    },
    // Nine days late: stale.
    {
      key: "b-stale",
      subject: pat,
      counterparty: owner,
      due: "2026-03-01",
      claims: [{ message: on("own", 2), what: "canary-b1-stale" }],
    },
    // Eighteen days past its date, by no one's close: lapsed, so no longer open.
    {
      key: "b-past-date",
      subject: owner,
      counterparty: blake,
      due: "2026-02-20",
      claims: [{ message: on("own", 2), what: "canary-b1-past-date", at: ago(45) }],
    },
    // Undated and stated 45 days ago: stale; a proposal as old has lapsed and is closed.
    {
      key: "b-old",
      subject: owner,
      counterparty: blake,
      claims: [{ message: on("own", 0), what: "canary-b1-undated-old", at: ago(45) }],
    },
    {
      key: "b-lapsed",
      subject: owner,
      counterparty: blake,
      statementKind: "proposal",
      claims: [{ message: on("own", 0), what: "canary-b1-lapsed", at: ago(45) }],
    },
    {
      key: "b-recent",
      subject: owner,
      counterparty: blake,
      statementKind: "proposal",
      claims: [{ message: on("own", 0), what: "canary-b1-recent", at: ago(10) }],
    },
    {
      key: "b-closed",
      subject: owner,
      counterparty: pat,
      due: "2026-03-13",
      status: "closed",
      claims: [{ message: on("own", 1), what: "canary-b1-closed" }],
    },
    // Said done in a message: closed by its source, done then.
    {
      key: "b-done",
      subject: owner,
      counterparty: blake,
      due: "2026-02-19",
      status: "closed",
      statementKind: "reversal",
      claims: [{ message: on("own", 1), what: "canary-b1-done" }],
    },
    // Between two other people: never the owner's.
    {
      key: "b-between",
      subject: pat,
      counterparty: blake,
      due: "2026-03-11",
      claims: [{ message: on("own", 2), what: "canary-b1-between" }],
    },
    // The employer's: in the owner's audience, not the narrow one.
    {
      key: "b-work",
      subject: wren,
      counterparty: owner,
      due: "2026-03-11",
      claims: [{ message: on("employer:example", 0), what: "canary-b1-work" }],
    },
  ];
  seeded = await seedCommitments(store, owner, specs, [OWN, WIDE]);
  wide = await insertReader(store, "b1-wide", WIDE, { tools: TOOLS, views: VIEWS });
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await store?.close();
});

describe("the owner's commitments", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("equals get_commitments for the owner's audience, open and closed, the courtesy lapse included", async () => {
    for (const state of ["open", "closed"] as const) {
      const mine = await ours({ state });
      const reference = await theirs({ state });
      expect(mine.commitments.map((one) => one.item)).toEqual(reference.commitments);
      // A commitment of mail says so, for the owner as for an agent.
      expect(mine.commitments.filter((one) => one.item.message !== null).map((one) => one.item.source)).toEqual(
        mine.commitments.filter((one) => one.item.message !== null).map(() => "mail"),
      );
      expect(mine.next).toBeNull();
    }
    const open = (await ours()).commitments.map((one) => one.item.belief.fact);
    expect(open).toContain(fact("b-work"));
    expect(open).toContain(fact("b-recent"));
    expect(open).not.toContain(fact("b-lapsed"));
    expect(open).not.toContain(fact("b-between"));
    const closed = (await ours({ state: "closed" })).commitments;
    expect(closed.map((one) => one.item.belief.fact).sort()).toEqual(
      [fact("b-closed"), fact("b-done"), fact("b-lapsed"), fact("b-past-date")].sort(),
    );
    expect(closed.find((one) => one.item.belief.fact === fact("b-done"))?.item).toMatchObject({
      closedBy: { source: true },
      doneBy: { message: expect.any(String) },
    });
    for (const direction of ["owed_by_owner", "owed_to_owner"] as const) {
      expect((await ours({ direction })).commitments.map((one) => one.item)).toEqual(
        (await theirs({ direction })).commitments,
      );
    }
  });

  it("lateness, age and the stale rule, in whole days of the owner's zone", async () => {
    const byFact = new Map((await ours()).commitments.map((one) => [one.item.belief.fact, one]));
    const of = (key: string) => byFact.get(fact(key));
    expect(of("b-late")).toMatchObject({ lateDays: 3, stale: false });
    expect(of("b-stale")).toMatchObject({ lateDays: 9, stale: true });
    expect(STALE_LATE_DAYS).toBe(7);
    expect(of("b-owner-blake")).toMatchObject({ lateDays: null, stale: false });
    expect(of("b-blake-owner")).toMatchObject({ lateDays: null, stale: false });
    expect(of("b-old")).toMatchObject({ lateDays: null, ageDays: 45, stale: true });
    expect(of("b-recent")).toMatchObject({ lateDays: null, ageDays: 10, stale: false });
    // Closed: never late or stale.
    for (const one of (await ours({ state: "closed" })).commitments)
      expect(one).toMatchObject({ lateDays: null, stale: false });
  });

  it("R-pages by the server's cursor in the same order, and refuses one it did not issue", async () => {
    const whole = (await ours()).commitments.map((one) => one.item.belief.fact);
    const first = await ours({ limit: 3 });
    expect(first.commitments.map((one) => one.item.belief.fact)).toEqual(whole.slice(0, 3));
    expect(first.next).not.toBeNull();
    const rest = await ours({ limit: 200, ...(first.next === null ? {} : { cursor: first.next }) });
    expect(rest.commitments.map((one) => one.item.belief.fact)).toEqual(whole.slice(3));
    expect(rest.next).toBeNull();
    await expect(store.admin.commitments.list({ cursor: "bm90LWEtY3Vyc29y" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("R-X1: as many statements for one commitment as for every one, open or closed", async () => {
    for (const state of ["open", "closed"] as const) {
      const one = await counted({ state, limit: 1 });
      const many = await counted({ state, limit: 200 });
      expect(one.answer.commitments).toHaveLength(1);
      expect(many.answer.commitments.length).toBeGreaterThan(1);
      expect(many.sent, state).toEqual(one.sent);
    }
  });

  it("whole: every one in one answer, as the pages give them", async () => {
    const whole = await store.admin.commitments.list({}, { whole: true });
    expect(whole.next).toBeNull();
    expect(whole.commitments).toEqual((await ours()).commitments);
  });

  // A person's panel reads theirs alone.
  it("party: only those with that person on the other side, as the whole list holds them", async () => {
    const all = (await store.admin.commitments.list({}, { whole: true })).commitments;
    const blakes = await store.admin.commitments.list({ party: blake as EntityId });
    expect(blakes.commitments.length).toBeGreaterThan(0);
    expect(blakes.commitments).toEqual(all.filter((one) => one.item.counterparty?.id === blake));
  });

  // Last: it rules.
  it("R-a commitment with a person the owner has since ignored is left out, as get_commitments leaves it out", async () => {
    await store.admin.ignores.addIgnore("entity", blake as EntityId, { requestId: testId("req") });
    const mine = await ours();
    expect(mine.commitments.map((one) => one.item.counterparty?.id)).not.toContain(blake);
    expect(mine.commitments.map((one) => one.item)).toEqual((await theirs({})).commitments);
  });
});
