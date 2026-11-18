import { isFullName } from "@intelligence/personal-core/items";
import type { Query } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";
import { open, type Sealed } from "../core/seal.ts";

// The live joins that rest on little, for `pi identity thin` and `pi
// outcomes`: a same ruling whose two sides share no full name and no stored contact. Thin is no
// verdict: one person with two names is thin too. `first_name_only`, a one-word name is all they
// share, is the case worth reading first: two people can share a first name and nothing else. Run as
// pi_admin. Ids, codes and times only; a name is opened to count its words and goes no further.

type ThinMerge = {
  ruling: string;
  a: string | null;
  b: string | null;
  by: "policy" | "owner";
  basis: string | null;
  reason: "first_name_only" | "no_shared_name" | "unreadable";
  at: Date;
};

const JOINS = `
  select r.ruling_id, r.a_fp, r.b_fp, r.created_at, d.kind, d.details ->> 'basis' as basis,
    (select array_agg(distinct a.entity_id) from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id
      where e.kind = 'person' and a.value_fp = r.a_fp) as a_people,
    (select array_agg(distinct a.entity_id) from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id
      where e.kind = 'person' and a.value_fp = r.b_fp) as b_people
  from knowledge.identity_rulings r join knowledge.owner_decisions d on d.id = r.ruling_id
  where r.verdict = 'same' and r.lifted_at is null and r.b_fp is not null
  order by r.created_at, r.ruling_id collate "C"`;
const SHARED_NAMES = `
  select distinct on (x.value_fp) x.id, x.value_enc, x.compartments
  from knowledge.aliases x join knowledge.aliases y on y.value_fp = x.value_fp
  where x.entity_id = any($1::text[]) and y.entity_id = any($2::text[])
  order by x.value_fp, x.id`;
const ON_ONE_CONTACT = `
  select exists (
    select 1 from knowledge.contact_addresses x join knowledge.contact_addresses y on y.contact_id = x.contact_id
    where x.entity_id = any($1::text[]) and y.entity_id = any($2::text[])) as yes`;

export async function thinMerges(query: Query, keys: Keys): Promise<ThinMerge[]> {
  const joins = await query<{
    ruling_id: string;
    created_at: Date;
    kind: string;
    basis: string | null;
    a_people: string[] | null;
    b_people: string[] | null;
  }>(JOINS);
  const thin: ThinMerge[] = [];
  for (const join of joins) {
    const [a, b] = [join.a_people ?? [], join.b_people ?? []];
    // A side with no person behind it any more joins no one, and two rows of one person, nothing.
    if (a.length === 0 || b.length === 0 || a.some((one) => b.includes(one))) continue;
    if ((await query<{ yes: boolean }>(ON_ONE_CONTACT, [a, b]))[0]?.yes === true) continue;
    const shared = await query<{ id: string; value_enc: Sealed; compartments: string[] }>(SHARED_NAMES, [a, b]);
    let unreadable = false;
    const names = shared.flatMap((row) => {
      // A name the key file cannot open is told apart, so a gap in the keys is not read as no name.
      try {
        return [open(keys, row, "knowledge.aliases.value_enc", "throw")];
      } catch {
        unreadable = true;
        return [];
      }
    });
    if (names.some(isFullName)) continue;
    thin.push({
      ruling: join.ruling_id,
      a: [...a].sort()[0] ?? null,
      b: [...b].sort()[0] ?? null,
      by: join.kind === "identity_policy" ? "policy" : "owner",
      basis: join.basis,
      reason: unreadable ? "unreadable" : names.length > 0 ? "first_name_only" : "no_shared_name",
      at: join.created_at,
    });
  }
  return thin;
}
