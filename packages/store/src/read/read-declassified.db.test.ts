import type { SourceDeletion } from "@intelligence/contracts";
import { type EntityId, type FactId, FactList, type FindFactsArgs } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createPipeline } from "../pipeline/pipeline.ts";
import { CANARY_PERSON } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import {
  admin,
  COMPARTMENTS,
  commit,
  commitment,
  entityOf,
  finder,
  inWorld,
  RECORDER,
  stored,
  type World,
} from "../test-support/declassified-fixtures.ts";
import { mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { recordingLogger, recordingPool } from "../test-support/recording.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue, registration } from "../test-support/values.ts";
import { Reader } from "./read.ts";

// find_facts over declassified copies. Two claims of `own` and one of `employer:example`, at three times; the
// employer's claim, or another, declassified by the owner. Each refusal has its positive control in the same
// test.

const NAMES_DECLASSIFIED = /declassified_facts/i;
const req = (): string => testId("req");

type Facts = { a: FactId; b: FactId; c: FactId; workEvidence: string };

// A (own, 1 September), B (employer, 2 September) and C (own, 3 September), or all three at one
// time; B declassified.
async function threeFacts(world: World, options: { sameTime?: boolean } = {}): Promise<Facts> {
  const at = (day: string): string =>
    options.sameTime === true ? "2026-09-05T00:00:00.000Z" : `2026-09-0${day}T09:00:00.000Z`;
  const ownFirst = await stored(world, MAIL.canary);
  const ownSecond = await stored(world, MAIL.solo);
  const workEvidence = await stored(world, MAIL.workCanary, world.accounts.workMail);
  const [a] = await commit(world, ownFirst, [commitment(world, ownFirst, "own", { validFrom: at("1") })]);
  const [b] = await commit(world, workEvidence, [
    commitment(world, workEvidence, "employer:example", { validFrom: at("2") }),
  ]);
  const [c] = await commit(world, ownSecond, [commitment(world, ownSecond, "own", { validFrom: at("3") })]);
  if (a === undefined || b === undefined || c === undefined) throw new Error("no claims");
  await world.admin.releases.declassify(b, { requestId: req() });
  return { a, b, c, workEvidence };
}

const find = async (world: World, token: string, args: FindFactsArgs = { type: "commitment" }): Promise<FactList> =>
  FactList.parse(outcomeValue(await world.store.reader.findFacts(token, args)));
const ids = (list: FactList): string[] => list.facts.map((fact) => fact.id);

describe("find_facts returns declassified facts beside claims", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  it("a client cleared for own and declassified finds a declassified fact of employer:example, in order with its claims", () =>
    inWorld(async (world) => {
      const { a, b, c } = await threeFacts(world);
      const client = await finder(world, "own-and-declassified", ["own", "declassified"]);
      const list = await find(world, client.token);
      expect(ids(list)).toEqual([c, b, a]);
      expect(list.more).toBe(false);
      // The copy carries no message; the claims do.
      expect(list.facts.map((fact) => fact.message === null)).toEqual([false, true, false]);
      // The control: a client cleared for own alone finds the claims only.
      expect(ids(await find(world, (await finder(world, "own-only", ["own"])).token))).toEqual([c, a]);
    }));

  it("a client cleared for employer:example and declassified gets it once, as the claim", () =>
    inWorld(async (world) => {
      const { a, b } = await threeFacts(world);
      await world.admin.releases.declassify(a, { requestId: req() });
      const client = await finder(world, "work-and-declassified", ["employer:example", "declassified"]);
      const list = await find(world, client.token);
      expect(ids(list)).toEqual([b, a]);
      // B is the claim, with its message; A is the copy.
      expect(list.facts.map((fact) => fact.message === null)).toEqual([false, true]);
    }));

  it("a copy whose claim the caller's claims leave out is returned, as to a client cleared for declassified alone", () =>
    inWorld(async (world) => {
      const { a, b, c } = await threeFacts(world);
      await world.admin.releases.declassify(a, { requestId: req() });
      // A's message is held after its declassification: find_facts returns no claim of a held
      // message, though the claim's row is the caller's to read.
      await admin(
        world,
        "update knowledge.messages set held = true where evidence_id = (select evidence_id from knowledge.claims where id = $1)",
        [a],
      );
      const both = await finder(world, "own-and-declassified-held", ["own", "declassified"]);
      const list = await find(world, both.token);
      expect(ids(list)).toEqual([c, b, a]);
      expect(list.facts.map((fact) => fact.message === null)).toEqual([false, true, true]);
      // The control: a client cleared for declassified alone gets the same copies.
      expect(ids(await find(world, (await finder(world, "declassified-held", ["declassified"])).token))).toEqual([
        b,
        a,
      ]);
      // And more counts a fact once: with a limit of three, A as claim and copy is not a fourth.
      await admin(
        world,
        "update knowledge.messages set held = false where evidence_id = (select evidence_id from knowledge.claims where id = $1)",
        [a],
      );
      for (const [limit, more] of [
        [2, true],
        [3, false],
      ] as const) {
        const page = await find(world, both.token, { type: "commitment", limit });
        expect(ids(page), String(limit)).toEqual([c, b, a].slice(0, limit));
        expect(page.more, String(limit)).toBe(more);
      }
    }));

  it("the limit and more count both lists", () =>
    inWorld(async (world) => {
      const { a, b, c } = await threeFacts(world);
      const client = await finder(world, "paging", ["own", "declassified"]);
      for (const [limit, expected, more] of [
        [1, [c], true],
        [2, [c, b], true],
        [3, [c, b, a], false],
        [4, [c, b, a], false],
      ] as const) {
        const list = await find(world, client.token, { type: "commitment", limit });
        expect(ids(list), String(limit)).toEqual(expected);
        expect(list.more, String(limit)).toBe(more);
      }
    }));

  it("with equal times the two lists are ordered by claim id across the page boundary", () =>
    inWorld(async (world) => {
      const { a, b, c } = await threeFacts(world, { sameTime: true });
      const client = await finder(world, "ties", ["own", "declassified"]);
      const order = [a, b, c].sort();
      for (const limit of [1, 2, 3]) {
        const list = await find(world, client.token, { type: "commitment", limit });
        expect(ids(list), String(limit)).toEqual(order.slice(0, limit));
        expect(list.more, String(limit)).toBe(limit < 3);
      }
    }));

  it("a declassified fact's evidence id is in the read log's bound, and a record its session wrote is removed when the item is deleted at the source", () =>
    inWorld(
      async (world) => {
        const { b, workEvidence } = await threeFacts(world);
        const client = await finder(world, RECORDER, ["declassified"]);
        expect(ids(await find(world, client.token))).toEqual([b]);
        expect(await admin(world, "select tool, bound from ledger.read_log order by id")).toEqual([
          { tool: "find_facts", bound: [workEvidence] },
        ]);

        const { recordId } = outcomeValue(
          await world.store.reader.record(client.token, {
            kind: "note",
            body: "an agent record after a declassified fact",
            requestId: "request-dcl-00000001",
          }),
        );
        expect((await world.store.writer.takeRecords()).taken).toBe(1);
        const deletion = {
          sourceAccount: world.accounts.workMail.id,
          sourceItemId: mailSourceId(MAIL.workCanary),
        } as SourceDeletion;
        expect(await world.store.writer.applyDeletion(world.accounts.workMail, deletion)).toEqual({
          recordsRemoved: 1,
        });
        const [row] = await admin<{ body: boolean; tainted: boolean }>(
          world,
          "select body_enc is not null as body, tainted_at is not null as tainted from ledger.agent_writes where id = $1",
          [recordId],
        );
        expect(row).toEqual({ body: false, tainted: true });
      },
      { compartments: [...COMPARTMENTS, `agent:${RECORDER}`] },
    ));

  it("an entity filter returns no declassified fact", () =>
    inWorld(async (world) => {
      const ownEvidence = await stored(world, MAIL.canary);
      const workEvidence = await stored(world, MAIL.workCanary, world.accounts.workMail);
      const person = (await entityOf(world, CANARY_PERSON.address)) as EntityId;
      const [own] = await commit(world, ownEvidence, [commitment(world, ownEvidence, "own", { counterparty: person })]);
      const [work] = await commit(world, workEvidence, [
        commitment(world, workEvidence, "employer:example", { counterparty: person }),
      ]);
      await world.admin.releases.declassify(work as FactId, { requestId: req() });
      const client = await finder(world, "by-entity", ["own", "declassified"]);
      expect(ids(await find(world, client.token, { type: "commitment", entity: person }))).toEqual([own]);
      // The control: with no entity filter, the copy is there.
      expect(ids(await find(world, client.token)).sort()).toEqual([own, work].sort());
    }));

  it("a client without declassified sends the same statements and gets the same bytes as before", () =>
    inWorld(async (world) => {
      const ownFirst = await stored(world, MAIL.canary);
      const workEvidence = await stored(world, MAIL.workCanary, world.accounts.workMail);
      await commit(world, ownFirst, [commitment(world, ownFirst, "own")]);
      const [work] = await commit(world, workEvidence, [commitment(world, workEvidence, "employer:example")]);
      const own = await finder(world, "own-before-after", ["own"]);
      const cleared = await finder(world, "cleared", ["own", "declassified"]);
      const recorded = recordingPool(world.store.readerPool);
      const reader = new Reader({
        pool: recorded.pool,
        keys: world.store.db.keys,
        log: world.store.log,
        now: () => world.store.now,
      });
      const during = async (token: string): Promise<{ bytes: string; statements: string[] }> => {
        recorded.statements.length = 0;
        const answer = await reader.findFacts(token, { type: "commitment" });
        return { bytes: JSON.stringify(answer), statements: [...recorded.statements] };
      };

      // One call first opens the client's session, which a later call reuses: the two
      // compared are both calls of an open session.
      await during(own.token);
      const before = await during(own.token);
      await world.admin.releases.declassify(work as FactId, { requestId: req() });
      const after = await during(own.token);
      expect(after).toEqual(before);
      expect(after.statements.filter((text) => NAMES_DECLASSIFIED.test(text))).toEqual([]);
      // The control: a cleared client, its session open too, sends one statement more, which
      // reads the copies.
      await during(cleared.token);
      const wide = await during(cleared.token);
      expect(wide.statements.filter((text) => NAMES_DECLASSIFIED.test(text))).toHaveLength(1);
      expect(wide.statements.length).toBe(before.statements.length + 1);
    }));

  it("a revoked fact is found by no client", () =>
    inWorld(async (world) => {
      const { a, b, c } = await threeFacts(world);
      const wide = await finder(world, "wide", ["own", "declassified"]);
      const only = await finder(world, "only", ["declassified"]);
      expect(ids(await find(world, only.token))).toEqual([b]);
      const [ruling] = (await world.admin.releases.listDeclassified()).map((one) => one.id);
      if (ruling === undefined) throw new Error("no declassification");
      await world.admin.releases.revokeDeclassified(ruling, { requestId: req() });
      expect(ids(await find(world, wide.token))).toEqual([c, a]);
      expect(ids(await find(world, only.token))).toEqual([]);
    }));
});

describe("a declassified fact reaches find_facts alone", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  it("a declassified fact is in no context pack and builds no belief", () =>
    inWorld(async (world) => {
      const workEvidence = await stored(world, MAIL.workCanary, world.accounts.workMail);
      const what = "canary-declassified-pack";
      const [work] = await commit(world, workEvidence, [commitment(world, workEvidence, "employer:example", { what })]);
      const pipeline = createPipeline({
        url: world.store.db.urls.pipeline,
        keys: world.store.db.keys,
        log: recordingLogger().log,
      });
      // The beliefs computed for every audience, the owner's among them, as of the database's clock.
      const computed = () => pipeline.sweepBeliefs(["commitment"]);
      let token: string;
      try {
        const before = await computed();
        await world.admin.releases.declassify(work as FactId, { requestId: req() });
        expect(await computed()).toEqual(before);
        ({ token } = await world.admin.clients.addClient(
          registration("packer", ["own", "declassified"], {
            views: ["self", "people", "work"],
            tools: ["get_self", "find_facts", "build_context_pack"],
          }),
        ));
        // A client cleared for the copy is given no belief of it.
        const packer = (await computed()).find((one) => one.audience.join() === "declassified,own");
        expect(packer?.records).toEqual([]);
      } finally {
        await pipeline.close();
      }
      // The control: the client finds the copy through find_facts.
      expect(ids(await find(world, token))).toEqual([work]);
      const pack = JSON.stringify(
        outcomeValue(await world.store.reader.buildContextPack(token, { purpose: "agent_bootstrap" })),
      );
      expect(pack).not.toContain(work as string);
      expect(pack).not.toContain(what);
    }));
});
