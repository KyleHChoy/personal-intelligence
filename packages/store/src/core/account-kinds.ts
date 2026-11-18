import {
  type AccountKind,
  ADDRESS_MARKS,
  type AddressMark,
  type ReclassifyCounts,
} from "@intelligence/contracts/personal";
import { isProfileKey } from "@intelligence/personal-core";
import { addressKind } from "@intelligence/personal-core/items";
import type { Query } from "./db.ts";
import { open, type Sealed } from "./seal.ts";
import type { Tx } from "./tx.ts";

// Account kinds. An address's kind is addressKind's
// answer over the one pinned list, with the owner's mark on the address deciding over it. The
// identity port asks it of every new address and makes no person for one that is not `email`;
// `reclassify` sets it on stored account rows. Nothing here edits or deletes a claim: a person
// left with no person's account is withheld from every reader by policy.entity_withheld,
// and the claims that name it stay as they are.

// The kinds that are a person's. The database's policy.entity_withheld holds the same two.
export const PERSON_KINDS: readonly AccountKind[] = ["email", "shared"];
export const makesPerson = (kind: AccountKind): boolean => PERSON_KINDS.includes(kind);

// The owner's live mark on one address, by its fingerprint, or null.
export async function markOf(query: Query, fp: string): Promise<AddressMark | null> {
  const [row] = await query<{ verdict: AddressMark }>(
    "select verdict from knowledge.identity_rulings where a_fp = $1 and b_fp is null and lifted_at is null and verdict = any($2)",
    [fp, [...ADDRESS_MARKS]],
  );
  return row?.verdict ?? null;
}

// What a mark makes an address, whatever its shape: every mark decides alone.
const kindOfMark = (mark: AddressMark): AccountKind => addressKind("", mark);

// A mark's kind on every person's account row of the address, in the caller's transaction: the
// owner's ruling takes effect with it. The owner's own rows are never changed.
export async function markAccounts(query: Query, fp: string, mark: AddressMark): Promise<void> {
  await query(
    `update knowledge.accounts a set kind = $2 from knowledge.entities e
     where e.id = a.entity_id and e.kind = 'person' and a.value_fp = $1 and a.kind <> $2`,
    [fp, kindOfMark(mark)],
  );
}

type AccountRow = {
  id: string;
  entity_id: string;
  kind: AccountKind;
  value_fp: string;
  value_enc: Sealed;
  compartments: string[];
};

// E9: every person's account row, or those of the people holding one of `fps`, given the kind
// addressKind gives it now. A dry run counts and writes nothing; a commit sets the kinds that
// changed. `hidden` and `shown` count the people whose having a person's account changes, and
// `claims` the claims that name them, which stay as they are.
export async function reclassify(
  tx: Tx,
  options: { fps?: readonly string[]; commit: boolean },
): Promise<ReclassifyCounts> {
  const scope = options.fps === undefined ? null : [...options.fps];
  const rows = await tx.query<AccountRow>(
    `select a.id, a.entity_id, a.kind, a.value_fp, a.value_enc, a.compartments from knowledge.accounts a
     join knowledge.entities e on e.id = a.entity_id and e.kind = 'person'
     where $1::text[] is null or a.entity_id in (select h.entity_id from knowledge.accounts h where h.value_fp = any($1::text[]))
     order by a.id
     for update of a`,
    [scope],
  );
  const marks = new Map(
    (
      await tx.query<{ a_fp: string; verdict: AddressMark }>(
        "select a_fp, verdict from knowledge.identity_rulings where b_fp is null and lifted_at is null and verdict = any($1)",
        [[...ADDRESS_MARKS]],
      )
    ).map((row) => [row.a_fp, row.verdict]),
  );
  const changed = new Map<AccountKind, string[]>();
  const before = new Map<string, boolean>();
  const after = new Map<string, boolean>();
  for (const row of rows) {
    const address = open(tx.keys, row, "knowledge.accounts.value_enc", "throw");
    // A profile key is a person's, as the writer holds it: no list reads it.
    const kind = isProfileKey(address) ? "email" : addressKind(address, marks.get(row.value_fp));
    if (kind !== row.kind) changed.set(kind, [...(changed.get(kind) ?? []), row.id]);
    before.set(row.entity_id, (before.get(row.entity_id) ?? false) || makesPerson(row.kind));
    after.set(row.entity_id, (after.get(row.entity_id) ?? false) || makesPerson(kind));
  }
  const moved = [...before.keys()].filter((entity) => before.get(entity) !== after.get(entity));
  const [claims] = await tx.query<{ n: number }>(
    "select count(distinct claim_id)::int as n from knowledge.claim_entities where entity_id = any($1)",
    [moved],
  );
  if (options.commit) {
    for (const [kind, ids] of changed)
      await tx.query("update knowledge.accounts set kind = $2 where id = any($1)", [ids, kind]);
  }
  return {
    accounts: [...changed.values()].reduce((sum, ids) => sum + ids.length, 0),
    hidden: moved.filter((entity) => before.get(entity) === true).length,
    shown: moved.filter((entity) => after.get(entity) === true).length,
    claims: claims?.n ?? 0,
    committed: options.commit,
  };
}
