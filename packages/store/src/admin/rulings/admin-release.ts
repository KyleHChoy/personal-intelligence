import { createHash } from "node:crypto";
import { type PersonalCompartment, type RulingId, releasableLabel } from "@intelligence/contracts/personal";
import type { StoredCard } from "../../cards/card-kind-row.ts";
import { claimOf } from "../../cards/card-kinds-claims.ts";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { appendJournal } from "../../core/journal.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { insertRelease, vetoedRecord } from "../../core/release.ts";
import { removeReleased } from "../../write/writer-derived.ts";
import { syncLock } from "../admin-base.ts";
import { journalOf, nextSeq } from "../erasure/admin-erase.ts";

// The owner's releases that are not a card's effect. `pia facts release` releases what the owner
// confirmed, or answered, before a confirm released anything; `pi correct lift` on a confirm lifts
// that confirmation and ends its release. Each in the admin's one transaction, as pi_admin, the
// owner's role: no agent API path reaches either. Counts and ids only.

// The about_you confirms in force: a confirm answer of a system:extract card, neither tainted nor
// superseded, as policy.confirmed_claims reads them. Never one an agent relayed: it releases
// nothing, and knowledge.claim_releases_check refuses a release resting on it.
const CONFIRMS = `
  select o.id as ruling_id, c.target_kind, c.target_id, c.request_id, c.compartments
  from ledger.cards c join knowledge.owner_decisions o on o.card_id = c.id
  where c.kind = 'about_you' and c.created_by = 'system:extract'
    and o.kind = 'answer' and o.answer = 'confirm' and o.tainted_at is null
    and not exists (select 1 from knowledge.owner_decisions s where s.supersedes = o.id)
    and not exists (select 1 from ledger.card_relays y where y.ruling_id = o.id)
  order by o.decided_at, o.id collate "C"`;

// The owner's answers in force: each owner_answer decision with its record's evidence row, the
// record not emptied nor flagged.
const ANSWERS = `
  select o.id as ruling_id, w.evidence_id, w.compartments
  from knowledge.owner_decisions o join ledger.agent_writes w on w.id = o.request_id
  where o.kind = 'owner_answer' and o.tainted_at is null
    and not exists (select 1 from knowledge.owner_decisions s where s.supersedes = o.id)
    and w.evidence_id is not null and w.body_enc is not null and w.flagged_at is null
  order by o.decided_at, o.id collate "C"`;

// A release in force, as the pipeline reads it; and a ruling whose release's lift
// is journalled (a restore can bring back the confirm the lift superseded, never the lift's line).
const IN_FORCE = "select 1 from policy.released_records() where evidence_id = $1";
const LIFTED = "select 1 from knowledge.release_lifts where ruling_id = $1";

// What `pia facts release` found and did: confirmed proposals and answers it looked at, those it
// released (or would, with dryRun), those already released, those whose record's label may not
// narrow to `own` or whose claim is gone, those whose belief the owner vetoed or retired
// (invariant 11), and those whose release the owner lifted.
// `records`, the evidence ids it released or would, one release a record, and `plan`, the SHA-256
// of its (record, ruling) pairs sorted (the ruling too, so a list whose decision changed is
// another plan): a release takes the dry run's plan, computes its own in its
// transaction, and refuses `plan_changed` when they differ, so it releases exactly what the owner read.
type ReleaseReport = {
  dryRun: boolean;
  plan: string;
  proposals: number;
  answers: number;
  released: number;
  already: number;
  notReleasable: number;
  vetoed: number;
  lifted: number;
  records: string[];
};

export const planOf = (releasing: readonly { evidenceId: string; ruling: string }[]): string =>
  createHash("sha256")
    .update(
      releasing
        .map((one) => `${one.evidenceId}\t${one.ruling}`)
        .sort()
        .join("\n"),
      "utf8",
    )
    .digest("hex");

export async function releaseConfirmed(
  admin: AdminContext,
  options: { dryRun: boolean; plan?: string },
): Promise<ReleaseReport> {
  if (!options.dryRun && options.plan === undefined) throw new AdminError("invalid_argument");
  const now = admin.now();
  return admin.transaction(async (query) => {
    const report: ReleaseReport = {
      dryRun: options.dryRun,
      plan: "",
      proposals: 0,
      answers: 0,
      released: 0,
      already: 0,
      notReleasable: 0,
      vetoed: 0,
      lifted: 0,
      records: [],
    };
    const candidates: { ruling: string; evidenceId: string | null; compartments: string[] }[] = [];
    for (const row of await query<{
      ruling_id: string;
      target_kind: string | null;
      target_id: string | null;
      request_id: string;
      compartments: string[];
    }>(CONFIRMS)) {
      const card = {
        target:
          row.target_kind === null ? null : ({ kind: row.target_kind, id: row.target_id } as StoredCard["target"]),
        compartments: row.compartments,
        requestId: row.request_id,
      };
      const found = await claimOf(card, { query, keys: admin.keys });
      // A question of the owner's own is from their mail: nothing to release.
      if (typeof found !== "string" && found.record.origin !== "agent_record") continue;
      report.proposals += 1;
      candidates.push({
        ruling: row.ruling_id,
        evidenceId: typeof found === "string" ? null : found.evidenceId,
        compartments: row.compartments,
      });
    }
    for (const row of await query<{ ruling_id: string; evidence_id: string; compartments: string[] }>(ANSWERS)) {
      report.answers += 1;
      candidates.push({ ruling: row.ruling_id, evidenceId: row.evidence_id, compartments: row.compartments });
    }
    const releasing: { ruling: string; evidenceId: string }[] = [];
    for (const one of candidates) {
      if (one.evidenceId === null || !releasableLabel(one.compartments)) report.notReleasable += 1;
      else if ((await query(LIFTED, [one.ruling])).length > 0) report.lifted += 1;
      else if (await vetoedRecord(query, one.evidenceId)) report.vetoed += 1;
      else if ((await query(IN_FORCE, [one.evidenceId])).length > 0) report.already += 1;
      // One release a record, by its first decision in the order read.
      else if (releasing.some((other) => other.evidenceId === one.evidenceId)) report.already += 1;
      else releasing.push({ ruling: one.ruling, evidenceId: one.evidenceId });
    }
    report.records = releasing.map((one) => one.evidenceId);
    report.plan = planOf(releasing);
    if (options.dryRun) {
      report.released = releasing.length;
      return report;
    }
    if (options.plan !== report.plan) throw new AdminError("plan_changed");
    for (const one of releasing) {
      if (await insertRelease(query, { ...one, via: "command", now })) report.released += 1;
      else report.already += 1;
    }
    return report;
  });
}

// `pi correct lift` on an about_you confirm: a confirmation_lift decision that supersedes it, so
// policy.confirmed_claims no longer answers for its claim; the release it made, if any, lifted; and
// the released claims of its record removed now, with every belief resting on them. Inside
// liftRuling's transaction, after the beliefs lock. False for an id that is no confirm of an
// about_you card in force. So deletion sticks (invariant 10), a lift of a release is journalled,
// its line on disk before the transaction commits, under the sync lock as an erasure's is.
export async function liftConfirmation(
  admin: AdminContext,
  query: Query,
  id: RulingId,
  options: { requestId: string; now: Date },
): Promise<boolean> {
  const [confirm] = await query<{ compartments: PersonalCompartment[] }>(
    `select o.compartments from knowledge.owner_decisions o join ledger.cards c on c.id = o.card_id
     where o.id = $1 and c.kind = 'about_you' and c.created_by = 'system:extract' and o.kind = 'answer' and o.answer = 'confirm' and o.tainted_at is null
       and not exists (select 1 from knowledge.owner_decisions s where s.supersedes = o.id)`,
    [id],
  );
  if (confirm === undefined) return false;
  const lift = await ownerDecision(
    query,
    { requestId: options.requestId, kind: "confirmation_lift", supersedes: id, compartments: confirm.compartments },
    options.now,
  );
  const lifted = await query<{ evidence_id: string }>(
    "update knowledge.claim_releases set lifted_at = $2, lift_ruling_id = $3 where ruling_id = $1 and lifted_at is null returning evidence_id",
    [id, stamp(options.now), lift],
  );
  if (lifted.length > 0) {
    const journal = journalOf(admin);
    await syncLock(query);
    const seq = await nextSeq(query, journal);
    await query("insert into knowledge.release_lifts (seq, ruling_id, compartments) values ($1, $2, array['own'])", [
      seq,
      id,
    ]);
    await appendJournal(journal, { seq, releaseLift: id });
  }
  for (const { evidence_id } of lifted) await removeReleased(query, evidence_id);
  return true;
}
