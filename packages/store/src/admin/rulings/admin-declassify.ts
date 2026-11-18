import type { Timestamp } from "@intelligence/contracts";
import {
  CARD_OPTIONS,
  type CardId,
  ClaimRecord,
  type ClientId,
  type DeclassificationView,
  type FactId,
  FactView,
  isCoded,
  type PersonalCompartment,
  type RulingId,
  type Who,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError, asAdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { newId } from "../../core/ids.ts";
import { authorWord, BELIEFS_LOCK } from "../../core/locks.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows, raiseCard } from "../../core/queue.ts";
import type { Sealed } from "../../core/seal.ts";
import { open, openUnder, sealUnder } from "../../core/seal.ts";
import { type ClaimRow, renderFact } from "./admin-rulings.ts";

// The owner's declassification of one claim and its revocation, each in one transaction: the beliefs lock
// first, then the shared taint lock. Every deletion of a claim holds the beliefs lock too, so no copy is
// committed of a claim deleted beside it. Nothing here logs or returns content: ids and counts only.

const TABLE = "projections.declassified_facts";
const AUTHOR = "system:declassify";
const DECLASSIFIED = "declassified";

type Claim = ClaimRow & { evidence_id: string; origin_ok: boolean; held: boolean | null };
const CLAIM = `
  select c.id, c.type, c.valid_from, c.fact_key_fp, c.content_enc, c.compartments, e.source_account_id, e.source_item_fp,
    m.id as message_id, d.id as document_id, c.evidence_id, not (e.system_originated or e.answers_system) as origin_ok, m.held
  from knowledge.claims c
  join vault.evidence_items e on e.id = c.evidence_id
  left join knowledge.messages m on m.evidence_id = c.evidence_id
  left join knowledge.documents d on d.evidence_id = c.evidence_id
  where c.id = $1`;

// The owner, as a declassified copy gives the owner: no name and no address.
const anonymous = (value: unknown): unknown =>
  typeof value === "object" && value !== null && (value as Who).kind === "owner"
    ? { ...(value as Who), name: null, address: null }
    : value;

// It reads as a client cleared for exactly the claim's compartments would, rows of any other left out and no
// other key given, so the copy holds nothing its claim's label does not cover (invariant 4): a person's name
// seen only under another compartment is not in it. A claim that cannot be rendered as a fact is not
// declassified either.
async function rendered(admin: AdminContext, query: Query, row: Claim): Promise<FactView> {
  if (!row.origin_ok || row.held !== false) throw new AdminError("not_declassifiable");
  const within = (compartments: unknown): boolean =>
    !Array.isArray(compartments) || compartments.every((one) => (row.compartments as string[]).includes(one));
  const narrowed: Query = async <Row>(text: string, values?: unknown[]) =>
    (await query<Row>(text, values)).filter((one) => within((one as { compartments?: unknown }).compartments));
  const keys = {
    ...admin.keys,
    compartments: new Map(
      [...admin.keys.compartments].filter(([compartment]) => (row.compartments as string[]).includes(compartment)),
    ),
  };
  let fact: FactView;
  try {
    const record = ClaimRecord.parse(JSON.parse(open(keys, row, "knowledge.claims.content_enc", "throw")));
    fact = await renderFact({ ...admin, keys }, narrowed, row, record, row.compartments as string[]);
  } catch (error) {
    // A person the claim names whom its compartments do not show, a value that does not open,
    // or a fact the contract refuses. A database error, which has an SQLSTATE, is no refusal.
    const code = isCoded(error) ? error.code : undefined;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) throw error;
    throw new AdminError("not_declassifiable");
  }
  const parsed = FactView.safeParse({
    ...fact,
    message: null,
    subject: anonymous(fact.subject),
    statedBy: anonymous(fact.statedBy),
    fields: Object.fromEntries(Object.entries(fact.fields).map(([field, value]) => [field, anonymous(value)])),
  });
  if (!parsed.success || parsed.data.thirdParty || parsed.data.agentReported)
    throw new AdminError("not_declassifiable");
  return parsed.data;
}

export async function declassify(admin: AdminContext, id: FactId, options: { requestId: string }): Promise<RulingId> {
  const now = admin.now();
  try {
    return await admin.transaction(async (query) => {
      await query(BELIEFS_LOCK);
      await lockRows(query, []);
      // A repeated request id returns the first ruling and writes nothing.
      const [repeat] = await query<{ id: RulingId; kind: string }>(
        "select id, kind from knowledge.owner_decisions where request_id = $1",
        [options.requestId],
      );
      if (repeat !== undefined) {
        if (repeat.kind !== "declassify") throw new AdminError("invalid_argument");
        return repeat.id;
      }
      if (!admin.keys.compartments.has(DECLASSIFIED)) throw new AdminError("unknown_compartment");
      const [row] = await query<Claim>(CLAIM, [id]);
      if (row === undefined) throw new AdminError("not_found");
      const fact = await rendered(admin, query, row);
      const [standing] = await query(`select 1 from ${TABLE} where claim_fp = $1`, [id]);
      if (standing !== undefined) throw new AdminError("already_declassified");

      // The type is sealed in the decision's body, under the claim's compartments, so the listing
      // names it after the copy is gone.
      const ruling = await ownerDecision(
        query,
        {
          requestId: options.requestId,
          kind: "declassify",
          details: { claim: id },
          compartments: row.compartments,
          body: { text: row.type, keys: admin.keys },
        },
        now,
      );
      const copy = newId("dcl");
      await query(
        `insert into ${TABLE} (id, ruling_id, claim_fp, evidence_id, type, valid_from, created_at, fact_enc, compartments)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          copy,
          ruling,
          id,
          row.evidence_id,
          row.type,
          row.valid_from,
          stamp(now),
          sealUnder(admin.keys, [DECLASSIFIED], { table: TABLE, id: copy, column: "fact_enc" }, JSON.stringify(fact)),
          [DECLASSIFIED],
        ],
      );
      return ruling;
    });
  } catch (error) {
    throw asAdminError(error);
  }
}

type Listed = {
  id: RulingId;
  claim: FactId;
  decided_at: Date;
  body_enc: Sealed;
  compartments: string[];
  type: string | null;
  revoked_at: Date | null;
};

// Oldest first. `standing` while the copy is stored, `revoked` when a revocation ends it, and
// `gone` when it went with its claim.
export async function listDeclassified(admin: AdminContext): Promise<DeclassificationView[]> {
  return admin.transaction(async (query) => {
    const rows = await query<Listed>(
      `select d.id, d.details->>'claim' as claim, d.decided_at, d.body_enc, d.compartments, f.type,
         (select r.decided_at from knowledge.owner_decisions r where r.supersedes = d.id and r.kind = 'declassify_revoke' order by r.id limit 1) as revoked_at
       from knowledge.owner_decisions d
       left join ${TABLE} f on f.ruling_id = d.id
       where d.kind = 'declassify'
       order by d.decided_at, d.id collate "C"`,
    );
    return rows.map((row) => ({
      id: row.id,
      claim: row.claim,
      type: row.type ?? typeOf(admin, row),
      state: row.type !== null ? "standing" : row.revoked_at !== null ? "revoked" : "gone",
      at: stamp(row.decided_at),
      revokedAt: row.revoked_at === null ? null : (stamp(row.revoked_at) as Timestamp),
    }));
  });
}

// The type sealed in the decision's body; `unknown` when the key file lacks its compartments.
function typeOf(admin: AdminContext, row: Listed): string {
  try {
    return openUnder(
      admin.keys,
      row.compartments,
      { table: "knowledge.owner_decisions", id: row.id, column: "body_enc" },
      row.body_enc,
    );
  } catch {
    return "unknown";
  }
}

// A call still in flight is logged only after it answers, so every active client counts. A client's
// clearance never narrows (setTools only adds its own `agent:` compartment, and setCompartments refuses to
// drop one), so today's clearance is the one it read under.
const EXPOSED = `
  select c.id from policy.clients c
  where c.compartments @> array['declassified']::text[]
    and (c.status = 'active'
         or exists (select 1 from policy.calls k where k.client_id = c.id and k.tool = 'find_facts' and k.outcome = 'ok' and k.at >= $1))
  order by c.id`;

export async function revokeDeclassified(
  admin: AdminContext,
  id: RulingId,
  options: { requestId: string },
): Promise<{ exposed: number }> {
  const now = admin.now();
  try {
    return await admin.transaction(async (query) => {
      await query(BELIEFS_LOCK);
      await lockRows(query, [authorWord(AUTHOR)]);
      // A repeated request id returns the first count and writes nothing. One that revoked
      // another declassification is refused.
      const [repeat] = await query<{ kind: string; supersedes: string | null; details: { exposed?: unknown[] } }>(
        "select kind, supersedes, details from knowledge.owner_decisions where request_id = $1",
        [options.requestId],
      );
      if (repeat !== undefined) {
        if (repeat.kind !== "declassify_revoke" || repeat.supersedes !== id) throw new AdminError("invalid_argument");
        return { exposed: repeat.details.exposed?.length ?? 0 };
      }
      const [copy] = await query<{ created_at: Date; compartments: PersonalCompartment[] }>(
        `select f.created_at, d.compartments from ${TABLE} f join knowledge.owner_decisions d on d.id = f.ruling_id where f.ruling_id = $1`,
        [id],
      );
      if (copy === undefined) throw new AdminError("not_found");
      const exposed = (await query<{ id: ClientId }>(EXPOSED, [copy.created_at])).map((row) => row.id);
      await query(`delete from ${TABLE} where ruling_id = $1`, [id]);
      const ruling = await ownerDecision(
        query,
        {
          requestId: options.requestId,
          kind: "declassify_revoke",
          supersedes: id,
          details: { exposed },
          compartments: copy.compartments,
        },
        now,
      );
      if (exposed.length > 0) {
        await raiseCard(
          query,
          {
            id: newId("crd") as CardId,
            requestId: `declassify_${ruling.slice(4)}`,
            kind: "notice",
            author: AUTHOR,
            options: [...CARD_OPTIONS.notice],
            target: null,
            refs: [],
            compartments: copy.compartments,
            expiresAt: null,
            expiresAfterDays: null,
            caseKey: null,
            run: null,
            body: null,
            bodyFrom: null,
          },
          { now, log: admin.log },
        );
      }
      return { exposed: exposed.length };
    });
  } catch (error) {
    throw asAdminError(error);
  }
}
