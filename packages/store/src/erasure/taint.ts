import type { Query } from "../core/db.ts";

// A row tainted in this transaction, by any call of it: ledger.taint_citing and its sweeps stamp what
// they taint with now(), the transaction's own time. It is how a later step finds what the taint
// reached, since the function answers only a count. Every such read goes through here, and
// erasure-paths.db.test.ts and memory-erase.db.test.ts hold that it finds them.
export const TAINTED_HERE = (column: string): string => `${column} = now()`;

// The ref kind of a `ruling_carry` card's candidate claims in the card's basis (ledger.cite_claims).
// They are what the card's body lists, and no ref of the card's: a read of a card's refs leaves
// them out. An erasure hands the claims it removes to ledger.taint_citing under this kind, so a card
// that lists one is tainted with it.
export const CARRY_CLAIM = "carry_claim";

// Whether a join or a split names one of these people: by its entities, or by a stored claim under
// either of its keys. What knowledge.gone_keys and knowledge.name_ruling_people read.
export const NAMES_PEOPLE = (ruling: string, people: string): string =>
  `(${ruling}.entity_ids && ${people}::text[]
    or exists (select 1 from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id
               where n.entity_id = any (${people}::text[])
                 and (c.fact_key_fp in (${ruling}.a_fp, ${ruling}.b_fp) or c.legacy_fact_key_fp in (${ruling}.a_fp, ${ruling}.b_fp)
                   or c.legacy_alt_fact_key_fp in (${ruling}.a_fp, ${ruling}.b_fp))))`;

// The fact keys of the rulings anchored on what goes: a belief ruling's, and each side of a join's or
// a split's, when all the evidence it was anchored on goes or it names a person who goes. A join or
// a split names a person by its entities, or by a claim under either of its keys that names them
// (knowledge.name_ruling_people adds them to its entities before the claims go). Such a key
// may be one a generation moved since, which no claim of the erasure holds any more, so the
// erasure's claims never name it; it is one of the erasure's fact keys all the same. Whether it is
// gone is knowledge.gone_keys' to say: another ruling on it may still be anchored on an item that
// stays. Read before the removal empties the anchors.
export async function anchoredKeys(query: Query, evidenceIds: string[], people: string[]): Promise<string[]> {
  const rows = await query<{ fp: string }>(
    `select s.fp from knowledge.fact_rulings f
     cross join lateral (values (f.a_fp, f.a_evidence_ids), (f.b_fp, f.b_evidence_ids)) as s (fp, evidence_ids)
     where f.claim_type is not null
       and ((cardinality(s.evidence_ids) > 0 and s.evidence_ids <@ $1::text[]) or ${NAMES_PEOPLE("f", "$2")})
     union
     select r.fact_key_fp from knowledge.belief_rulings r
     where r.claim_type is not null
       and ((cardinality(r.evidence_ids) > 0 and r.evidence_ids <@ $1::text[]) or r.entity_ids && $2::text[])
     order by 1`,
    [evidenceIds, people],
  );
  return rows.map((row) => row.fp);
}

// The belief rulings anchored on any of this evidence or these people.
export async function anchoredRulings(query: Query, evidenceIds: string[], people: string[]): Promise<string[]> {
  const rows = await query<{ ruling_id: string }>(
    `select ruling_id from knowledge.belief_rulings
     where evidence_ids && $1::text[] or entity_ids && $2::text[] order by ruling_id collate "C"`,
    [evidenceIds, people],
  );
  return rows.map((row) => row.ruling_id);
}

// It returns how many ledger rows it tainted, and makes no call when nothing was deleted.
// `staying`: the evidence rows among them that stay stored, a superseded revision's or an expired
// item's kept one: what cited them is tainted all the same, and a ruling keeps its anchor on them,
// since the row is still there to be found by (a later erasure of the item reaches the ruling
// through it, and the carry-over reads the item's claims through it).
export async function taintCiting(
  query: Query,
  gone: { evidenceIds: string[]; refs: readonly { kind: string; id: string }[]; staying?: readonly string[] },
): Promise<number> {
  if (gone.evidenceIds.length === 0 && gone.refs.length === 0) return 0;
  const [row] = await query<{ tainted: number }>("select ledger.taint_citing($1, $2, $3) as tainted", [
    gone.evidenceIds,
    gone.refs.map((ref) => ref.kind),
    gone.refs.map((ref) => ref.id),
  ]);
  const removed = gone.evidenceIds.filter((id) => gone.staying?.includes(id) !== true);
  if (removed.length > 0) await query("select knowledge.forget_ruling_anchors($1::text[], $2::text[])", [removed, []]);
  if (removed.length > 0) await query("select ledger.forget_question_sources($1::text[])", [removed]);
  return row?.tainted ?? 0;
}
