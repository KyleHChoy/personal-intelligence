import {
  type ApplicationSign,
  BeliefList,
  CommitmentList,
  ContextView,
  type EntityId,
  EntityView,
  FactList,
  type RequestId,
  SelfView,
} from "@intelligence/contracts/personal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testId } from "../test-support/clients.ts";
import { type Client, commitClaims, insertReader, seededOf } from "../test-support/commitment-fixtures.ts";
import { session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { knownBy } from "../test-support/known-by.ts";
import { seeder } from "../test-support/seeder.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT, SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { AGENT_WORK_TOOLS } from "../test-support/work-clients.ts";
import { withWorkWorld } from "../test-support/work-test-world.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// What an owner would do with what is open: an undated chat remark lapses by its age, under a client's token
// and on the owner's page, a remark owed to the owner is no next step at any age, and what the owner said no
// to reads among the applications. Synthetic rows only; reserved domains.

const OWN = ["own"];
const VIEWS = ["self", "people", "work"];
const DAY = 86_400_000;

describe("an undated chat remark", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let reader: Reader;
  let client: Client;
  let person: string;
  let owner: string;
  let mailEvidence: { id: string; evidenceId: string; sentAt: string; compartment: string };

  const days = (back: number): string => new Date(WORLD_NOW.getTime() - back * DAY).toISOString();
  const chat = async (sentAt: string) => {
    const made = await session(store.db.urls.admin, async (query) => {
      const seeded = await seeder(store.db, query).capture(OWN);
      await query("update knowledge.captures set source = 'imessage' where id = $1", [seeded.id]);
      return seeded;
    });
    return { id: made.id, evidenceId: made.evidenceId, sentAt, compartment: "own" };
  };
  const openFacts = async (): Promise<string[]> =>
    CommitmentList.parse(outcomeValue(await reader.getCommitments(client.token, { state: "open" }))).commitments.map(
      (one) => one.belief.fact as string,
    );
  type Spec = [key: string, subject: string, counterparty: string, message: typeof mailEvidence];
  // One call: what one test needs is written at once. Each test has a world of its own: its claims
  // stay, and every belief is computed from them.
  const seed = async (given: readonly Spec[]): Promise<string[]> => {
    const specs = given.map(([key, subject, counterparty, message]) => ({
      key,
      subject,
      counterparty,
      claims: [{ message, what: `Canary ${key}` }],
    }));
    const records = await commitClaims(store, owner, specs);
    await knownBy(store.db, store.now);
    const seeded = seededOf(store, specs, records);
    return given.map(([key]) => seeded.get(key)?.fact as string);
  };

  beforeEach(async () => {
    store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example"] });
    const world = await seedWorld(store.writer, store.admin);
    person = world.entityOf(WORLD.both.address);
    const [row] = await queryAs<{ id: string }>(
      store.db.urls.admin,
      "select id from knowledge.entities where kind = 'owner'",
    );
    owner = row?.id as string;
    reader = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });
    client = await insertReader(store, "obligations", OWN, {
      tools: ["get_self", "get_entity", "get_commitments", "find_facts", "get_beliefs", "context"],
      views: VIEWS,
    });
    const [mail] = await queryAs<{ id: string; evidence_id: string }>(
      store.db.urls.admin,
      "select id, evidence_id from knowledge.messages where compartments = $1::text[] order by sent_at, id limit 1",
      [OWN],
    );
    mailEvidence = {
      id: mail?.id as string,
      evidenceId: mail?.evidence_id as string,
      sentAt: days(20),
      compartment: "own",
    };
  });

  afterEach(async () => {
    await store.close();
  });

  it("owed to the owner lapses at its age, and one from mail or on a project does not", async () => {
    const onProject = await chat(days(20));
    const [fresh, old, mailed, projected] = await seed([
      ["fresh remark", person, owner, await chat(days(3))],
      ["old remark", person, owner, await chat(days(20))],
      ["mailed promise", person, owner, mailEvidence],
      ["project remark", person, owner, onProject],
    ]);
    const [claim] = await queryAs<{ id: string }>(
      store.db.urls.admin,
      "select id from knowledge.claims where evidence_id = $1",
      [onProject.evidenceId],
    );
    await session(store.db.urls.admin, (query) => seeder(store.db, query).projectBinding(OWN, claim?.id as string));

    const open = await openFacts();
    expect(open).toContain(fresh);
    expect(open).not.toContain(old);
    expect(open).toContain(mailed);
    expect(open).toContain(projected);

    // The record stays, and says when it lapsed; the owner's page agrees.
    const closed = CommitmentList.parse(
      outcomeValue(await reader.getCommitments(client.token, { state: "closed" })),
    ).commitments.find((one) => one.belief.fact === old);
    expect(closed?.belief.status).toBe("active");
    expect(closed?.lapsed).toBeDefined();
    const page = await store.admin.commitments.list({ state: "open" });
    const onPage = page.commitments.map((one) => one.item.belief.fact as string);
    expect(onPage).not.toContain(old);
    expect(onPage).toContain(fresh);
    expect(onPage).toContain(mailed);
    expect(onPage).toContain(projected);

    // The owner's word outranks the lapse, and restarts its clock.
    await store.admin.commitments.reopenCommitment(old as string, { requestId: testId("req") });
    expect(await openFacts()).toContain(old);
  });

  it("owed by the owner stands past the shorter age, and goes at the courtesy's", async () => {
    const [owes, long] = await seed([
      ["owes remark", owner, person, await chat(days(20))],
      ["owes long remark", owner, person, await chat(days(31))],
    ]);
    const open = await openFacts();
    expect(open).toContain(owes);
    expect(open).not.toContain(long);
  });

  it("every read holds a lapsed remark to one rule, and no read of sections serves a commitment at all", async () => {
    const [old, fresh] = await seed([
      ["stale line", person, owner, await chat(days(20))],
      ["fresh line", person, owner, await chat(days(2))],
    ]);
    const card = EntityView.parse(outcomeValue(await reader.getEntity(client.token, { id: person as EntityId })));
    const status = (fact: string | undefined) => card.lines?.find((one) => one.fact === fact)?.status;
    expect(status(old)).toBe("dormant");
    expect(status(fresh)).toBe("active");

    const context = ContextView.parse(
      outcomeValue(await reader.context(client.token, { task: "catch up", entity: person as EntityId })),
    );
    const cardLines = context.people.flatMap((one) => one.lines);
    expect(cardLines.find((one) => one.fact === old)?.status ?? "dormant").toBe("dormant");
    expect(cardLines.find((one) => one.fact === fresh)?.status).toBe("active");

    const facts = FactList.parse(outcomeValue(await reader.findFacts(client.token, { belief: old as never }))).facts;
    expect(facts[0]?.status).toBe("dormant");
    const freshFacts = FactList.parse(
      outcomeValue(await reader.findFacts(client.token, { belief: fresh as never })),
    ).facts;
    expect(freshFacts[0]?.status).toBe("active");

    const openBeliefs = BeliefList.parse(
      outcomeValue(await reader.getBeliefs(client.token, { kind: "commitment", state: "open" })),
    ).beliefs.map((one) => one.fact);
    expect(openBeliefs).toContain(fresh);
    expect(openBeliefs).not.toContain(old);

    const self = SelfView.parse(outcomeValue(await reader.getSelf(client.token, {})));
    expect((self.sections ?? []).flatMap((one) => one.lines).filter((one) => one.kind === "commitment")).toEqual([]);
    expect(context.sections.flatMap((one) => one.lines).filter((one) => one.kind === "commitment")).toEqual([]);
  });

  it("drives no next step while it stands, and a remark the owner owes does", async () => {
    const card = async () =>
      EntityView.parse(outcomeValue(await reader.getEntity(client.token, { id: person as EntityId })));
    await seed([["newer remark", person, owner, await chat(days(1))]]);
    const lead = (await card()).lead;
    expect(lead?.nextStep?.kind).not.toBe("owed_to_owner");
    expect(lead?.openCommitments).toBe(1);
    const [fact] = await seed([["newer owes remark", owner, person, await chat(days(1))]]);
    expect((await card()).lead?.nextStep).toMatchObject({ kind: "owed_by_owner", fact });
  });
});

describe("what the owner said no to, among the applications", () => {
  it(
    "reads as the owner's no on the step, for the client that proposed it, and moves nothing else",
    () =>
      withWorkWorld(async (w) => {
        const tools = [...AGENT_WORK_TOOLS, "propose_opportunity", "get_self"];
        const proposer = await w.client("proposer", OWN, { tools, views: VIEWS });
        const other = await w.client("other-agent", OWN, { tools, views: VIEWS });
        const person = await w.seed.entity("person");
        await w.seed.account(OWN, person);
        const propose = async (summary: string): Promise<string> => {
          const made = await w.work.proposeOpportunity(proposer.token, {
            kind: "goal_step",
            about: { kind: "entity", id: person as never },
            summary,
            basis: [{ kind: "entity", id: person as never }],
            requestId: testId("req") as RequestId,
          });
          if (!made.ok) throw new Error(made.code);
          return made.value.opportunity;
        };
        const handled = await propose("Send the Canary grant application form");
        await w.admin(
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code) values ('opportunity', $1, 'no_go', clock_timestamp(), 'owner', $2, 'already_handled')",
          [handled, await w.label("ledger.opportunities", handled)],
        );
        const refused = await propose("Submit the Canary fellowship application by Friday");
        const unrelated = await propose("Book the Canary harbour tour");
        await w.status("opportunity", refused, "no_go", "owner");
        await w.status("opportunity", unrelated, "no_go", "owner");

        const signs = async (token: string): Promise<ApplicationSign[]> =>
          SelfView.parse(outcomeValue(await w.reader.getSelf(token, { domain: "career" }))).applications ?? [];
        const mine = (await signs(proposer.token)).filter((one) => one.state === "owner_no");
        expect(mine.map((one) => one.opportunity)).toEqual([refused]);
        expect(mine[0]?.what.untrusted).toContain("application");
        // Closed as already handled is no refusal, and says why.
        const dealt = (await signs(proposer.token)).filter((one) => one.state === "step_handled");
        expect(dealt.map((one) => one.opportunity)).toEqual([handled]);
        expect(dealt[0]?.reason).toBe("already_handled");
        // Another agent's summary is not opened for it, on the board or here.
        expect((await signs(other.token)).filter((one) => one.state === "owner_no")).toEqual([]);
      }, OWN),
    DB_TEST_TIMEOUT,
  );
});
