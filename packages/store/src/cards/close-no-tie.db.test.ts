import { createHash } from "node:crypto";
import { type EntityId, GAP_ASK, type OpportunityView, type Tier } from "@intelligence/contracts/personal";
import { planGapFlags } from "@intelligence/personal-core/planner";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { seedAudience, seedLines } from "../test-support/warmth-lines.ts";
import { READING_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { closeLanePeople, createGapLaneStore } from "../work/gap-lanes.ts";

// close_no_tie, through the pipeline's pass over the warmth lanes as pi_pipeline: a
// person in the owner's inner or close warmth tier (ontology/autonomy.json), ranked at read from the
// days within the owner's audience, with no owner_tie claim naming them raises one read-only task:
// propose their tie with propose_person. Synthetic rows only.

const OWN = ["own"];
const WORK = ["employer:example"];
const HIDDEN = "restricted:health";

type Flag = {
  id: string;
  gap_subject: string;
  gap_source: string;
  compartments: string[];
  about_kind: string;
  about_id: string;
  tier: string;
};

// The pipeline's pass, as the tick's step 3b ran it: close, then raise.
async function scan(w: WorkWorld, now: Date): Promise<{ raised: number; closed: number; waiting: number }> {
  const lanes = createGapLaneStore({ url: w.db.urls.pipeline, keys: w.db.keys, log: w.log });
  try {
    const flags = await lanes.gapFlags(now);
    const plan = planGapFlags({
      candidates: await lanes.gapCandidates(now),
      open: flags.open,
      history: flags.history,
    });
    const counts = { raised: 0, closed: 0, waiting: 0 };
    for (const id of plan.close) if (await lanes.closeGapFlag(id, now)) counts.closed += 1;
    for (const { gap, card } of plan.raise) {
      if ((await lanes.raiseGapFlag(gap, !card)) !== null) counts.raised += 1;
      else counts.waiting += 1;
    }
    return counts;
  } finally {
    await lanes.close();
  }
}

const flags = (w: WorkWorld): Promise<Flag[]> =>
  w.admin<Flag>(
    "select id, gap_subject, gap_source, compartments, about_kind, about_id, tier from ledger.opportunities where gap_trigger = 'close_no_tie' order by about_id",
  );

const subjectOf = (entity: string, label: string[]): string =>
  `${entity}_${createHash("md5")
    .update([...label].sort().join(","), "utf8")
    .digest("hex")}`;

const agent = (w: WorkWorld, name: string, compartments: string[]): Promise<WorkClient> =>
  workAgent(w, name, compartments, { tools: READING_AGENT_TOOLS, kinds: ["research"] });

const board = async (w: WorkWorld, client: WorkClient): Promise<OpportunityView[]> =>
  ok(await w.work.listOpportunities(client.token, { scope: "board" })).opportunities.filter(
    (one) => one.gap?.trigger === "close_no_tie",
  );

// A person's warmth under one label, seeded as the day build writes it, the tier being what the
// owner's ranking of those days gives (warmth-lines.ts). Returns the person's id.
async function warm(
  w: WorkWorld,
  options: { label: string[]; tier: Tier; warmth?: number; entity?: string; now: Date },
): Promise<string> {
  const entity = options.entity ?? (await w.seed.entity("person"));
  await seedLines(w.db, options.label, [{ entity, tier: options.tier, warmth: options.warmth ?? 1 }], {
    append: true,
    today: options.now,
  });
  return entity;
}

// A warm day of a person's under a restricted label, written as the restricted worker writes it:
// no pi_pipeline read sees it.
async function restrictedDay(w: WorkWorld, label: string[]): Promise<void> {
  const entity = await w.seed.entity("person");
  await session(w.db.urls.restricted, (query) =>
    query(
      `insert into projections.warmth_days (entity_id, day, compartments, out_w, in_w, meet_w, email_out, email_in, chat_out, chat_in,
         meet_n, started, runs, answered, answer_hours, mutual, theirs) values ($1, current_date, $2, 0, 0, 9, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0)`,
      [entity, [...label].sort()],
    ),
  );
}

// An owner_tie claim naming the person, under the label: the owner's confirmed tie (released under
// `own`) or an agent's proposal waiting for the owner's card. Seeded as the fixtures seed claims.
async function tie(w: WorkWorld, entity: string, compartments: string[]): Promise<void> {
  const claim = await w.seed.claim(compartments);
  await w.claims("update knowledge.claims set type = 'owner_tie' where id = $1", [claim]);
  await w.seed.claimEntity(compartments, claim, entity);
}

// Two people the owner ruled the same, each with an address under the label: one group.
async function group(w: WorkWorld, a: string, b: string, label: string[]): Promise<void> {
  for (const one of [a, b]) await w.seed.account(label, one);
  const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log, recordEnabled: true });
  try {
    await admin.identity.linkPeople(a as EntityId, b as EntityId, "same", { requestId: testId("req") });
  } finally {
    await admin.close();
  }
}

describe("close people with no tie get a task that proposes one", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a close person with no tie raises one read-only task, once; a tie, confirmed or proposed, raises none and closes it", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      const scout = await agent(w, "scout", OWN);
      await setTaskTier(w.admin, true, now);
      await seedAudience((one) => w.seed.claim([one]), [OWN]);

      const inner = await warm(w, { label: OWN, tier: "inner", now });
      const close = await warm(w, { label: OWN, tier: "close", now });
      // Not close enough: a regular person raises nothing.
      await warm(w, { label: OWN, tier: "regular", now });
      // A confirmed tie, and a proposal waiting for the owner's card: neither raises.
      const confirmed = await warm(w, { label: OWN, tier: "inner", now });
      await tie(w, confirmed, OWN);
      const proposed = await warm(w, { label: OWN, tier: "close", now });
      await tie(w, proposed, OWN);
      // A group whose other member holds the tie: the group has one.
      const member = await w.seed.entity("person");
      const grouped = await warm(w, { label: OWN, tier: "close", now });
      await group(w, grouped, member, OWN);
      await tie(w, member, OWN);

      expect((await scan(w, now)).raised).toBe(2);
      const raised = await flags(w);
      expect(raised.map((one) => [one.about_kind, one.about_id, one.gap_source, one.gap_subject])).toEqual(
        [inner, close].sort().map((entity) => ["entity", entity, entity, subjectOf(entity, OWN)]),
      );
      for (const one of raised) {
        expect(one.compartments).toEqual(OWN);
        expect(one.tier).toBe("task");
        expect(await w.latest("opportunity", one.id)).toBe("go");
        // It rests on the person alone.
        expect(
          await w.admin("select ref_kind, ref_id from ledger.basis where row_kind = 'opportunity' and row_id = $1", [
            one.id,
          ]),
        ).toEqual([{ ref_kind: "entity", ref_id: one.about_id }]);
      }
      expect(
        await w.admin("select count(*)::int as n from ledger.cards where target_id = any ($1)", [
          raised.map((one) => one.id),
        ]),
      ).toEqual([{ n: 0 }]);

      // Once: a second pass raises nothing more.
      expect((await scan(w, now)).raised).toBe(0);
      expect(await flags(w)).toHaveLength(2);

      // The agent's board names the person by id and says what to do, with no summary of a model's.
      const seen = await board(w, scout);
      expect(seen.map((one) => [one.about, one.gap?.missing, one.gap?.ask, one.summary, one.kind])).toEqual(
        [inner, close]
          .sort()
          .map((entity) => [{ kind: "entity", id: entity }, "tie", GAP_ASK.close_no_tie, null, "research"]),
      );
      expect(GAP_ASK.close_no_tie).toContain("propose_person");

      // The tie arrives (an agent's proposal, built into its claim): the task closes, as a gap
      // flag whose gap filled does.
      await tie(w, close, OWN);
      expect((await scan(w, now)).closed).toBe(1);
      expect(await w.latest("opportunity", raised.find((one) => one.about_id === close)?.id as string)).toBe(
        "withdrawn",
      );
      expect(await w.latest("opportunity", raised.find((one) => one.about_id === inner)?.id as string)).toBe("go");
    }));

  it("at most max_people of an audience, closest tier first, then warmest; the tiers are the caller's; a bad request is refused", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      // Two audiences of their own, each ranked apart, besides the owner's.
      await agent(w, "own-only", OWN);
      await agent(w, "work-only", WORK);
      await seedAudience((one) => w.seed.claim([one]), [OWN, WORK]);
      const cold = await warm(w, { label: OWN, tier: "inner", warmth: 1, now });
      const hot = await warm(w, { label: OWN, tier: "close", warmth: 9, now });
      const first = await warm(w, { label: OWN, tier: "inner", warmth: 2, now });
      // Another audience's people take none of this audience's places.
      const other = await warm(w, { label: WORK, tier: "close", warmth: 1, now });
      const people = await session(w.db.urls.pipeline, (query) =>
        closeLanePeople({ query, keys: w.db.keys }, now, ["inner", "close", "regular"]),
      );
      const gaps = async (tiers: string[], max: number): Promise<string[]> =>
        (
          await queryAs<{ about_id: string }>(
            w.db.urls.pipeline,
            "select about_id from ledger.close_no_tie_gaps($1::text[], $2, $3::jsonb)",
            [tiers, max, people],
          )
        )
          .map((row) => row.about_id)
          .sort();

      expect(await gaps(["inner", "close"], 2)).toEqual([cold, first, other].sort());
      expect(await gaps(["close", "inner"], 1)).toEqual([hot, other].sort());
      expect(await gaps(["inner", "close"], 30)).toEqual([cold, hot, first, other].sort());
      expect(await gaps(["regular"], 30)).toEqual([]);
      for (const [tiers, max, given] of [
        [[], 30, people],
        [["inner"], 0, people],
        [["inner"], 151, people],
        [["inner"], 30, null],
        [["inner"], 30, "{}"],
      ] as const) {
        await expect(
          queryAs(w.db.urls.pipeline, "select * from ledger.close_no_tie_gaps($1::text[], $2, $3::jsonb)", [
            tiers,
            max,
            given,
          ]),
        ).rejects.toMatchObject({ code: "22023" });
      }
      // pi_pipeline alone executes it.
      for (const url of [w.db.urls.reader, w.db.urls.work])
        await expect(
          queryAs(url, "select * from ledger.close_no_tie_gaps('{inner}'::text[], 1, '[]'::jsonb)"),
        ).rejects.toMatchObject({ code: "42501" });
      // A person source is the close_no_tie trigger's alone, about that person, labelled by the
      // label the ranking gave, which its subject names: anything else raises nothing or is refused.
      const raise = (
        url: string,
        trigger: string,
        subject: string,
        about: string,
        source: string,
        label: string[] | null,
        members: string[] | null = label === null ? null : [source],
      ): Promise<{ id: string | null }[]> =>
        queryAs(
          url,
          "select ledger.raise_gap_flag($1, $2, $3, 'entity', $4, 'entity', $5, null, null, true, null, null, null, null, $6::text[], $7::text[]) as id",
          [testId("opp"), trigger, subject, about, source, label, members],
        );
      const pipeline = w.db.urls.pipeline;
      await expect(raise(pipeline, "unknown_attendee", subjectOf(cold, OWN), cold, cold, null)).rejects.toMatchObject({
        code: "22023",
      });
      await expect(raise(pipeline, "close_no_tie", subjectOf(cold, OWN), cold, hot, OWN)).rejects.toMatchObject({
        code: "22023",
      });
      await expect(raise(pipeline, "close_no_tie", subjectOf(cold, OWN), cold, cold, null)).rejects.toMatchObject({
        code: "22023",
      });
      // The group's members come with the label, the person among them.
      for (const members of [null, [], [hot]])
        await expect(
          raise(pipeline, "close_no_tie", subjectOf(cold, OWN), cold, cold, OWN, members),
        ).rejects.toMatchObject({ code: "22023" });
      expect(await raise(pipeline, "close_no_tie", subjectOf(cold, WORK), cold, cold, OWN)).toEqual([{ id: null }]);
      // The tick, which holds no keys, raises no close person's flag.
      await expect(raise(w.db.urls.work, "close_no_tie", subjectOf(cold, OWN), cold, cold, OWN)).rejects.toMatchObject({
        code: "42501",
      });
    }));

  // ledger.raise_gap_flag takes no label on trust: it holds every label of the group's warmth days
  // within a clearance the ranking could have been computed under.
  it("a close person's flag under a label narrower than the warmth days of the group it was ranked from raises nothing", () =>
    withWorkWorld(
      async (w) => {
        const now = new Date();
        await setTaskTier(w.admin, true, now);
        await seedAudience((one) => w.seed.claim([one]), [OWN, WORK]);
        // Close by the employer's days, one of a group whose other member has days under `own`.
        const person = await warm(w, { label: WORK, tier: "close", now });
        const member = await w.seed.entity("person");
        await warm(w, { label: OWN, tier: "close", entity: member, now });
        const raise = (label: string[], members: string[]): Promise<{ id: string | null }[]> =>
          queryAs(
            w.db.urls.pipeline,
            "select ledger.raise_gap_flag($1, 'close_no_tie', $2, 'entity', $3, 'entity', $3, null, null, true, null, null, null, null, $4::text[], $5::text[]) as id",
            [testId("opp"), subjectOf(person, label), person, [...label].sort(), members],
          );
        // No clearance holds the employer's label without `own`: under it alone, the member's own
        // days are left out, and nothing is raised.
        expect(await raise(WORK, [person, member])).toEqual([{ id: null }]);
        // The control: the label of every day of the group.
        expect((await raise([...OWN, ...WORK], [person, member]))[0]?.id).not.toBeNull();
      },
      ["own", "employer:example"],
    ));

  it("invariant 6: a hidden compartment's warmth or tie changes nothing a clearance without it sees; a restricted label raises nothing", () =>
    withWorkWorld(
      async (w) => {
        const now = new Date();
        const own = await agent(w, "own-only", OWN);
        const both = await agent(w, "both", [...OWN, ...WORK]);
        await setTaskTier(w.admin, true, now);
        await seedAudience((one) => w.seed.claim([one]), [OWN, WORK]);

        // Close only through the employer's days: its task is under that label, unseen by own.
        const hidden = await warm(w, { label: WORK, tier: "inner", now });
        // A tie claim under the employer's label does not fill an own gap.
        const visible = await warm(w, { label: OWN, tier: "close", now });
        await tie(w, visible, WORK);
        // A restricted label's days, or a label with a restricted compartment, raise nothing.
        await restrictedDay(w, [...OWN, HIDDEN]);
        await restrictedDay(w, [HIDDEN]);

        await scan(w, now);
        expect((await flags(w)).map((one) => [one.about_id, one.compartments.join(",")]).sort()).toEqual(
          [
            [hidden, "employer:example"],
            [visible, "own"],
          ].sort(),
        );
        const ids = (views: OpportunityView[]): string[] =>
          views.map((one) => (one.about.kind === "owner" ? "" : one.about.id)).sort();
        expect(ids(await board(w, own))).toEqual([visible]);
        expect(ids(await board(w, both))).toEqual([hidden, visible].sort());
      },
      ["own", "employer:example"],
    ));
});
