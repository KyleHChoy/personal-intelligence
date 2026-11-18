import type { PersonalRef } from "@intelligence/contracts/personal";
import type { Query } from "../core/db.ts";
import { forgetPairCalls } from "../core/decision-calls.ts";
import { BELIEFS_LOCK } from "../core/locks.ts";
import type { Tx } from "../core/tx.ts";
import { dropDeclassified } from "../erasure/declassified.ts";
import { taintCiting } from "../erasure/taint.ts";
import { removeWarmth } from "../identity/warmth-build.ts";

// What removing an item's claims takes out, for a source item's removal and for an agent record's.

// The entities the rows citing these revisions name.
export async function namedBy(tx: Pick<Tx, "query">, evidenceIds: string[]): Promise<string[]> {
  const rows = await tx.query<{ entity_id: string }>(
    `select entity_id from knowledge.interaction_log where evidence_id = any($1)
     union select entity_id from knowledge.aliases where evidence_id = any($1)
     union select p.entity_id from knowledge.event_participants p join knowledge.events e on e.id = p.event_id where e.evidence_id = any($1)
     union select a.entity_id from knowledge.contact_addresses a join knowledge.contacts c on c.id = a.contact_id where c.evidence_id = any($1)`,
    [evidenceIds],
  );
  return rows.map((row) => row.entity_id);
}

// Usage and run rows name no item and stay. The caller has locked the revisions' evidence rows `for update` first. The saved calls are
// every call keyed under one of them and every moment group's call one of them is a member of, so a group's call goes with any moment it
// read. The close claims of the facts of the claims given (those ids being removed) that would have no claim left but closes.
const CLOSES_LEFT_BARE = `
  select c.id, c.evidence_id from knowledge.claims c
  where c.closes and c.fact_key_fp in (select g.fact_key_fp from knowledge.claims g where g.id = any ($1) and not g.closes)
    and not exists (select 1 from knowledge.claims o where o.fact_key_fp = c.fact_key_fp and not o.closes and not (o.id = any ($1)))
  order by c.id`;

// These claims, children before parents, the one place a claim's removal is written: their project
// bindings, their declassified copies, then the claims with their entity rows, under the beliefs lock (a
// second take in one transaction is a no-op). A later table that rests on a claim is deleted here first.
//
// The pipeline's commit differs in three ways, with `asPipeline`: it took the beliefs lock already, in its own order
// with the author's and the record's; what it leaves out of a batch is extracted, never an owner_tie (whose
// closeness warmth reads at read, so no stored warmth rests on a claim); and it deletes the rows itself, holding
// delete on them and no execute on the definer. Everyone else removes them through knowledge.remove_claims, since
// the admin holds no delete on claims.
export async function removeClaims(
  query: Query,
  claims: readonly string[],
  options: { asPipeline?: true } = {},
): Promise<void> {
  if (claims.length === 0) return;
  if (options.asPipeline !== true) {
    await query(BELIEFS_LOCK);
  }
  // The claims' project bindings (the key is plain).
  await query("delete from knowledge.project_bindings where claim_id = any ($1)", [claims]);
  if (options.asPipeline === true) {
    await query("delete from knowledge.claim_entities where claim_id = any ($1)", [claims]);
    await dropDeclassified(query, [...claims]);
    await query("delete from knowledge.claims where id = any ($1)", [claims]);
    return;
  }
  await dropDeclassified(query, [...claims]);
  await query("select knowledge.remove_claims($1)", [claims]);
}

// The saved calls keyed under these evidence rows or holding one of them as a moment group's
// member, their members first. Every removal of a saved call goes through here.
async function removeCalls(query: Query, evidenceIds: readonly string[]): Promise<void> {
  const calls = (
    await query<{ id: string }>(
      "select id from vault.model_calls where evidence_id = any ($1) or superseded_members && $1::text[] union select call_id from vault.model_call_members where evidence_id = any ($1)",
      [evidenceIds],
    )
  ).map((row) => row.id);
  if (calls.length === 0) return;
  await query("delete from vault.model_call_members where call_id = any ($1)", [calls]);
  await query("delete from vault.model_calls where id = any ($1)", [calls]);
}

// A retry's part: the calls still replayed that are keyed under these evidence rows or hold one as
// a moment group's member are marked superseded and kept, where a retry deleted them. A group's
// members move onto its call, so the group forms again at the next run and `removeCalls` still
// finds the call by any member. Nothing is deleted but the member rows, whose ids the call now
// holds.
export async function supersedeCalls(query: Query, evidenceIds: readonly string[]): Promise<void> {
  const calls = (
    await query<{ id: string }>(
      "select id from vault.model_calls where evidence_id = any ($1) and superseded_at is null union select call_id from vault.model_call_members where evidence_id = any ($1)",
      [evidenceIds],
    )
  ).map((row) => row.id);
  if (calls.length === 0) return;
  await query(
    `update vault.model_calls c set superseded_at = now(),
       superseded_members = (select array_agg(m.evidence_id order by m.evidence_id) from vault.model_call_members m where m.call_id = c.id)
     where c.id = any ($1) and c.superseded_at is null`,
    [calls],
  );
  await query("delete from vault.model_call_members where call_id = any ($1)", [calls]);
}

// The tables whose rows keep a person's account: a new table that names a person joins this list or
// the reasons beside the test that reads the database's own foreign keys.
export const KEEPS_A_PERSON = [
  ["knowledge.interaction_log", "i"],
  ["knowledge.aliases", "s"],
  ["knowledge.event_participants", "p"],
  ["knowledge.claim_entities", "c"],
  ["knowledge.contact_addresses", "k"],
] as const;

// A person's account row is cited by an interaction, a name, an event participation or a claim that
// names that person under the row's compartment. The owner's rows are never touched, and never keep
// a domain row: only a person's address makes one, so only a person's keeps one, and the rows left
// are the rows a re-derive would make. It returns the people and organizations it removed, and the
// address fingerprints no account row holds any more.
export async function removeUncited(
  tx: Pick<Tx, "query">,
  entities: string[],
): Promise<{ entities: string[]; addressFps: string[] }> {
  if (entities.length === 0) return { entities: [], addressFps: [] };
  const accounts = await tx.query<{ value_fp: string; domain_fp: string; compartments: string[] }>(
    `delete from knowledge.accounts a
     using knowledge.entities e
     where e.id = a.entity_id and e.kind = 'person' and a.entity_id = any($1)
${KEEPS_A_PERSON.map(
  ([table, as]) =>
    `       and not exists (select 1 from ${table} ${as} where ${as}.entity_id = a.entity_id and ${as}.compartments = a.compartments)\n`,
).join("")}     returning a.value_fp, a.domain_fp, a.compartments`,
    [entities],
  );
  // No pair call outlives a person's removed address.
  await forgetPairCalls(
    tx.query,
    accounts.map((row) => row.value_fp),
  );
  const organizations = await tx.query<{ entity_id: string }>(
    `delete from knowledge.domains d
     where exists (select 1 from jsonb_to_recordset($1::jsonb) as gone (fp text, label text[]) where gone.fp = d.domain_fp and gone.label = d.compartments)
       and not exists (select 1 from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id
                       where e.kind = 'person' and a.domain_fp = d.domain_fp and a.compartments = d.compartments)
     returning d.entity_id`,
    [JSON.stringify(accounts.map((row) => ({ fp: row.domain_fp, label: row.compartments })))],
  );
  // The chat lines of every person about to go, before their entity rows, and the warmth rows of
  // every audience containing those lines' labels. A chat line never cites an account, so a phone
  // person whose saved contact went is removed here with their lines.
  const lines = await tx.query<{ compartments: string[] }>(
    `with doomed as (
       select e.id from knowledge.entities e
       where e.id = any($1) and e.kind = 'person'
         and not exists (select 1 from knowledge.accounts a where a.entity_id = e.id)
         and not exists (select 1 from knowledge.domains d where d.entity_id = e.id)
         and not exists (select 1 from knowledge.claim_entities n where n.entity_id = e.id)),
     gone as (delete from knowledge.chat_lines l using doomed where l.entity_id = doomed.id returning l.compartments)
     select distinct compartments from gone`,
    [entities],
  );
  await removeWarmth(
    tx.query,
    lines.map((row) => row.compartments),
  );
  const gone = await tx.query<{ id: string }>(
    `delete from knowledge.entities e
     where e.id = any($1) and e.kind in ('person', 'organization')
       and not exists (select 1 from knowledge.accounts a where a.entity_id = e.id)
       and not exists (select 1 from knowledge.domains d where d.entity_id = e.id)
       and not exists (select 1 from knowledge.claim_entities n where n.entity_id = e.id)
     returning e.id`,
    [[...entities, ...organizations.map((row) => row.entity_id)]],
  );
  // What cited a removed person or organization is tainted.
  await taintCiting(tx.query, {
    evidenceIds: [],
    refs: gone.map((row) => ({ kind: "entity", id: row.id }) as PersonalRef),
  });
  const unheld = await tx.query<{ fp: string }>(
    "select f.fp from unnest($1::text[]) as f (fp) where not exists (select 1 from knowledge.accounts a where a.value_fp = f.fp)",
    [[...new Set(accounts.map((row) => row.value_fp))]],
  );
  return { entities: gone.map((row) => row.id), addressFps: unheld.map((row) => row.fp) };
}

// removeUncited inside an erasure, or a deletion at the source that is switched on to act as one
// (writer-item-removal.ts, SCRUB_ON_SOURCE_DELETION): never an expiry, a drop, a replacement or a
// re-derive, after which the same person may be made again under the id it had. An agents' report
// of a wrong merge that names a removed person, or cites a removed address, is closed or stripped
// by the erasure's own rule, at the point the person goes.
export async function removeForGood(tx: Pick<Tx, "query">, entities: string[]): Promise<void> {
  const gone = await removeUncited(tx, entities);
  if (gone.entities.length === 0 && gone.addressFps.length === 0) return;
  await tx.query("select ledger.forget_wrong_merges('{}'::text[], $1::text[], $2::text[], false)", [
    gone.addressFps,
    gone.entities,
  ]);
}

export async function removeExtracted(tx: Pick<Tx, "query">, evidenceIds: string[]): Promise<string[]> {
  await tx.query(BELIEFS_LOCK);
  const own = (
    await tx.query<{ id: string }>("select id from knowledge.claims where evidence_id = any ($1)", [evidenceIds])
  ).map((row) => row.id);
  // An agent's close of a commitment whose last claim goes here goes with it (invariant 10). It
  // copied that commitment's content, so it is derived from what is removed.
  const bare = await tx.query<{ id: string; evidence_id: string }>(CLOSES_LEFT_BARE, [own]);
  const orphans = bare.map((row) => row.id);
  // Each such close record is due again: when the item removed is only revised, its
  // new revision states the commitment again and the close is built against it; when it is gone,
  // the close ends `orphaned`.
  if (bare.length > 0)
    await tx.query("delete from vault.pipeline_items where evidence_id = any ($1)", [
      [...new Set(bare.map((row) => row.evidence_id))],
    ]);
  const claims = [...new Set([...own, ...orphans])];
  const named = (
    await tx.query<{ entity_id: string }>(
      "select distinct entity_id from knowledge.claim_entities where claim_id = any ($1)",
      [claims],
    )
  ).map((row) => row.entity_id);
  await removeClaims(tx.query, claims);
  for (const table of ["vault.unmapped_claims", "vault.unresolved_mentions"])
    await tx.query(`delete from ${table} where evidence_id = any ($1)`, [evidenceIds]);
  await removeCalls(tx.query, evidenceIds);
  for (const table of ["vault.pipeline_items", "vault.extraction_reviews"])
    await tx.query(`delete from ${table} where evidence_id = any ($1)`, [evidenceIds]);
  return named;
}

// The restriction requests and screens of evidence rows about to be deleted, so their foreign keys never
// stop a deletion. Only where the evidence rows themselves go: a new revision keeps its item's pending
// request for sync to apply.
export async function removeRestrictions(tx: Pick<Tx, "query">, evidenceIds: string[]): Promise<void> {
  await tx.query("delete from vault.restriction_requests where evidence_id = any ($1)", [evidenceIds]);
  await tx.query("delete from vault.restrict_screens where evidence_id = any ($1)", [evidenceIds]);
}
