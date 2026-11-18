import type { FactId, PersonalCompartment, RulingId } from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { revokeRuled } from "../../core/promotion-revoke.ts";
import type { Sealed } from "../../core/seal.ts";
import { sealUnder } from "../../core/seal.ts";
import { openedUnder } from "../../core/tx.ts";
import { named, ruledItems, standing, type Verdict } from "./admin-rulings.ts";
import { carryShown, withinLabel } from "./ruling-anchors.ts";

// A ruling of the owner's re-attached by code to `claim`, the one claim that replaced the claim it
// named at a generation raise, in the caller's transaction, which holds the beliefs lock and the
// shared taint lock. Written as `ruleIn` writes a ruling of its verdict, with three differences:
// its decision is a `ruling_carry`, never one of the owner's (its details name the ruling it
// carries); its request id is the carried ruling's, so a second run writes nothing; and it keeps
// the carried ruling's time, which a retire is compared with. The carried ruling stays as it is. A
// domain or a kind carries its value, sealed again under the new ruling's label; `label` when that
// label lacks a compartment the carried ruling's held, since the value would then be under less
// (what the owner was shown is carried as it was, marked: ruling-anchors.ts, `carryShown`)
// than it was ruled under (invariant 4). `already_ruled` when a ruling of its verdict is in force
// on the claim already (the owner ruled on it again themselves). Either way nothing is written.
export async function carryIn(
  admin: AdminContext,
  query: Query,
  ruling: { id: RulingId; verdict: Verdict; createdAt: Date },
  claim: FactId,
): Promise<"carried" | "already_ruled" | "label"> {
  const target = await named(query, claim, ruling.verdict);
  if (target === undefined) throw new AdminError("not_found");
  if ((await standing(query, ruling.verdict, target)) !== undefined) return "already_ruled";
  const reclassify = ruling.verdict === "domain" || ruling.verdict === "kind";
  let value: string | undefined;
  if (reclassify) {
    const [from] = await query<{ compartments: PersonalCompartment[]; value_enc: Sealed }>(
      "select compartments, value_enc from knowledge.belief_rulings where ruling_id = $1",
      [ruling.id],
    );
    if (from === undefined) throw new AdminError("not_found");
    if (!withinLabel(from.compartments, target.compartments)) return "label";
    value = openedUnder(
      admin.keys,
      from.compartments,
      { table: "knowledge.belief_rulings", id: ruling.id, column: "value_enc" },
      from.value_enc,
    );
  }
  const carry = await ownerDecision(
    query,
    {
      requestId: `carry-${ruling.id}`,
      kind: "ruling_carry",
      details: { from: ruling.id, claim },
      compartments: target.compartments,
    },
    admin.now(),
  );
  const reject = ruling.verdict === "reject";
  const items =
    ruling.verdict === "veto" || ruling.verdict === "retire"
      ? await ruledItems(admin, query, target.fact_key_fp)
      : undefined;
  await query(
    `insert into knowledge.belief_rulings (ruling_id, verdict, claim_fp, source_account_id, source_item_fp, fact_key_fp, created_at, compartments, value_enc, item_account_ids, item_fps)
     values ($1, $2, $3, $4, $5, $6, $7, ledger.label($8), $9, $10, $11)`,
    [
      carry,
      ruling.verdict,
      claim,
      reject ? target.source_account_id : null,
      reject ? target.source_item_fp : null,
      target.fact_key_fp,
      stamp(ruling.createdAt),
      target.compartments,
      value === undefined
        ? null
        : sealUnder(
            admin.keys,
            target.compartments,
            { table: "knowledge.belief_rulings", id: carry, column: "value_enc" },
            value,
          ),
      items?.map((one) => one.source_account_id) ?? null,
      items?.map((one) => one.source_item_fp) ?? null,
    ],
  );
  // A carried veto or retire revokes each promotion in force that carries a claim of the key.
  if (ruling.verdict === "veto" || ruling.verdict === "retire")
    await revokeRuled(query, target.fact_key_fp, admin.now());
  await carryShown(admin, query, carry, ruling.id);
  return "carried";
}
