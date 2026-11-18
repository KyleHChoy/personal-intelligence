import { ClaimRecord, type PersonalCompartment } from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import type { Query } from "../../core/db.ts";
import type { Sealed } from "../../core/seal.ts";
import { open, sealUnder } from "../../core/seal.ts";
import { openedUnder } from "../../core/tx.ts";

// A ruling's durable anchors: beside its fact key, which a model's reading made, a ruling keeps the
// type of the claim it was made on, the evidence rows of the claims its key named and the entities
// that claim names, all in clear and written by the database (`knowledge.anchor_rulings`), and what
// the owner was shown of the claim, sealed here under the ruling's label. Written once, when the
// ruling is made or by the sweep below; never changed after but by a deletion, which removes what
// went (`knowledge.forget_ruling_anchors`).

// What the owner was shown: the verdict and, for each claim ruled on, its type, its subject, its
// typed fields and the time it holds from, as the store held them when the ruling was anchored.
// `carriedFrom`: on a ruling code carried, the ruling it carries; `claims` are then still what the
// owner saw when the first ruling was made, never the claim it was carried to.
export type ShownClaim = { type: string; subject: string; fields: Record<string, unknown>; validFrom: string };
export type Shown = { version: 1; verdict: string; claims: ShownClaim[]; carriedFrom?: string };

// What was shown, from its opened text; undefined when it is no snapshot.
export function shownOf(text: string): Shown | undefined {
  try {
    const value = JSON.parse(text) as Shown;
    return value?.version === 1 && Array.isArray(value.claims) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function shownText(verdict: string, records: readonly ClaimRecord[]): string {
  const shown: Shown = {
    version: 1,
    verdict,
    claims: records.map(({ claim }) => ({
      type: claim.content.type,
      subject: claim.content.subject,
      fields: claim.content.fields,
      validFrom: claim.validFrom,
    })),
  };
  return JSON.stringify(shown);
}

// Invariant 4: what was shown takes the ruling's label, and is kept only when that label holds
// every compartment of each claim shown, so nothing is sealed under less than it was made from.
export const withinLabel = (claim: readonly string[], ruling: readonly string[]): boolean =>
  claim.every((one) => ruling.includes(one));

type RulingRow = {
  form: "belief" | "pair";
  verdict: string;
  compartments: PersonalCompartment[];
  anchored: boolean;
  shown: boolean;
  keys: string[];
  claim: string | null;
};
type ClaimRow = { id: string; compartments: PersonalCompartment[]; content_enc: Sealed };

const RULING = `
  select 'belief' as form, r.verdict, r.compartments, r.claim_type is not null as anchored, r.shown_enc is not null as shown,
    array[r.fact_key_fp] as keys, r.claim_fp as claim
  from knowledge.belief_rulings r where r.ruling_id = $1
  union all
  select 'pair', f.verdict, f.compartments, f.claim_type is not null, f.shown_enc is not null, array[f.a_fp, f.b_fp], null
  from knowledge.fact_rulings f where f.ruling_id = $1`;

// The claim shown for one key: the claim the ruling was made on when it is stored, else the first
// claim in id order the key names, as its own key or a version 1 key.
const SHOWN_CLAIM = `
  select c.id, c.compartments, c.content_enc from knowledge.claims c
  where c.fact_key_fp = $1 or c.legacy_fact_key_fp = $1 or c.legacy_alt_fact_key_fp = $1
  order by (c.id = $2) desc, c.id collate "C" limit 1`;

// One ruling's anchors, in the caller's transaction: the clear ones by the database, then what was
// shown, when every claim shown opens under the keys and lies within the ruling's label.
export async function anchorRuling(
  admin: Pick<AdminContext, "keys">,
  query: Query,
  ruling: string,
): Promise<{ anchored: boolean; shown: boolean }> {
  await query("select knowledge.anchor_rulings($1::text[])", [[ruling]]);
  const [row] = await query<RulingRow>(RULING, [ruling]);
  if (row === undefined || !row.anchored) return { anchored: false, shown: false };
  if (row.shown) return { anchored: true, shown: true };
  // A ruling code carried keeps what the owner saw (`carryShown`), never its new claim's words.
  const [carried] = await query("select 1 from knowledge.owner_decisions where id = $1 and kind = 'ruling_carry'", [
    ruling,
  ]);
  if (carried !== undefined) return { anchored: true, shown: false };
  const records: ClaimRecord[] = [];
  for (const key of row.keys) {
    const [claim] = await query<ClaimRow>(SHOWN_CLAIM, [key, row.claim]);
    if (
      claim === undefined ||
      !withinLabel(claim.compartments, row.compartments) ||
      claim.compartments.some((one) => !admin.keys.compartments.has(one))
    )
      return { anchored: true, shown: false };
    const record = ClaimRecord.safeParse(JSON.parse(open(admin.keys, claim, "knowledge.claims.content_enc", "throw")));
    if (!record.success) return { anchored: true, shown: false };
    records.push(record.data);
  }
  if (row.compartments.some((one) => !admin.keys.compartments.has(one))) return { anchored: true, shown: false };
  const text = shownText(row.verdict, records);
  const sealed =
    row.form === "belief"
      ? sealUnder(
          admin.keys,
          row.compartments,
          { table: "knowledge.belief_rulings", id: ruling, column: "shown_enc" },
          text,
        )
      : sealUnder(
          admin.keys,
          row.compartments,
          { table: "knowledge.fact_rulings", id: ruling, column: "shown_enc" },
          text,
        );
  const [written] = await query<{ shown: boolean }>("select knowledge.set_ruling_shown($1, $2::jsonb) as shown", [
    ruling,
    JSON.stringify(sealed),
  ]);
  return { anchored: true, shown: written?.shown === true };
}

// A carried ruling's anchors, in the caller's transaction: the clear ones by the database, and what
// was shown copied from the ruling it carries, the original snapshot marked `carriedFrom`, sealed
// again under the new ruling's label. Kept only when that label holds every compartment the first
// was sealed under (invariant 4); otherwise the carried ruling has none, and code never carries it
// again. `swap`: a pair whose two keys changed places.
export async function carryShown(
  admin: Pick<AdminContext, "keys">,
  query: Query,
  carry: string,
  from: string,
  swap = false,
): Promise<void> {
  await query("select knowledge.anchor_rulings($1::text[])", [[carry]]);
  const rows = await query<{
    id: string;
    form: "belief" | "pair";
    compartments: PersonalCompartment[];
    shown_enc: Sealed;
  }>(
    `select r.ruling_id as id, 'belief' as form, r.compartments, r.shown_enc from knowledge.belief_rulings r where r.ruling_id = any ($1::text[])
     union all
     select f.ruling_id, 'pair', f.compartments, f.shown_enc from knowledge.fact_rulings f where f.ruling_id = any ($1::text[])`,
    [[carry, from]],
  );
  const [first, next] = [rows.find((row) => row.id === from), rows.find((row) => row.id === carry)];
  if (first === undefined || next === undefined || first.shown_enc === null || next.shown_enc !== null) return;
  if (!withinLabel(first.compartments, next.compartments)) return;
  if ([...first.compartments, ...next.compartments].some((one) => !admin.keys.compartments.has(one))) return;
  const table = first.form === "belief" ? "knowledge.belief_rulings" : "knowledge.fact_rulings";
  const shown = shownOf(
    openedUnder(admin.keys, first.compartments, { table, id: from, column: "shown_enc" }, first.shown_enc),
  );
  if (shown === undefined) return;
  const text = JSON.stringify({
    ...shown,
    claims: swap ? [...shown.claims].reverse() : shown.claims,
    carriedFrom: shown.carriedFrom ?? from,
  } satisfies Shown);
  await query("select knowledge.set_ruling_shown($1, $2::jsonb)", [
    carry,
    JSON.stringify(sealUnder(admin.keys, next.compartments, { table, id: carry, column: "shown_enc" }, text)),
  ]);
}

// `pia extract carry-over --anchor`: every ruling in force that lacks an anchor or what was shown,
// each in its own transaction. `unanchored` counts those whose key names no stored claim: nothing
// says what they were made on, and they stay as they are. Counts only.
export type AnchorReport = { checked: number; anchored: number; shown: number; unanchored: number };

export async function anchorRulings(admin: AdminContext): Promise<AnchorReport> {
  const rulings = await admin.transaction((query) =>
    query<{ id: string; anchored: boolean }>(
      `select r.ruling_id as id, r.claim_type is not null as anchored from knowledge.belief_rulings r
       where r.lifted_at is null and (r.claim_type is null or (r.shown_enc is null and cardinality(r.evidence_ids) > 0))
       union all
       select f.ruling_id, f.claim_type is not null from knowledge.fact_rulings f
       where f.lifted_at is null
         and (f.claim_type is null or (f.shown_enc is null and cardinality(f.a_evidence_ids) > 0 and cardinality(f.b_evidence_ids) > 0))
       order by 1`,
    ),
  );
  const report: AnchorReport = { checked: rulings.length, anchored: 0, shown: 0, unanchored: 0 };
  for (const { id, anchored } of rulings) {
    const one = await admin.transaction((query) => anchorRuling(admin, query, id));
    if (one.anchored && !anchored) report.anchored += 1;
    if (one.shown) report.shown += 1;
    if (!one.anchored) report.unanchored += 1;
  }
  admin.log.info({
    event: "rulings_anchored",
    counts: {
      checked: report.checked,
      anchored: report.anchored,
      shown: report.shown,
      unanchored: report.unanchored,
    },
  });
  return report;
}
