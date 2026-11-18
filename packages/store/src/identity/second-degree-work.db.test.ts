import { GAP_ASK, type OpportunityId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { sealUnder } from "../core/seal.ts";
import { request, testId } from "../test-support/clients.ts";
import { queryAs } from "../test-support/database.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { interactionId } from "../test-support/values.ts";
import { warmthWorld } from "../test-support/warmth-fixtures.ts";
import { READING_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { scanGapFlags as scan, tie } from "../test-support/work-seeds.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// SD-B11, SD-B13, SD-B15. Synthetic rows only.

const OWN = ["own"];
const WORK = ["employer:example"];

type Flag = {
  id: string;
  gap_trigger: string;
  gap_subject: string;
  gap_source: string;
  compartments: string[];
  about_kind: string;
  about_id: string;
  goal_id: string | null;
  tier: string;
};

const flags = (w: WorkWorld, trigger: string): Promise<Flag[]> =>
  w.admin<Flag>(
    "select id, gap_trigger, gap_subject, gap_source, compartments, about_kind, about_id, goal_id, tier from ledger.opportunities where gap_trigger = $1 order by about_id, compartments",
    [trigger],
  );

// A person with an address under the label; returns the person and the address's fingerprint.
async function person(w: WorkWorld, compartments = OWN): Promise<{ id: string; fp: string }> {
  const id = await w.seed.entity("person");
  const account = await w.seed.account(compartments, id);
  const [row] = await w.admin<{ value_fp: string }>("select value_fp from knowledge.accounts where id = $1", [account]);
  return { id, fp: row?.value_fp as string };
}

// A relation claim (relationship or intro_offer) in a message whose sender is `from`, naming
// `subject` and `other`, the message and the claim under the label.
async function said(
  w: WorkWorld,
  options: {
    from: { fp: string };
    type: "relationship" | "intro_offer";
    subject: string;
    other: string;
    compartments?: string[];
    claimCompartments?: string[];
  },
): Promise<void> {
  const compartments = options.compartments ?? OWN;
  const message = await w.message(compartments);
  await w.admin("update knowledge.messages set sender_fp = $2 where id = $1", [message.id, options.from.fp]);
  const label = options.claimCompartments ?? compartments;
  const claim = await w.seed.claim(label, message.evidence);
  await w.claims("update knowledge.claims set type = $2 where id = $1", [claim, options.type]);
  await w.seed.claimEntity(label, claim, options.subject);
  await w.seed.claimEntity(label, claim, options.other);
}

async function goal(w: WorkWorld, target: string, compartments = OWN): Promise<string> {
  const id = await w.goal(compartments, "meet someone");
  await w.admin("update projections.goal_state set target_entity_id = $2 where goal_id = $1", [id, target]);
  return id;
}

// The owner's veto of research on a person, by the person's address.
async function veto(w: WorkWorld, fp: string): Promise<void> {
  const ruling = testId("rul");
  await w.admin(
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto', 0, '{}', '{}', now(), '{own}')",
    [ruling, testId("req")],
  );
  await w.admin(
    "insert into knowledge.vetoes (ruling_id, subject, value_fps, work_kind, created_at, compartments) values ($1, 'person', $2, 'research', now(), '{own}')",
    [ruling, [fp]],
  );
}

const agent = (w: WorkWorld, name: string, compartments: string[]): Promise<WorkClient> =>
  workAgent(w, name, compartments, { tools: READING_AGENT_TOOLS, kinds: ["research"] });

const introducers = async (w: WorkWorld, target: string, label: string[]): Promise<string[]> =>
  (
    await queryAs<{ entity_id: string }>(
      w.db.urls.work,
      "select entity_id from ledger.gap_intro_paths($1, $2::text[], now())",
      [target, label],
    )
  ).map((row) => row.entity_id);

describe("second-degree work", { timeout: DB_TEST_TIMEOUT }, () => {
  it("intro_path is raised once per target and label, its brief listing two introducers and two goals that reach it; a target with an own tie raises nothing; a veto of the target raises nothing", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      const scout = await agent(w, "scout", OWN);
      await setTaskTier(w.admin, true, now);

      // Two people the owner has an own tie with, each saying, first-hand in mail, that they know
      // the target or will introduce them.
      const [ada, ben] = [await person(w), await person(w)];
      await tie(w, ada.id);
      await tie(w, ben.id);
      const theo = await person(w);
      await said(w, { from: ada, type: "relationship", subject: ada.id, other: theo.id });
      await said(w, { from: ben, type: "intro_offer", subject: ben.id, other: theo.id });
      // A third person the owner knows whose relation to the target someone else reported: no introducer.
      const cal = await person(w);
      await tie(w, cal.id);
      await said(w, { from: ada, type: "relationship", subject: cal.id, other: theo.id });
      const first = await goal(w, theo.id);
      const second = await goal(w, theo.id);

      // A target the owner already has an own tie with raises nothing, however reachable.
      const zoe = await person(w);
      await tie(w, zoe.id);
      await said(w, { from: ada, type: "relationship", subject: ada.id, other: zoe.id });
      await goal(w, zoe.id);
      // A target the owner vetoed research on raises nothing.
      const vic = await person(w);
      await said(w, { from: ben, type: "intro_offer", subject: ben.id, other: vic.id });
      await goal(w, vic.id);
      await veto(w, vic.fp);

      expect((await introducers(w, theo.id, OWN)).sort()).toEqual([ada.id, ben.id].sort());
      await scan(w, now);
      const raised = await flags(w, "intro_path");
      expect(raised.map((one) => [one.about_kind, one.about_id, one.gap_subject, one.compartments, one.tier])).toEqual([
        ["entity", theo.id, theo.id, OWN, "task"],
      ]);
      const [flag] = raised;
      expect([first, second]).toContain(flag?.goal_id);
      expect(flag?.gap_source).toBe(flag?.goal_id);
      expect(await w.latest("opportunity", flag?.id as string)).toBe("go");
      // gap_warm reads both claims as links: no target here lacks a warm path.
      expect(await flags(w, "no_warm_path")).toEqual([]);
      // Once: a second tick raises nothing more.
      expect((await scan(w, now)).raised).toBe(0);
      expect(await flags(w, "intro_path")).toHaveLength(1);

      // The brief lists both introducers and both goals, ids only, with what the task asks.
      const claimed = ok(
        await w.work.claimOpportunity(scout.token, { id: flag?.id as OpportunityId, requestId: request() }),
      );
      expect(claimed.opportunity.gap).toEqual({ trigger: "intro_path", missing: "ask", ask: GAP_ASK.intro_path });
      expect(claimed.opportunity.about).toEqual({ kind: "entity", id: theo.id });
      expect([...(claimed.brief?.introPath?.introducers ?? [])].sort()).toEqual([ada.id, ben.id].sort());
      expect([...(claimed.brief?.introPath?.goals ?? [])].sort()).toEqual([first, second].sort());

      // pi_work alone executes the introducers' read.
      await expect(
        queryAs(w.db.urls.reader, "select * from ledger.gap_intro_paths($1, '{own}'::text[], now())", [theo.id]),
      ).rejects.toMatchObject({ code: "42501" });
      // raise_gap_flag takes an introduction path only about its subject, from and for one goal.
      await expect(
        queryAs(
          w.db.urls.work,
          "select ledger.raise_gap_flag($1, 'intro_path', $2, 'entity', $3, 'goal', $4, $4, null, true)",
          [testId("opp"), theo.id, ada.id, first],
        ),
      ).rejects.toMatchObject({ code: "22023" });
    }));

  it("a filed relation row waiting for its binding raises no unresolved_mention; a filed name of any other type does", () =>
    withWorkWorld(async (w) => {
      const file = async (name: string, flags: { relation: boolean; hasSpeaker: boolean }): Promise<string> => {
        const message = await w.message(OWN);
        const id = testId("umn");
        const nameFp = fingerprint(w.db.keys, "name", name);
        await w.admin(
          "insert into vault.unresolved_mentions (id, evidence_id, extractor_generation, name_fp, facts_enc, compartments, relation, has_speaker) values ($1, $2, 1, $3, $4, $5, $6, $7)",
          [
            id,
            message.evidence,
            nameFp,
            JSON.stringify(
              sealUnder(
                w.db.keys,
                OWN,
                { table: "vault.unresolved_mentions", id, column: "facts_enc" },
                JSON.stringify({
                  name,
                  type: flags.relation ? "relationship" : "role",
                  field: flags.relation ? "counterparty" : "subject",
                }),
              ),
            ),
            OWN,
            flags.relation,
            flags.hasSpeaker,
          ],
        );
        return nameFp;
      };
      const waiting = await file("Theo Marsh", { relation: true, hasSpeaker: true });
      const role = await file("Zoe Lark", { relation: false, hasSpeaker: true });
      // A relation no one said (an agent's finding): no binding waits for it, so it stays on the board.
      const unsaid = await file("Ivy Stone", { relation: true, hasSpeaker: false });
      const subjects = (
        await queryAs<{ trigger: string; subject: string }>(
          w.db.urls.work,
          "select trigger, subject from ledger.gap_candidates(now(), 3)",
        )
      )
        .filter((row) => row.trigger === "unresolved_mention")
        .map((row) => row.subject);
      expect(subjects.sort()).toEqual([role, unsaid].sort());
      expect(subjects).not.toContain(waiting);
    }));

  it("mail read by its headers is an own tie for the gaps, and counts for an attendee", () =>
    withWorkWorld(async (w) => {
      // Mail both ways, each with interaction rows of the headers channel and no message row.
      const headersTie = async (entity: string): Promise<void> => {
        for (const direction of ["inbound", "outbound"] as const) {
          const message = await w.message(OWN);
          await w.admin("delete from knowledge.messages where id = $1", [message.id]);
          await w.admin(
            `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, compartments, readers, entity_role)
             values ($1, $2, 'm-owner', $3, $4, 'mail_headers', now() - interval '900 days', $5, '{m-owner}', $6)`,
            [
              interactionId(message.evidence, entity),
              message.evidence,
              entity,
              direction,
              OWN,
              direction === "inbound" ? "sender" : "recipient",
            ],
          );
        }
      };
      const candidates = () =>
        queryAs<{ trigger: string; subject: string; ties: number | null }>(
          w.db.urls.work,
          "select trigger, subject, ties from ledger.gap_candidates(now(), 3)",
        );
      const theo = await person(w);
      await goal(w, theo.id, OWN);
      const eve = await person(w);
      await said(w, { from: eve, type: "relationship", subject: eve.id, other: theo.id });
      await headersTie(eve.id);
      // Eve introduces, on a headers-only tie, so Theo has a path.
      expect(
        await queryAs<{ entity_id: string }>(
          w.db.urls.work,
          "select entity_id from ledger.gap_intro_paths($1, $2, now())",
          [theo.id, OWN],
        ),
      ).toEqual([{ entity_id: eve.id }]);
      expect((await candidates()).filter((one) => one.trigger === "intro_path").map((one) => one.subject)).toEqual([
        theo.id,
      ]);

      // Once the owner has years of such mail with Theo too, no introduction is asked for.
      await headersTie(theo.id);
      expect((await candidates()).filter((one) => one.trigger === "intro_path")).toEqual([]);

      // And a meeting's attendee counts it.
      await warmthWorld(w.db).meeting(OWN, [theo.id], new Date(Date.now() + 86_400_000).toISOString());
      const attendee = (await candidates()).find(
        (one) => one.trigger === "unknown_attendee" && one.subject === theo.id,
      );
      expect(attendee?.ties).toBe(2);
    }));

  it("gap_intro_paths under one label returns no introducer whose tie or relation claim is under another (invariant 6)", () =>
    withWorkWorld(
      async (w) => {
        const now = new Date();
        await setTaskTier(w.admin, true, now);
        const theo = await person(w);
        await goal(w, theo.id, OWN);
        // The owner's tie with Eve is the employer's; Eve's claim is the owner's own mail.
        const eve = await person(w);
        await tie(w, eve.id, WORK);
        await said(w, { from: eve, type: "intro_offer", subject: eve.id, other: theo.id });
        // The owner's tie with Finn is the owner's own; Finn's claim is under the employer's label.
        const finn = await person(w);
        await tie(w, finn.id);
        await said(w, { from: finn, type: "relationship", subject: finn.id, other: theo.id, compartments: WORK });

        expect(await introducers(w, theo.id, OWN)).toEqual([]);
        expect(await introducers(w, theo.id, WORK)).toEqual([]);
        expect((await introducers(w, theo.id, [...WORK, ...OWN].sort())).sort()).toEqual([eve.id, finn.id].sort());
        // A restricted label returns nothing.
        expect(await introducers(w, theo.id, [...OWN, "restricted:health"])).toEqual([]);
        // The goal is the owner's own: the employer's rows raise no intro_path under it.
        await scan(w, now);
        expect(await flags(w, "intro_path")).toEqual([]);
      },
      ["own", "employer:example"],
    ));
});
