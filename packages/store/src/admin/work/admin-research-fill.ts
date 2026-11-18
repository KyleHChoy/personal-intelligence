import { FILL_FIELDS, type Fill, parseFillBody } from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { stamp } from "../../core/db.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";
import { removeOne } from "../../write/writer-records.ts";
import { fillTag, researchCardRequest, researchMergeRequest } from "../../write/writer-research.ts";

// Ids, code words and times only: no fill's text is printed. As pi_admin.

// What landed of a fill's identifier or domain: a join by policy merge (with its ruling), a card
// for the owner (the holder is someone the owner has a tie with), the node's account or domain row, the node's
// name rows joined to a domain's organization, or nothing yet (refused, or waiting for the sync).
type LandedIdentity = "joined" | "carded" | "account" | "domain" | "org_joined" | "none";
type LandedFill = {
  record: string;
  client: string;
  node: string;
  at: string;
  // in_force, or removed (lifted, erased) or flagged.
  state: "in_force" | "removed" | "flagged";
  fields: (keyof Fill)[];
  identity: LandedIdentity;
  ruling: string | null;
  claims: number;
};

const FILLS = `
  select w.id, w.client_name, w.fill_node, e.fill_identity_fp, e.fill_domain_fp, w.created_at, w.compartments, w.body_enc, w.flagged_at is not null as flagged,
    (select count(*)::int from knowledge.claims c where c.evidence_id = w.evidence_id and c.researched) as claims
  from ledger.agent_writes w left join vault.evidence_items e on e.id = w.evidence_id where w.kind = 'fill' and w.created_at >= $1
  order by w.created_at desc, w.id desc`;
const TAGGED = `
  select
    exists (select 1 from knowledge.accounts where id like 'rsa\\_' || $1 || '\\_%') as account,
    exists (select 1 from knowledge.domains where id like 'rsd\\_' || $1 || '\\_%') as domain,
    exists (select 1 from knowledge.org_names where id like 'onn\\_rso\\_' || $1 || '\\_%') as org_joined`;
const JOIN = `
  select d.id, r.lifted_at is not null as lifted from knowledge.owner_decisions d join knowledge.identity_rulings r on r.ruling_id = d.id
  where d.request_id = $1 and d.kind = 'identity_policy'`;
const CARD = "select exists (select 1 from ledger.cards c where c.request_id = $1) as carded";

// `pia research landed [--since D]`: each fill since the time, newest first, the joins first.
export async function researchLanded(admin: AdminContext, since: Date): Promise<LandedFill[]> {
  return admin.transaction(async (query) => {
    const rows = await query<{
      id: string;
      client_name: string;
      fill_node: string;
      fill_identity_fp: string | null;
      fill_domain_fp: string | null;
      created_at: Date;
      compartments: string[];
      body_enc: Sealed;
      flagged: boolean;
      claims: number;
    }>(FILLS, [since]);
    const landed: LandedFill[] = [];
    for (const row of rows) {
      let fields: (keyof Fill)[] = [];
      if (row.body_enc !== null) {
        const body = parseFillBody(open(admin.keys, row, "ledger.agent_writes.body_enc", "throw"));
        fields =
          body === null
            ? []
            : (Object.keys(FILL_FIELDS) as (keyof Fill)[]).filter((field) => body.fill[field] !== undefined);
      }
      let identity: LandedIdentity = "none";
      let ruling: string | null = null;
      if (row.fill_identity_fp !== null) {
        const [join] = await query<{ id: string; lifted: boolean }>(JOIN, [
          researchMergeRequest(row.id, row.fill_identity_fp),
        ]);
        if (join !== undefined && !join.lifted) {
          identity = "joined";
          ruling = join.id;
        } else if (
          (await query<{ carded: boolean }>(CARD, [researchCardRequest(row.id, row.fill_identity_fp)]))[0]?.carded ===
          true
        )
          identity = "carded";
      }
      if (identity === "none") {
        const [tagged] = await query<{ account: boolean; domain: boolean; org_joined: boolean }>(TAGGED, [
          fillTag(row.id),
        ]);
        identity =
          tagged?.account === true
            ? "account"
            : tagged?.domain === true
              ? "domain"
              : tagged?.org_joined === true
                ? "org_joined"
                : "none";
      }
      landed.push({
        record: row.id,
        client: row.client_name,
        node: row.fill_node,
        at: stamp(row.created_at),
        state: row.body_enc === null ? "removed" : row.flagged ? "flagged" : "in_force",
        fields,
        identity,
        ruling,
        claims: row.claims,
      });
    }
    const joins = (one: LandedFill): number => (one.identity === "joined" || one.identity === "org_joined" ? 0 : 1);
    return landed.sort((a, b) => joins(a) - joins(b));
  });
}

// `pia research lift REC`: the fill's record removed, as `pi agent-records rm` removes one, with
// its claims (its facts and edges) now; its account, domain row and name rows go at the next sync,
// whose research step no longer finds the fill in force. A join stays until `pi identity lift`.
// Null for an id that names no fill.
export async function liftResearch(admin: AdminContext, record: string): Promise<{ removed: number } | null> {
  return admin.transaction(async (query) => {
    const [row] = await query<{ id: string }>("select id from ledger.agent_writes where id = $1 and kind = 'fill'", [
      record,
    ]);
    if (row === undefined) return null;
    return { removed: (await removeOne({ query }, record)) ? 1 : 0 };
  });
}
