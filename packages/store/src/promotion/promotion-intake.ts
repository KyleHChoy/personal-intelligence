// The promotion intake a receiving instance runs: it stands in for a team's deployment. It takes
// one message, a bundle or a deletion notice, and nothing that is not exactly one. A bundle's claims
// are labelled with the compartment and readers this instance's owner names, and given ids this
// instance mints; a notice removes everything its promotion gave, and that promotion is never taken
// again. The bundle's text is untrusted data: sealed, served as untrusted, never followed. As
// pi_admin, from the receiving owner's command; the reader serves the claims under a client's token.

import {
  isRestricted,
  type PromotedFactView,
  type PromotionIntakeReport,
  PromotionMessage,
} from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import type { AdminContext } from "../core/admin-context.ts";
import { AdminError } from "../core/admin-error.ts";
import { stamp } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { type Sealed, sealUnder } from "../core/seal.ts";
import { servedJson } from "../core/served.ts";
import type { Reader } from "../read/read.ts";

const TABLE = "knowledge.promoted_claims";

// `pia promotion take [--compartment C] < MESSAGE`: one message, in one transaction.
// `invalid_promotion` for anything that does not parse as exactly a bundle or a notice;
// `unknown_compartment` for a destination this instance holds no key for, or a restricted one.
export function take(
  admin: AdminContext,
  message: unknown,
  options: { compartment?: string } = {},
): Promise<PromotionIntakeReport> {
  const parsed = PromotionMessage.safeParse(message);
  if (!parsed.success) return Promise.reject(new AdminError("invalid_promotion"));
  const compartment = options.compartment ?? "own";
  if (!admin.keys.compartments.has(compartment) || isRestricted(compartment))
    return Promise.reject(new AdminError("unknown_compartment"));
  const one = parsed.data;
  const now = stamp(admin.now());
  return admin.transaction(async (query) => {
    if (one.kind === "promotion_deletion") {
      // Recorded before anything is removed, so a bundle that arrives later is never taken.
      await query(
        `insert into ledger.promotions as p (id, direction, provenance, claim_ids, created_at, revoked_at, compartments)
         values ($1, 'in', $2, '{}', $3, $3, $4)
         on conflict (direction, provenance) do update set revoked_at = coalesce(p.revoked_at, excluded.revoked_at)`,
        [newId("prm"), one.provenance, now, [compartment]],
      );
      const removed = await query(`delete from ${TABLE} where provenance = $1 returning id`, [one.provenance]);
      admin.log.info({ event: "promotion_removed", counts: { claims: removed.length } });
      return { code: "removed", claims: removed.length };
    }
    const [taken] = await query<{ id: string }>(
      `insert into ledger.promotions (id, direction, provenance, claim_ids, created_at, compartments)
       values ($1, 'in', $2, '{}', $3, $4) on conflict (direction, provenance) do nothing returning id`,
      [newId("prm"), one.provenance, now, [compartment]],
    );
    if (taken === undefined) {
      const [first] = await query<{ revoked: boolean }>(
        "select revoked_at is not null as revoked from ledger.promotions where direction = 'in' and provenance = $1",
        [one.provenance],
      );
      return { code: first?.revoked === true ? "revoked" : "already", claims: 0 };
    }
    // This instance's own ids: one entity id for each subject the promotion names, and a claim id
    // keyed by this instance's fingerprint key.
    const subjects = new Map<string, string>();
    for (const claim of one.claims) {
      const subject = subjects.get(claim.subject.ref) ?? newId("ent");
      subjects.set(claim.subject.ref, subject);
      const id = fingerprint(admin.keys, "promotion", `${one.provenance}\n${claim.ref}`);
      await query(
        `insert into ${TABLE} (id, provenance, ref, type, subject_id, subject_kind, valid_from, received_at, content_enc, readers, compartments)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          one.provenance,
          claim.ref,
          claim.kind,
          subject,
          claim.subject.kind,
          claim.validFrom,
          now,
          sealUnder(
            admin.keys,
            [compartment],
            { table: TABLE, id, column: "content_enc" },
            JSON.stringify({ statement: claim.statement }),
          ),
          [THE_OWNER],
          [compartment],
        ],
      );
    }
    admin.log.info({ event: "promotion_taken", counts: { claims: one.claims.length } });
    return { code: "taken", claims: one.claims.length };
  });
}

// The promoted claims a client may see, newest first, then by id, at most `limit`, and whether more
// are visible: one statement under the client's token, so only rows within its clearance are read,
// counted or ordered. Null for no client (an empty, unknown or revoked token).
const PROMOTED = `
  select p.id, p.type, p.subject_id, p.subject_kind, p.valid_from, p.content_enc, p.compartments
  from knowledge.promoted_claims p
  order by p.valid_from desc, p.id collate "C"
  limit $1`;

type PromotedRow = {
  id: string;
  type: string;
  subject_id: string;
  subject_kind: PromotedFactView["subject"]["kind"];
  valid_from: Date;
  content_enc: Sealed;
  compartments: string[];
};

export function promotedFacts(
  reader: Reader,
  token: string,
  limit = 20,
): Promise<{ facts: PromotedFactView[]; more: boolean } | null> {
  return reader.withClient(token, { isolation: "repeatable read" }, async ({ client, run, ctx }) => {
    if (client === null) return null;
    const rows = await run<PromotedRow>(PROMOTED, [limit + 1]);
    const facts = rows.slice(0, limit).map((row): PromotedFactView => {
      const { statement } = servedJson(ctx(client), row, "knowledge.promoted_claims.content_enc") as {
        statement: Record<string, string | number | boolean>;
      };
      return {
        id: row.id,
        kind: row.type,
        subject: { id: row.subject_id, kind: row.subject_kind },
        statement: Object.fromEntries(
          Object.entries(statement).map(([field, value]) => [
            field,
            typeof value === "string" ? { untrusted: value } : value,
          ]),
        ),
        validFrom: stamp(row.valid_from),
      };
    });
    return { facts, more: rows.length > limit };
  });
}
