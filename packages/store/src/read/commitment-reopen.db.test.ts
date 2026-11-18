import {
  CommitmentList,
  type GetCommitmentsArgs,
  OwnerCommitments,
  type OwnerCommitmentsArgs,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminError } from "../core/admin-error.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import {
  type Client,
  type CommitmentSpec,
  commitClaims,
  insertReader,
  type Records,
  seededOf,
  worldMessages,
} from "../test-support/commitment-fixtures.ts";
import { readAs } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { knownBy } from "../test-support/known-by.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// Invariant 11 over the lapse: the owner's reopen outranks a date that passed. A reopen keeps a
// commitment open past its lapse, whether a close was lifted or none ever existed, and starts a fresh
// clock from the reopen. A reader learns of a reopen only for a commitment it can already read.
// Every belief is computed when asked, so a reopen shows at once.

const OWN = ["own"];
const DAY = 86_400_000;

describe("the owner's reopen and the lapse", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let specs: CommitmentSpec[];
  let records: Records;
  let client: Client;
  let stranger: Client;
  const facts = new Map<string, string>();
  let serial = 0;

  const fact = (key: string): string => facts.get(key) as string;
  const requestId = (): string => `reopen-lapse-${String((serial += 1)).padStart(4, "0")}`;
  const reader = (): Reader =>
    new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });
  const theirs = async (args: GetCommitmentsArgs): Promise<string[]> =>
    CommitmentList.parse(outcomeValue(await reader().getCommitments(client.token, { limit: 50, ...args })))
      .commitments.map((one) => one.belief.fact)
      .sort();
  const ours = async (args: OwnerCommitmentsArgs): Promise<string[]> =>
    OwnerCommitments.parse(await store.admin.commitments.list(args))
      .commitments.map((one) => one.item.belief.fact)
      .sort();
  const at = (days: number): void => {
    store.now.setTime(WORLD_NOW.getTime() + days * DAY);
  };

  beforeAll(async () => {
    store = await openStore({ now: new Date(WORLD_NOW) });
    const world = await seedWorld(store.writer, store.admin);
    const owner = world.ownerEntity();
    const blake = world.entityOf(WORLD.both.address);
    const [message] = (await worldMessages(store)).filter((one) => one.compartment === "own");
    if (message === undefined) throw new Error("the world holds no message of the owner's");
    const old = daysFrom(WORLD_NOW, -45).toISOString();
    const spec = (key: string, more: Partial<CommitmentSpec> = {}): CommitmentSpec => ({
      key,
      subject: owner,
      counterparty: blake,
      claims: [{ message, what: `canary-reopen-${key}`, at: old }],
      ...more,
    });
    specs = [
      spec("r-past", { due: "2026-02-10" }),
      spec("r-closed", { due: "2026-02-11" }),
      spec("r-courtesy", { statementKind: "proposal" }),
      spec("r-untouched", { due: "2026-02-12" }),
      spec("r-current", { due: "2026-03-20" }),
      spec("r-stated"),
      spec("r-dormant", { due: "2025-01-10", status: "dormant" }),
    ];
    records = await commitClaims(store, owner, specs);
    await knownBy(store.db, store.now);
    for (const [key, one] of seededOf(store, specs, records)) facts.set(key, one.fact);
    client = await insertReader(store, "reopen-reader", OWN, { tools: ["get_commitments"], views: ["self", "work"] });
    stranger = await insertReader(store, "reopen-stranger", ["agent:reopen-stranger"], {
      tools: ["get_commitments"],
      views: ["self", "work"],
    });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  const itemOf = async (key: string) =>
    CommitmentList.parse(
      outcomeValue(await reader().getCommitments(client.token, { limit: 50, state: "any" })),
    ).commitments.find((one) => one.belief.fact === fact(key));
  const ownerItemOf = async (key: string) =>
    OwnerCommitments.parse(await store.admin.commitments.list({ state: "closed" })).commitments.find(
      (one) => one.item.belief.fact === fact(key),
    )?.item;

  it("past its date and with no close, it has lapsed for an agent and for the owner", async () => {
    expect(await theirs({ state: "open" })).toEqual([fact("r-current"), fact("r-stated")].sort());
    expect(await ours({ state: "open" })).toEqual([fact("r-current"), fact("r-stated")].sort());
  });

  it("a lapsed one says so, and the day, under any and closed; an open one has no marker", async () => {
    expect((await itemOf("r-untouched"))?.lapsed).toBe("2026-02-27");
    expect((await ownerItemOf("r-untouched"))?.lapsed).toBe("2026-02-27");
    expect((await itemOf("r-courtesy"))?.lapsed).toBe(daysFrom(WORLD_NOW, -14).toISOString().slice(0, 10));
    expect((await itemOf("r-current"))?.lapsed).toBeUndefined();
    expect((await itemOf("r-stated"))?.lapsed).toBeUndefined();
  });

  it("reopen takes one that lapsed with no close, and it is open for an agent and for the owner", async () => {
    await store.admin.commitments.reopenCommitment(fact("r-past"), { requestId: requestId() });
    const open = [fact("r-past"), fact("r-current"), fact("r-stated")].sort();
    expect(await theirs({ state: "open" })).toEqual(open);
    expect(await ours({ state: "open" })).toEqual(open);
    expect(await theirs({ state: "closed" })).not.toContain(fact("r-past"));
    expect((await itemOf("r-past"))?.lapsed).toBeUndefined();
  });

  it("one just reopened has not lapsed, so a second reopen refuses and writes nothing", async () => {
    const count = async (): Promise<number> =>
      (
        await queryAs<{ n: number }>(
          store.db.urls.admin,
          "select count(*)::int as n from ledger.commitment_reopens where fact_fp = $1",
          [fact("r-past")],
        )
      )[0]?.n ?? 0;
    const before = await count();
    await expect(
      store.admin.commitments.reopenCommitment(fact("r-past"), { requestId: requestId() }),
    ).rejects.toMatchObject({ code: "not_closed" });
    expect(await count()).toBe(before);
  });

  it("an old undated statement that is no proposal never lapsed, so it refuses too", async () => {
    await expect(
      store.admin.commitments.reopenCommitment(fact("r-stated"), { requestId: requestId() }),
    ).rejects.toMatchObject({ code: "not_closed" });
  });

  it("one gone dormant with age can be reopened, and the build then reads the reopen as confirming it", async () => {
    await store.admin.commitments.reopenCommitment(fact("r-dormant"), { requestId: requestId() });
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
    try {
      const { reopens } = await pipeline.beliefDecisions();
      expect(reopens?.filter((one) => one.factKeyFp === fact("r-dormant"))).toEqual([
        { factKeyFp: fact("r-dormant"), at: store.now.toISOString(), compartments: OWN },
      ]);
    } finally {
      await pipeline.close();
    }
  });

  it("the reopen starts a fresh clock: open through its fourteenth day, lapsed the day after", async () => {
    at(14);
    expect(await theirs({ state: "open" })).toContain(fact("r-past"));
    expect(await ours({ state: "open" })).toContain(fact("r-past"));
    at(15);
    expect(await theirs({ state: "open" })).not.toContain(fact("r-past"));
    expect(await ours({ state: "open" })).not.toContain(fact("r-past"));
    at(0);
  });

  it("a close the owner lifts, on a commitment past its date, stays open too", async () => {
    await store.admin.commitments.closeCommitment(fact("r-closed"), "released", { requestId: requestId() });
    await store.admin.commitments.reopenCommitment(fact("r-closed"), { requestId: requestId() });
    expect(await theirs({ state: "open" })).toContain(fact("r-closed"));
    expect(await ours({ state: "open" })).toContain(fact("r-closed"));
  });

  it("a courtesy that lapsed can be reopened as well", async () => {
    expect(await theirs({ state: "open" })).not.toContain(fact("r-courtesy"));
    await store.admin.commitments.reopenCommitment(fact("r-courtesy"), { requestId: requestId() });
    expect(await theirs({ state: "open" })).toContain(fact("r-courtesy"));
  });

  it("one not closed and not lapsed still refuses not_closed, and leaves others as they were", async () => {
    await expect(
      store.admin.commitments.reopenCommitment(fact("r-current"), { requestId: requestId() }),
    ).rejects.toMatchObject({ code: "not_closed" } satisfies Partial<AdminError>);
    expect(await theirs({ state: "open" })).not.toContain(fact("r-untouched"));
  });

  const reopenRows = (token: string): Promise<{ fact_fp: string }[]> =>
    readAs(store.db, token, (query) =>
      query<{ fact_fp: string }>(
        "select fact_fp from policy.owner_commitment_closes($1::text[]) where ending = 'reopened'",
        [[fact("r-past")]],
      ),
    );

  it("the definer tells a reader of a reopen only for a commitment within its clearance", async () => {
    expect(await reopenRows(client.token)).toEqual([{ fact_fp: fact("r-past") }]);
    expect(await reopenRows(stranger.token)).toEqual([]);
  });

  it("the owner's closes in force are read as they were: a reopen is no close", async () => {
    const owner = OwnerCommitments.parse(await store.admin.commitments.list({ state: "any" as never }));
    expect(owner.commitments.every((one) => one.item.ending !== ("reopened" as never))).toBe(true);
  });
});
