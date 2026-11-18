import type { Claim } from "@intelligence/contracts";
import type { ClaimRecord, OpportunityId, Tier } from "@intelligence/contracts/personal";
import { frontierValue, planExplore, planGapFlags } from "@intelligence/personal-core/planner";
import { secondDegreeRules } from "@intelligence/personal-core/views";
import { describe, expect, it } from "vitest";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { sealUnder } from "../core/seal.ts";
import { request, testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { claimRecord } from "../test-support/pipeline-fixtures.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { seedLines } from "../test-support/warmth-lines.ts";
import { READING_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { tie } from "../test-support/work-seeds.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createGapLaneStore, exploreTiers } from "../work/gap-lanes.ts";

// The frontier, through ledger.explore_gaps as pi_pipeline, whose pass over the warmth lanes ranks
// the namers' warmth, core's planExplore and planGapFlags as the pass runs them, and the explore
// brief an agent is given. SD-B17's value parts, SD-B22, the budget, the rest and a decline.
// Synthetic rows only.

const OWN = ["own"];
// SD-B22's employer:x, as the synthetic keys name an employer's compartment.
const WORK = ["employer:example"];
const DAY_MS = 86_400_000;

type Explore = {
  subject: string;
  label: string[];
  goal_id: string | null;
  facts: number;
  ties: number;
  goal_target: boolean;
  goal_path: boolean;
  goals: string[];
  meeting_soon: boolean;
  namer_tiers: string[];
  named_days: number | null;
  missing: string[];
};
type Flag = {
  id: string;
  gap_subject: string;
  compartments: string[];
  goal_id: string | null;
  gap_missing: string[];
  gap_value: number;
  gap_parts: number[];
  about_kind: string;
  about_id: string;
};

// The frontier rows the pipeline's pass reads, as pi_pipeline, with the namers' tiers it ranks.
const frontier = async (w: WorkWorld, at = new Date()): Promise<Explore[]> =>
  session(w.db.urls.pipeline, async (query) =>
    query<Explore>(
      `select subject, label, goal_id, facts, ties, goal_target, goal_path, goals, meeting_soon, namer_tiers, named_days, missing
       from ledger.explore_gaps($1::timestamptz, $2, $3::jsonb) order by subject`,
      [at.toISOString(), secondDegreeRules().namedMeetingHours, await exploreTiers({ query, keys: w.db.keys }, at)],
    ),
  );

// The pipeline's pass with the frontier, as the tick's step 3b ran it: plan explore, close, then raise.
async function tick(w: WorkWorld, at: Date): Promise<number> {
  const dispatch = createGapLaneStore({ url: w.db.urls.pipeline, keys: w.db.keys, log: w.log });
  try {
    const flags = await dispatch.gapFlags(at);
    const found = await dispatch.gapCandidates(at);
    const explore = planExplore({
      candidates: found.flatMap((gap) =>
        gap.trigger === "explore" && gap.frontier !== undefined ? [{ ...gap, frontier: gap.frontier }] : [],
      ),
      open: flags.open,
      history: flags.history,
      explored: flags.explored,
      now: at,
    });
    const plan = planGapFlags({
      candidates: [...found.filter((gap) => gap.trigger !== "explore"), ...explore],
      open: flags.open,
      history: flags.history,
    });
    for (const id of plan.close) await dispatch.closeGapFlag(id, at);
    let raised = 0;
    for (const { gap, card } of plan.raise)
      if (gap.trigger === "explore" && (await dispatch.raiseGapFlag(gap, !card)) !== null) raised += 1;
    return raised;
  } finally {
    await dispatch.close();
  }
}

const flags = (w: WorkWorld): Promise<Flag[]> =>
  w.admin<Flag>(
    "select id, gap_subject, compartments, goal_id, gap_missing, gap_value, gap_parts, about_kind, about_id from ledger.opportunities where gap_trigger = 'explore' order by created_at, id",
  );
const subjects = async (w: WorkWorld): Promise<string[]> => (await flags(w)).map((one) => one.gap_subject).sort();

// A person with an address under the label.
async function person(w: WorkWorld, compartments = OWN): Promise<{ id: string; fp: string }> {
  const id = await w.seed.entity("person");
  const account = await w.seed.account(compartments, id);
  const [row] = await w.admin<{ value_fp: string }>("select value_fp from knowledge.accounts where id = $1", [account]);
  return { id, fp: row?.value_fp as string };
}

// A person the writer's binding step made from a name, marked named, with an account under the
// label as its name key is (its value here a seeded one: the frontier reads the mark, not the key).
async function named(w: WorkWorld, compartments = OWN): Promise<string> {
  const id = testId("ent");
  await w.admin("insert into knowledge.entities (id, kind, named) values ($1, 'person', true)", [id]);
  await w.seed.account(compartments, id);
  return id;
}

// The person's days under the label, from which the label's ranking gives the tier asked for
// (warmth-lines.ts), as the day build writes them.
async function warmth(w: WorkWorld, entity: string, tier: Tier, label = OWN): Promise<void> {
  await seedLines(w.db, label, [{ entity, tier, warmth: 1 }], { append: true });
}

// A relationship claim in a message `from` sent under the label, said by `from` (its assertedBy),
// `subject` the counterparty's relation: a first-hand one when `from` is a side, a report when not.
// The claim's record is sealed as the pipeline stores it; its id.
let said = 0;
async function relation(
  w: WorkWorld,
  options: { from: { id: string; fp: string }; subject: string; other: string; compartments?: string[] },
): Promise<string> {
  const compartments = options.compartments ?? OWN;
  const message = await w.message(compartments);
  await w.admin("update knowledge.messages set sender_fp = $2 where id = $1", [message.id, options.from.fp]);
  const claim = await w.seed.claim(compartments, message.evidence);
  said += 1;
  const at = new Date().toISOString();
  const base = claimRecord(message.evidence, compartments, options.subject, {
    n: said,
    type: "relationship",
    factKey: `frontier ${said}`,
    validFrom: at,
    entities: [options.subject, options.other],
  });
  const record = {
    ...base,
    claim: {
      ...base.claim,
      assertedBy: options.from.id,
      basis: "third_party",
      content: {
        type: "relationship",
        subject: options.subject,
        fields: { counterparty: options.other, relation: "colleague" },
      },
    } as unknown as Claim,
    subjectKind: "person",
    fieldKinds: { counterparty: "entity", relation: "enum" },
  } as ClaimRecord;
  await w.claims("update knowledge.claims set type = 'relationship', valid_from = $2, content_enc = $3 where id = $1", [
    claim,
    at,
    JSON.stringify(
      sealUnder(
        w.db.keys,
        compartments,
        { table: "knowledge.claims", id: claim, column: "content_enc" },
        JSON.stringify(record),
      ),
    ),
  ]);
  await w.seed.claimEntity(compartments, claim, options.subject);
  await w.seed.claimEntity(compartments, claim, options.other);
  return claim;
}

// A claim of `type` in a letter under `own`, linking `entities`; an ended one held from two days
// before `at` to one. Its id.
async function fact(
  w: WorkWorld,
  type: string,
  entities: readonly string[],
  options: { at?: Date; ended?: boolean } = {},
): Promise<string> {
  const at = options.at ?? new Date();
  const claim = await w.seed.claim(OWN, (await w.message(OWN)).evidence);
  await w.claims("update knowledge.claims set type = $2, valid_from = $3, valid_to = $4 where id = $1", [
    claim,
    type,
    new Date(at.getTime() - 2 * DAY_MS).toISOString(),
    options.ended ? new Date(at.getTime() - DAY_MS).toISOString() : null,
  ]);
  for (const one of entities) await w.seed.claimEntity(OWN, claim, one);
  return claim;
}

async function goal(w: WorkWorld, target: string, compartments = OWN): Promise<string> {
  const id = await w.goal(compartments, "meet someone");
  await w.admin("update projections.goal_state set target_entity_id = $2 where goal_id = $1", [id, target]);
  return id;
}

const agent = (w: WorkWorld, name: string, compartments: string[]): Promise<WorkClient> =>
  workAgent(w, name, compartments, { tools: READING_AGENT_TOOLS, kinds: ["research"] });

describe("the frontier", { timeout: DB_TEST_TIMEOUT }, () => {
  it("Ada's reported 'Theo works with Zoe' makes both frontier nodes, each named by Ada at Ada's tier, with what they lack; a meeting soon with Ada counts", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      const ada = await person(w);
      await tie(w, ada.id);
      await warmth(w, ada.id, "inner");
      const [theo, zoe] = [await named(w), await named(w)];
      await relation(w, { from: ada, subject: theo, other: zoe });

      const rows = await frontier(w, now);
      // Ada, the owner's own tie, is no node; Theo and Zoe are, under `own`.
      expect(rows.map((row) => row.subject).sort()).toEqual([theo, zoe].sort());
      for (const row of rows) {
        expect(row).toMatchObject({
          label: OWN,
          goal_id: null,
          facts: 1,
          ties: 1,
          goal_target: false,
          goal_path: false,
          goals: [],
          meeting_soon: false,
          namer_tiers: ["inner"],
          named_days: 0,
        });
        expect(row.missing).toEqual(["identity", "role", "affiliation", "relations", "links"]);
      }
      const parts = {
        goalTarget: false,
        goalPath: false,
        meetingSoon: false,
        namerTiers: ["inner"],
        namedDays: 0,
        missing: ["identity"] as const,
      };
      expect(frontierValue({ ...parts, missing: [...parts.missing] }).value).toBe(16);

      // A meeting with Ada in ten hours: within namedMeetingHours, so both nodes gain meetingSoon.
      const event = await w.seed.event(OWN);
      await w.seed.eventDetails(OWN, event);
      await w.admin("update knowledge.event_details set starts_at = $2, ends_at = $3 where event_id = $1", [
        event,
        new Date(now.getTime() + 10 * 3_600_000).toISOString(),
        new Date(now.getTime() + 11 * 3_600_000).toISOString(),
      ]);
      await w.admin(
        "insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments) values ($1, $2, 'participant', $3)",
        [event, ada.id, OWN],
      );
      expect((await frontier(w, now)).map((row) => row.meeting_soon)).toEqual([true, true]);
    }));

  it("goal-relevant nodes are always raised; two others a label a day, highest first; a rested node returns only when its value rises; a declined node never by code", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      await setTaskTier(w.admin, true, now);
      const [ada, ben, cal, dee, eve] = [
        await person(w),
        await person(w),
        await person(w),
        await person(w),
        await person(w),
      ];
      for (const one of [ada, ben, cal, dee, eve]) await tie(w, one.id);
      await warmth(w, dee.id, "inner");
      // The goal's target, named by Ada; a node one edge from it, reported by Ben.
      const target = await named(w);
      await relation(w, { from: ada, subject: ada.id, other: target });
      const near = await named(w);
      await relation(w, { from: ben, subject: near, other: target });
      const aim = await goal(w, target);
      // Others: one Dee (inner) names, worth 16; three Cal names, 6 each.
      const top = await named(w);
      await relation(w, { from: dee, subject: dee.id, other: top });
      const fives = [await named(w), await named(w), await named(w)].sort();
      for (const one of fives) await relation(w, { from: cal, subject: cal.id, other: one });

      const rows = await frontier(w, now);
      expect(rows.find((row) => row.subject === target)).toMatchObject({
        goal_target: true,
        goal_id: aim,
        goals: [aim],
      });
      expect(rows.find((row) => row.subject === near)).toMatchObject({
        goal_target: false,
        goal_path: true,
        goals: [aim],
      });

      // Day 0: both goal-relevant nodes, then the two best others, ties by the lower id.
      expect(await tick(w, now)).toBe(4);
      expect(await subjects(w)).toEqual([target, near, top, fives[0]].sort());
      const raised = await flags(w);
      for (const one of raised) {
        expect(one).toMatchObject({ compartments: OWN, about_kind: "entity", about_id: one.gap_subject });
        expect(one.gap_value).toBeGreaterThan(0);
        expect(one.gap_missing).toContain("identity");
      }
      expect(raised.find((one) => one.gap_subject === target)).toMatchObject({
        goal_id: aim,
        gap_parts: [100, 0, 0, 10, expect.any(Number)],
      });
      expect(raised.find((one) => one.gap_subject === top)?.gap_value).toBeCloseTo(16, 1);
      // The same day raises nothing more: the goal nodes are open and the day's two are spent.
      expect(await tick(w, now)).toBe(0);

      // The node worth 16 is explored: done by an agent. It rests, so the next day takes the other two.
      const topFlag = raised.find((one) => one.gap_subject === top)?.id as string;
      await w.status("opportunity", topFlag, "done", "client:scout");
      const day1 = new Date(now.getTime() + DAY_MS);
      // A goal set that day targets a new node: raised whatever the budget.
      const late = await named(w);
      await relation(w, { from: eve, subject: eve.id, other: late });
      await goal(w, late);
      expect(await tick(w, day1)).toBe(3);
      expect((await flags(w)).filter((one) => one.gap_subject === top)).toHaveLength(1);
      expect(await subjects(w)).toEqual([target, near, top, late, ...fives].sort());

      // The owner's no on one: never raised by code again.
      const declined = (await flags(w)).find((one) => one.gap_subject === fives[0])?.id as string;
      await w.status("opportunity", declined, "no_go", "owner");
      // A new edge to the rested node raises its value above the one it was raised at: it returns.
      await relation(w, { from: ben, subject: ben.id, other: top });
      const day2 = new Date(now.getTime() + 2 * DAY_MS);
      expect(await tick(w, day2)).toBe(1);
      expect((await flags(w)).filter((one) => one.gap_subject === top)).toHaveLength(2);
      expect((await flags(w)).filter((one) => one.gap_subject === fives[0])).toHaveLength(1);
      const day3 = new Date(now.getTime() + 3 * DAY_MS);
      expect(await tick(w, day3)).toBe(0);
    }));

  it("a name a contact alone gives raises nothing: no node, not even within a goal's reach; a mail's name for it is a node", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      const ada = await person(w);
      await tie(w, ada.id);
      // The goal's target is the person the contact is about, so its organization would be one edge away.
      const target = await named(w);
      await goal(w, target);
      const before = await frontier(w, now);
      const organization = testId("ent");
      await w.admin("insert into knowledge.entities (id, kind, named) values ($1, 'organization', true)", [
        organization,
      ]);
      const nameFp = "c".repeat(64);
      const contact = await w.seed.into("knowledge.contacts")(OWN);
      const [item] = await w.admin<{ evidence_id: string }>(
        "select evidence_id from knowledge.contacts where id = $1",
        [contact],
      );
      const evidence = item?.evidence_id as string;
      // A contact's item, as the writer stores it; the seeder's are a letter's.
      await session(w.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query("alter table vault.evidence_items no force row level security");
        await query("update vault.evidence_items set source_kind = 'crm' where id = $1", [evidence]);
        await query("alter table vault.evidence_items force row level security");
      });
      const claim = await w.seed.claim(OWN, evidence);
      await w.claims("update knowledge.claims set type = 'affiliation', valid_from = now() where id = $1", [claim]);
      await w.seed.claimEntity(OWN, claim, target);
      await queryAs(
        w.db.urls.writer,
        "insert into knowledge.claim_org_names (claim_id, name_fp, compartments) values ($1, $2, $3)",
        [claim, nameFp, OWN],
      );
      const nameRow = (from: string) => {
        const id = testId("onn");
        return queryAs(
          w.db.urls.writer,
          "insert into knowledge.org_names (id, entity_id, name_fp, name_enc, evidence_id, compartments) values ($1, $2, $3, $4, $5, $6)",
          [
            id,
            organization,
            nameFp,
            sealUnder(w.db.keys, OWN, { table: "knowledge.org_names", id, column: "name_enc" }, "Northwind"),
            from,
            OWN,
          ],
        );
      };
      await nameRow(evidence);
      expect(await frontier(w, now)).toEqual(before);

      // The positive control: a letter names it too, and it is a node.
      await nameRow((await w.message(OWN)).evidence);
      expect((await frontier(w, now)).map((row) => row.subject)).toContain(organization);
    }));

  it("what the owner's own facts name is no node: an employer, a past employer, a named organization by name, a person; what others' claims name still is", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      const ada = await person(w);
      await tie(w, ada.id);
      const [employer, past, other] = [
        await w.seed.entity("organization"),
        await w.seed.entity("organization"),
        await w.seed.entity("organization"),
      ];
      const [colleague, former, peer, friend, friends, lead, leads] = [
        await named(w),
        await named(w),
        await named(w),
        await named(w),
        await named(w),
        await named(w),
        await named(w),
      ];
      // Others' claims make each a node: a colleague's affiliation, a former colleague's role, a
      // peer's affiliation, and Ada's reports of two pairs.
      await fact(w, "affiliation", [colleague, employer], { at: now });
      await fact(w, "role", [former, past], { at: now });
      await fact(w, "affiliation", [peer, other], { at: now });
      await relation(w, { from: ada, subject: friend, other: friends });
      await relation(w, { from: ada, subject: lead, other: leads });
      // A named organization a letter names.
      const brand = testId("ent");
      await w.admin("insert into knowledge.entities (id, kind, named) values ($1, 'organization', true)", [brand]);
      const nameFp = "d".repeat(64);
      const nameId = testId("onn");
      await queryAs(
        w.db.urls.writer,
        "insert into knowledge.org_names (id, entity_id, name_fp, name_enc, evidence_id, compartments) values ($1, $2, $3, $4, $5, $6)",
        [
          nameId,
          brand,
          nameFp,
          sealUnder(w.db.keys, OWN, { table: "knowledge.org_names", id: nameId, column: "name_enc" }, "Contoso"),
          (await w.message(OWN)).evidence,
          OWN,
        ],
      );
      const before = (await frontier(w, now)).map((row) => row.subject);
      const own = [employer, past, brand, friend];
      expect(before).toEqual(expect.arrayContaining([...own, other, colleague, former, peer, friends, lead, leads]));

      // The owner's own facts: an affiliation naming the employer, a role at the past employer that
      // ended yesterday, an affiliation naming the named organization by name alone, a relationship
      // naming the friend (the owner its other side).
      await fact(w, "affiliation", [employer], { at: now });
      await fact(w, "role", [past], { at: now, ended: true });
      const byName = await fact(w, "affiliation", [], { at: now });
      await queryAs(
        w.db.urls.pipeline,
        "insert into knowledge.claim_org_names (claim_id, name_fp, compartments) values ($1, $2, $3)",
        [byName, nameFp, OWN],
      );
      await fact(w, "relationship", [friend], { at: now });
      // Not the owner's: a role naming one person (its subject, someone else), and an intro offer and
      // a relationship that link a single entity, as neither can have the owner as a side.
      await fact(w, "role", [lead], { at: now });
      await fact(w, "intro_offer", [leads], { at: now });
      await fact(w, "relationship", [other], { at: now });

      const after = (await frontier(w, now)).map((row) => row.subject);
      for (const one of own) expect(after).not.toContain(one);
      expect([...after].sort()).toEqual(before.filter((one) => !own.includes(one)).sort());
    }));

  it("explore values, raises and briefs under employer:x change nothing an own-only client reads, and nothing is raised under employer:x", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      await setTaskTier(w.admin, true, now);
      const scout = await agent(w, "scout", OWN);
      const ada = await person(w);
      await tie(w, ada.id);
      const zed = await named(w);
      const fact = await relation(w, { from: ada, subject: ada.id, other: zed });
      const before = await frontier(w, now);

      expect(await tick(w, now)).toBe(1);
      const [flag] = await flags(w);
      expect(flag).toMatchObject({ gap_subject: zed, compartments: OWN });
      const claim = async () =>
        ok(await w.work.claimOpportunity(scout.token, { id: flag?.id as OpportunityId, requestId: request() }));
      const first = await claim();
      expect(first.opportunity.gap).toMatchObject({
        trigger: "explore",
        missing: "profile",
        lacks: ["identity", "role", "affiliation", "relations", "links"],
      });
      expect(first.brief?.explore).toEqual({
        missing: ["identity", "role", "affiliation", "relations", "links"],
        edges: [{ fact, by: ada.id, with: ada.id }],
        goals: [],
      });

      // Under employer:x: the owner's colleague, at the inner tier there, names Zed and another person; a
      // goal there targets Zed; a meeting with the colleague is soon.
      const wren = await person(w, WORK);
      await tie(w, wren.id, WORK);
      await warmth(w, wren.id, "inner", WORK);
      await relation(w, { from: wren, subject: wren.id, other: zed, compartments: WORK });
      const kit = await named(w, WORK);
      await relation(w, { from: wren, subject: wren.id, other: kit, compartments: WORK });
      await goal(w, zed, WORK);
      await goal(w, kit, WORK);

      expect(await frontier(w, now)).toEqual(before);
      expect(await tick(w, now)).toBe(0);
      expect((await flags(w)).map((one) => one.compartments)).toEqual([OWN]);
      const second = await claim();
      expect(second.opportunity.gap).toEqual(first.opportunity.gap);
      expect(second.brief?.explore).toEqual(first.brief?.explore);
      // Only pi_pipeline executes the frontier's read; no role executes its helper.
      for (const url of [w.db.urls.reader, w.db.urls.work])
        await expect(queryAs(url, "select * from ledger.explore_gaps(now(), 36, '{}'::jsonb)")).rejects.toMatchObject({
          code: "42501",
        });
      for (const url of [w.db.urls.pipeline, w.db.urls.work])
        await expect(
          queryAs(url, "select * from ledger.gap_frontier('{own}'::text[], now(), 36, '{}'::jsonb)"),
        ).rejects.toMatchObject({ code: "42501" });
      // The tiers are a map from a person's id to a tier; anything else is refused.
      for (const tiers of [null, "[]"])
        await expect(
          queryAs(w.db.urls.pipeline, "select * from ledger.explore_gaps(now(), 36, $1::jsonb)", [tiers]),
        ).rejects.toMatchObject({ code: "22023" });
      // raise_gap_flag takes an explore flag only about and from its node, with what it lacks and a value.
      await expect(
        queryAs(
          w.db.urls.pipeline,
          "select ledger.raise_gap_flag($1, 'explore', $2, 'entity', $2, 'entity', $2, null, null, true)",
          [testId("opp"), kit],
        ),
      ).rejects.toMatchObject({ code: "22023" });
      await expect(
        queryAs(
          w.db.urls.pipeline,
          "select ledger.raise_gap_flag($1, 'explore', $2, 'entity', $2, 'entity', $2, null, null, true, '{ask}'::text[], 5::double precision, '{0,0,0,5,1}'::double precision[], null)",
          [testId("opp"), kit],
        ),
      ).rejects.toMatchObject({ code: "22023" });
      // The tick, which holds no keys, raises no explore flag.
      await expect(
        queryAs(
          w.db.urls.work,
          "select ledger.raise_gap_flag($1, 'explore', $2, 'entity', $2, 'entity', $2, null, null, true, '{identity}'::text[], 5::double precision, '{0,0,0,5,1}'::double precision[], null) as id",
          [testId("opp"), zed],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      // Kit, named under employer:x alone, is never raised: no claim under `own` names Kit.
      expect(
        await queryAs(
          w.db.urls.pipeline,
          "select ledger.raise_gap_flag($1, 'explore', $2, 'entity', $2, 'entity', $2, null, null, true, '{identity}'::text[], 5::double precision, '{0,0,0,5,1}'::double precision[], null) as id",
          [testId("opp"), kit],
        ),
      ).toEqual([{ id: null }]);
    }));
});
