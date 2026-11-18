import type { SourceDeletion } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { AdminError } from "../../core/admin-error.ts";
import { CANARY_PERSON, QUENTIN } from "../../test-support/cast.ts";
import { sqlState } from "../../test-support/connections.ts";
import { queryAs } from "../../test-support/database.ts";
import { mailSourceId } from "../../test-support/items.ts";
import { MAIL } from "../../test-support/items-named.ts";
import { batchOf, countOf, rowsOf, stored } from "../../test-support/pipeline-fixtures.ts";
import {
  beliefUnder,
  commitment,
  factIdOf,
  factKeyFpOf,
  personOf,
  type RulingStore,
  withRulings,
} from "../../test-support/ruling-fixtures.ts";

// The owner's rulings on beliefs: each write in one transaction, a decision through writeDecision and one
// ruling row, applied at once to the belief each clearance that sees it is given. Each refusal has its
// control.

const TIMEOUT = 180_000;
const OWN = ["own"];
const WORK = ["employer:example"];
const BOTH = ["employer:example", "own"];

const codeOf = (call: Promise<unknown>): Promise<string | undefined> =>
  call.then(
    () => undefined,
    (error: unknown) => (error instanceof AdminError ? error.code : String((error as { code?: unknown }).code)),
  );

// Every row the rulings write, counted.
const written = async (store: RulingStore): Promise<{ decisions: number; rulings: number }> => ({
  decisions: await countOf(store.db, "knowledge.owner_decisions"),
  rulings: await countOf(store.db, "knowledge.belief_rulings"),
});

// One fact key, `fact-rota`, with a claim of each compartment: the work item's, and the personal
// item's; and another fact key, `fact-lamp`, of the personal item.
async function seeded(store: RulingStore) {
  const { pipeline, writer, accounts, owner } = store;
  const own = await stored(writer, accounts.personalMail, MAIL.canary);
  const work = await stored(writer, accounts.workMail, MAIL.workCanary);
  const ownPerson = await personOf(store, CANARY_PERSON.address, "own");
  const workPerson = await personOf(store, CANARY_PERSON.address, "employer:example");
  const ownClaim = commitment(own, "own", owner, ownPerson, { factKey: "fact-rota" });
  const lamp = commitment(own, "own", owner, ownPerson, { n: 2, factKey: "fact-lamp" });
  const workClaim = commitment(work, "employer:example", owner, workPerson, { factKey: "fact-rota" });
  expect(await pipeline.commit(batchOf(own, [ownClaim, lamp]))).toBe("committed");
  expect(await pipeline.commit(batchOf(work, [workClaim]))).toBe("committed");
  return { own, work, ownClaim, lamp, workClaim };
}

describe("the owner's rulings", { timeout: TIMEOUT }, () => {
  it("a reject takes its claim out of the fact key's belief for each clearance that sees it, at once, and leaves another clearance's belief", () =>
    withRulings(async (store) => {
      const { ownClaim, workClaim, lamp } = await seeded(store);
      const own = await beliefUnder(store, OWN, "fact-rota");
      const lampBefore = await beliefUnder(store, OWN, "fact-lamp");
      expect(own?.support).toEqual([ownClaim.claim.id]);
      expect(lampBefore?.support).toEqual([lamp.claim.id]);
      expect((await beliefUnder(store, WORK, "fact-rota"))?.support).toEqual([workClaim.claim.id]);

      const ruling = await store.admin.facts.rejectClaim(factIdOf(store, workClaim), {
        requestId: "request-rul-r6-000001",
      });
      expect(ruling).toMatch(/^rul_[0-9A-HJKMNP-TV-Z]{26}$/);
      // The work clearance's belief of the fact key rested on the rejected claim alone, and is gone;
      // the own clearance's belief of it, which no work claim reached, and the other fact key's
      // belief are as they were.
      expect(await beliefUnder(store, WORK, "fact-rota")).toBeNull();
      expect(await beliefUnder(store, OWN, "fact-rota")).toEqual(own);
      expect(await beliefUnder(store, OWN, "fact-lamp")).toEqual(lampBefore);

      // One decision and one ruling row.
      expect(
        await rowsOf(
          store.db,
          "select kind, target_kind, details, compartments, supersedes from knowledge.owner_decisions",
        ),
      ).toEqual([
        {
          kind: "correction",
          target_kind: null,
          details: { claim: factIdOf(store, workClaim) },
          compartments: WORK,
          supersedes: null,
        },
      ]);
      const [row] = await rowsOf<Record<string, unknown>>(
        store.db,
        "select verdict, claim_fp, source_account_id, source_item_fp, fact_key_fp, compartments, lifted_at from knowledge.belief_rulings",
      );
      expect(row).toMatchObject({
        verdict: "reject",
        claim_fp: factIdOf(store, workClaim),
        source_account_id: store.accounts.workMail.id,
        fact_key_fp: factKeyFpOf(store, "fact-rota"),
        compartments: WORK,
        lifted_at: null,
      });
      expect(row?.source_item_fp).toMatch(/^[0-9a-f]{64}$/);
    }));

  it("a veto's compartments are those of every claim of its fact key, and a clearance that holds one of them alone does not read it", () =>
    withRulings(async (store) => {
      const { ownClaim } = await seeded(store);
      const before = await beliefUnder(store, OWN, "fact-rota");
      expect(before?.status).toBe("active");
      const ruling = await store.admin.facts.vetoFact(factIdOf(store, ownClaim), {
        requestId: "request-rul-veto-00001",
      });
      expect(await rowsOf(store.db, "select kind, details, compartments from knowledge.owner_decisions")).toEqual([
        { kind: "fact_veto", details: { factKey: factKeyFpOf(store, "fact-rota") }, compartments: BOTH },
      ]);
      expect(
        await rowsOf(
          store.db,
          "select ruling_id, verdict, source_account_id, source_item_fp, compartments from knowledge.belief_rulings",
        ),
      ).toEqual([
        { ruling_id: ruling, verdict: "veto", source_account_id: null, source_item_fp: null, compartments: BOTH },
      ]);
      // A clearance that holds one compartment alone does not read the veto, and its belief is as it
      // was.
      expect(await beliefUnder(store, OWN, "fact-rota")).toEqual(before);
      expect((await beliefUnder(store, WORK, "fact-rota"))?.status).toBe("active");
    }));

  it("a second reject of one claim is already_ruled and writes nothing", () =>
    withRulings(async (store) => {
      const { ownClaim, workClaim } = await seeded(store);
      await store.admin.facts.rejectClaim(factIdOf(store, ownClaim), { requestId: "request-rul-r7-000001" });
      const after = await written(store);
      expect(
        await codeOf(store.admin.facts.rejectClaim(factIdOf(store, ownClaim), { requestId: "request-rul-r7-000002" })),
      ).toBe("already_ruled");
      expect(await written(store)).toEqual(after);
      // A veto of the same fact key is another verdict, and a second veto is refused alike.
      await store.admin.facts.vetoFact(factIdOf(store, ownClaim), { requestId: "request-rul-r7-000003" });
      expect(
        await codeOf(store.admin.facts.vetoFact(factIdOf(store, workClaim), { requestId: "request-rul-r7-000004" })),
      ).toBe("already_ruled");
      // The control: a reject of the other item's claim of the fact key is its own ruling.
      await store.admin.facts.rejectClaim(factIdOf(store, workClaim), { requestId: "request-rul-r7-000005" });
      expect(await written(store)).toEqual({ decisions: after.decisions + 2, rulings: after.rulings + 2 });
    }));

  it("a repeated request id returns the first ruling", () =>
    withRulings(async (store) => {
      const { ownClaim, workClaim } = await seeded(store);
      const first = await store.admin.facts.rejectClaim(factIdOf(store, ownClaim), {
        requestId: "request-rul-repeat-01",
      });
      const after = await written(store);
      expect(
        await store.admin.facts.rejectClaim(factIdOf(store, ownClaim), { requestId: "request-rul-repeat-01" }),
      ).toBe(first);
      expect(await written(store)).toEqual(after);
      // A request id of another kind of decision is refused, and writes nothing.
      expect(
        await codeOf(store.admin.facts.vetoFact(factIdOf(store, workClaim), { requestId: "request-rul-repeat-01" })),
      ).toBe("invalid_argument");
      expect(await written(store)).toEqual(after);
    }));

  it("a receipt is no_belief, and an unknown id not_found", () =>
    withRulings(async (store) => {
      const { pipeline, writer, accounts, owner } = store;
      const evidenceId = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const receipt = commitment(evidenceId, "own", owner, await personOf(store, QUENTIN.address, "own"), {
        factKey: "fact-receipt",
        type: "transaction.receipt",
      });
      expect(await pipeline.commit(batchOf(evidenceId, [receipt]))).toBe("committed");
      for (const call of [store.admin.facts.rejectClaim, store.admin.facts.vetoFact]) {
        expect(
          await codeOf(
            call.call(store.admin.facts, factIdOf(store, receipt), { requestId: `request-rul-r8-${call.name}` }),
          ),
        ).toBe("no_belief");
        expect(
          await codeOf(
            call.call(store.admin.facts, "e".repeat(64) as never, { requestId: `request-rul-r8u-${call.name}` }),
          ),
        ).toBe("not_found");
      }
      expect(await written(store)).toEqual({ decisions: 0, rulings: 0 });
      // The control: a commitment is ruled on.
      const { ownClaim } = await seeded(store);
      await store.admin.facts.rejectClaim(factIdOf(store, ownClaim), { requestId: "request-rul-r8-control" });
      expect(await written(store)).toEqual({ decisions: 1, rulings: 1 });
    }));

  it("a lift supersedes the ruling's decision and writes one row; lifting twice writes one row", () =>
    withRulings(async (store) => {
      const { workClaim } = await seeded(store);
      const ruling = await store.admin.facts.rejectClaim(factIdOf(store, workClaim), {
        requestId: "request-rul-lift-0001",
      });
      expect(await beliefUnder(store, WORK, "fact-rota")).toBeNull();
      expect(await store.admin.facts.liftRuling(ruling, { requestId: "request-rul-lift-0002" })).toBe(true);
      const lifts = await rowsOf<{
        id: string;
        kind: string;
        supersedes: string;
        details: unknown;
        compartments: string[];
      }>(
        store.db,
        "select id, kind, supersedes, details, compartments from knowledge.owner_decisions where supersedes is not null",
      );
      expect(lifts).toEqual([
        { id: lifts[0]?.id, kind: "correction_lift", supersedes: ruling, details: {}, compartments: WORK },
      ]);
      expect(
        await rowsOf(store.db, "select lift_ruling_id, lifted_at is not null as lifted from knowledge.belief_rulings"),
      ).toEqual([{ lift_ruling_id: lifts[0]?.id, lifted: true }]);
      // The lift gives the claim back to the belief its clearance is given, at once.
      expect((await beliefUnder(store, WORK, "fact-rota"))?.support).toEqual([workClaim.claim.id]);

      // The same request again is the first answer; another lift of it is false. One row each time.
      expect(await store.admin.facts.liftRuling(ruling, { requestId: "request-rul-lift-0002" })).toBe(true);
      expect(await store.admin.facts.liftRuling(ruling, { requestId: "request-rul-lift-0003" })).toBe(false);
      expect(await written(store)).toEqual({ decisions: 2, rulings: 1 });
      // An id that is no ruling is false.
      expect(
        await store.admin.facts.liftRuling("rul_01JABCDEFGHJKMNPQRSTVWXYZ0" as never, {
          requestId: "request-rul-lift-0004",
        }),
      ).toBe(false);
      // A lifted reject no longer refuses a new one.
      await store.admin.facts.rejectClaim(factIdOf(store, workClaim), { requestId: "request-rul-lift-0005" });
      expect(await written(store)).toEqual({ decisions: 3, rulings: 2 });
    }));

  it("listRulings lists every ruling oldest first, by ids, verdicts and times", () =>
    withRulings(async (store) => {
      const { ownClaim, workClaim } = await seeded(store);
      const reject = await store.admin.facts.rejectClaim(factIdOf(store, workClaim), {
        requestId: "request-rul-list-0001",
      });
      const veto = await store.admin.facts.vetoFact(factIdOf(store, ownClaim), { requestId: "request-rul-list-0002" });
      await store.admin.facts.liftRuling(reject, { requestId: "request-rul-list-0003" });
      const listed = await store.admin.facts.listRulings();
      expect(
        listed.map(({ id, verdict, claim, factKey, claimGone }) => ({ id, verdict, claim, factKey, claimGone })),
      ).toEqual([
        {
          id: reject,
          verdict: "reject",
          claim: factIdOf(store, workClaim),
          factKey: factKeyFpOf(store, "fact-rota"),
          claimGone: false,
        },
        {
          id: veto,
          verdict: "veto",
          claim: factIdOf(store, ownClaim),
          factKey: factKeyFpOf(store, "fact-rota"),
          claimGone: false,
        },
      ]);
      expect(listed[0]?.liftedAt).not.toBeNull();
      expect(listed[1]?.liftedAt).toBeNull();
    }));

  it("a ruling whose claim was deleted is listed with claimGone and is not deleted", () =>
    withRulings(async (store) => {
      const { work, workClaim, ownClaim } = await seeded(store);
      const reject = await store.admin.facts.rejectClaim(factIdOf(store, workClaim), {
        requestId: "request-rul-r9-000001",
      });
      const veto = await store.admin.facts.vetoFact(factIdOf(store, ownClaim), { requestId: "request-rul-r9-000002" });
      // The work item is deleted at the source, and its claim with it.
      const deletion = {
        sourceAccount: store.accounts.workMail.id,
        sourceItemId: mailSourceId(MAIL.workCanary),
      } as SourceDeletion;
      await store.writer.applyDeletion(store.accounts.workMail, deletion);
      expect(await countOf(store.db, "knowledge.claims", "evidence_id = $1", [work])).toBe(0);
      const listed = await store.admin.facts.listRulings();
      // The reject names no stored claim; the veto's fact key still has the personal claim.
      expect(listed.map(({ id, claimGone }) => ({ id, claimGone }))).toEqual([
        { id: reject, claimGone: true },
        { id: veto, claimGone: false },
      ]);
      expect(await countOf(store.db, "knowledge.belief_rulings")).toBe(2);
    }));

  it("no role but the admin writes a ruling", () =>
    withRulings(async (store) => {
      const { ownClaim } = await seeded(store);
      const values = [
        "rul_01JABCDEFGHJKMNPQRSTVWXYZ0",
        "veto",
        factIdOf(store, ownClaim),
        factKeyFpOf(store, "fact-rota"),
      ];
      const insert =
        "insert into knowledge.belief_rulings (ruling_id, verdict, claim_fp, fact_key_fp, created_at, compartments) values ($1, $2, $3, $4, now(), '{own}')";
      for (const url of [store.db.urls.writer, store.db.urls.reader, store.db.urls.pipeline]) {
        expect(await sqlState(() => queryAs(url, insert, values)), url).toBe("42501");
        expect(await sqlState(() => queryAs(url, "update knowledge.belief_rulings set lifted_at = now()")), url).toBe(
          "42501",
        );
      }
      // The control: the admin writes one through its method.
      await store.admin.facts.vetoFact(factIdOf(store, ownClaim), { requestId: "request-rul-roles-0001" });
      expect(await countOf(store.db, "knowledge.belief_rulings")).toBe(1);
    }));
});
