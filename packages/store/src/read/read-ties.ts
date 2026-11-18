import { Timestamp } from "@intelligence/contracts";
import {
  AgentRecordId,
  ClaimRecord,
  type Closeness,
  CONNECTION_TYPE,
  ConnectionKind,
  type ConnectionView,
  EntityId,
  OWNER_TIE_TYPE,
  type OwnerTieView,
  PERSON_CONNECTIONS,
  SYMMETRIC_CONNECTIONS,
} from "@intelligence/contracts/personal";
import { stamp } from "../core/db.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import type { SealedRow } from "../core/seal.ts";
import { servedJson } from "../core/served.ts";
import { NAMES_SHOWN } from "../core/visibility.ts";

// What the owner confirmed of how people are tied to the owner and to each other. Only a released claim
// in force counts (the owner's confirm released the agent's proposal to `own`; a lift, a veto, a retire or
// an erasure ends it at once), so a client not cleared for `own` sees none of it, and an inferred
// link is never served before the owner confirms it. Each read is one fixed statement, whatever the
// members are, under the caller's token. A claim that names an entity the token does not show is
// not served at all (invariant 6), as find_facts leaves it out (NAMES_SHOWN), so a link to
// someone hidden says nothing, not even that it is.

// Newest by the owner's confirm, the release's ruling, whose id is a ULID
// and so in time order, not by when the agent proposed it.
const CONFIRMED = `
  select c.id, c.type, c.compartments, c.content_enc, c.valid_from, c.fact_key_fp,
    (select w.id from ledger.agent_writes w where w.evidence_id = c.evidence_id order by w.id limit 1) as record_id
  from knowledge.claims c
  join policy.released_records() r on r.evidence_id = c.evidence_id
  where c.type = any($2::text[]) and c.released
    and exists (select 1 from knowledge.claim_entities n where n.claim_id = c.id and n.entity_id = any($1::text[]))
    and ${NAMES_SHOWN}
  order by r.ruling_id collate "C" desc, c.id`;

// Invariant 10: the Lens mirror's entities section, for a page of people,
// each confirmed tie and link naming one, by person, with its evidence and label, so a confirm, a
// lift, a veto or an erasure changes the entry's token and the entry is rebuilt, as a contact's is.
export const MIRROR_TIES = `
  select n.entity_id, c.id, c.evidence_id, c.compartments
  from knowledge.claims c
  join knowledge.claim_entities n on n.claim_id = c.id
  where c.type = any($2::text[]) and c.released and n.entity_id = any($1::text[])
    and c.evidence_id in (select r.evidence_id from policy.released_records() r)
    and ${NAMES_SHOWN}
  order by n.entity_id, c.id`;
export const TIE_TYPES: readonly string[] = Object.freeze([OWNER_TIE_TYPE, CONNECTION_TYPE]);

type Row = SealedRow<"knowledge.claims.content_enc"> & {
  type: string;
  valid_from: Date;
  fact_key_fp: string;
  record_id: string | null;
};
type Confirmed = { row: Row; record: ClaimRecord };

async function confirmedOf(ctx: Ctx, members: readonly string[], types: readonly string[]): Promise<Confirmed[]> {
  const rows = await ctx.run<Row>(CONFIRMED, [members, types]);
  return rows.map((row) => {
    const parsed = ClaimRecord.safeParse(servedJson(ctx, row, "knowledge.claims.content_enc"));
    if (!parsed.success) throw new Unavailable();
    return { row, record: parsed.data };
  });
}

// get_entity's two parts for a group's visible members: its newest confirmed tie to the owner, and
// each typed link once (kind, other and direction), newest first, at most PERSON_CONNECTIONS. The
// fact keys served, for the read log.
export async function tiesFor(
  ctx: Ctx,
  members: readonly string[],
): Promise<{ toOwner?: OwnerTieView; connections: ConnectionView[]; factKeyFps: string[] }> {
  const mine = new Set(members);
  let toOwner: OwnerTieView | undefined;
  const connections: ConnectionView[] = [];
  const served: string[] = [];
  for (const { row, record } of await confirmedOf(ctx, members, [OWNER_TIE_TYPE, CONNECTION_TYPE])) {
    const { subject, fields } = record.claim.content;
    const source = {
      tier: "owner_confirmed" as const,
      record: row.record_id === null ? null : AgentRecordId.parse(row.record_id),
      at: Timestamp.parse(stamp(row.valid_from)),
    };
    if (row.type === OWNER_TIE_TYPE) {
      if (toOwner !== undefined || !mine.has(subject)) continue;
      toOwner = {
        relation: fields.relation as OwnerTieView["relation"],
        closeness: fields.closeness as Closeness,
        ...source,
      };
      served.push(row.fact_key_fp);
      continue;
    }
    const kind = ConnectionKind.parse(fields.kind);
    const other = String(fields.other);
    const out = mine.has(subject);
    // A link inside one group (both people are its members) is no link to anyone else.
    if (out && mine.has(other)) continue;
    const view: ConnectionView = {
      kind,
      other: EntityId.parse(out ? other : subject),
      direction: SYMMETRIC_CONNECTIONS.includes(kind) ? "both" : out ? "out" : "in",
      inferred: fields.inferred === true,
      ...source,
    };
    if (
      connections.length >= PERSON_CONNECTIONS ||
      connections.some((one) => one.kind === view.kind && one.other === view.other && one.direction === view.direction)
    )
      continue;
    connections.push(view);
    served.push(row.fact_key_fp);
  }
  return { ...(toOwner === undefined ? {} : { toOwner }), connections, factKeyFps: served };
}
