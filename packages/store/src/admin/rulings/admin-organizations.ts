import type { EntityId, RulingId } from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { byText, stamp } from "../../core/db.ts";
import { newId } from "../../core/ids.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { sealUnder } from "../../core/seal.ts";
import { lockedRepeat, OWNER_NAME, RULING_LOCKS } from "./owner-ruling.ts";

// The owner's name for an organization: `pi org name ORG NAME`, one owner decision and one
// knowledge.organization_names row for each domain fingerprint the organization holds, sealed under
// the union of its domain rows' compartments. A name is kept by domain, not by entity, so it
// outlives a re-derive. A new name lifts the one in force.

export async function nameOrganization(
  admin: AdminContext,
  organization: EntityId,
  name: string,
  options: { requestId: string },
): Promise<RulingId> {
  const named = name.trim();
  if (!OWNER_NAME.test(named)) throw new AdminError("invalid_argument");
  const now = admin.now();
  return admin.transaction(async (query) => {
    const repeat = await lockedRepeat(query, RULING_LOCKS.organizationNames, options.requestId);
    if (repeat !== undefined) return repeat;
    // An id that names no organization, or one with no domain row, is `not_found`, as for a veto.
    const domains = await query<{ domain_fp: string; compartments: string[] }>(
      `select d.domain_fp, d.compartments from knowledge.domains d
       join knowledge.entities e on e.id = d.entity_id and e.kind = 'organization' where d.entity_id = $1 order by d.id`,
      [organization],
    );
    if (domains.length === 0) throw new AdminError("not_found");
    const compartments = [...new Set(domains.flatMap((row) => row.compartments))].sort(byText);
    const ruling = await ownerDecision(
      query,
      {
        requestId: options.requestId,
        kind: "organization_name",
        target: { kind: "entity", id: organization },
        compartments,
      },
      now,
    );
    for (const domainFp of [...new Set(domains.map((row) => row.domain_fp))].sort(byText)) {
      await query(
        "update knowledge.organization_names set lifted_at = $2, lift_ruling_id = $3 where domain_fp = $1 and lifted_at is null",
        [domainFp, stamp(now), ruling],
      );
      const id = newId("onm");
      await query(
        "insert into knowledge.organization_names (id, ruling_id, domain_fp, name_enc, created_at, compartments) values ($1, $2, $3, $4, $5, $6)",
        [
          id,
          ruling,
          domainFp,
          sealUnder(admin.keys, compartments, { table: "knowledge.organization_names", id, column: "name_enc" }, named),
          stamp(now),
          compartments,
        ],
      );
    }
    return ruling;
  });
}
