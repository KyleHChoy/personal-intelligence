import type { IdentityVerdict } from "@intelligence/contracts/personal";
import { byText } from "../core/db.ts";
import type { ClientGroups, Ctx } from "../core/read-ctx.ts";
import { groupOf, groupsOf, type IdentityRuling } from "../identity/groups.ts";

// A client's groups for one call: the people the caller can see, joined by the rulings its token
// returns. One statement in the call's snapshot reads the rulings and the visible people behind
// each fingerprint; groupsOf, the one computation of groups, builds them in code. Nothing is
// opened.

// The token returns a ruling only when it is unlifted, `same` or `shared`, and each of its
// addresses has a person's account row within the caller's clearance. The visible people behind
// every fingerprint the rulings name are read in one grouped read of the accounts, each
// fingerprint's lowest first, and joined back to each side: a side none is behind has none.
const rulings = (where: string): string => `
  with r as (
    select r.verdict, r.a_fp, r.b_fp from knowledge.identity_rulings r${where}
  ),
  people as (
    select a.value_fp, array_agg(distinct a.entity_id order by a.entity_id) as people
    from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id and e.kind = 'person'
    where a.value_fp in (select r.a_fp from r union select r.b_fp from r where r.b_fp is not null)
    group by a.value_fp
  )
  select r.verdict, r.a_fp, r.b_fp, coalesce(pa.people, '{}') as a_people, coalesce(pb.people, '{}') as b_people
  from r
  left join people pa on pa.value_fp = r.a_fp
  left join people pb on pb.value_fp = r.b_fp
  order by r.a_fp, r.b_fp nulls first, r.verdict`;
export const RULINGS = rulings("");

// The owner's page reads them as pi_admin, whose policy returns lifted rulings
// too: those are left out here, as the token's row policy leaves them out for a client.
const OWNER_RULINGS = rulings("\n  where r.lifted_at is null");

// One visible ruling and the visible people behind each of its fingerprints. The warmth build
// reads the same rows for one audience (warmth-build.ts) and builds its groups here.
export type GroupRulingRow = {
  verdict: IdentityVerdict;
  a_fp: string;
  b_fp: string | null;
  a_people: string[];
  b_people: string[];
};
type Row = GroupRulingRow;

// `owner`: read as pi_admin for the owner's own page. Read once per call: a call's Ctx carries
// `groups`, made fresh with it, and the second read of the same groups is the first's, the
// owner's apart from a client's. A Ctx without one reads each time.
export async function loadGroups(ctx: Ctx, options?: { owner: true }): Promise<ClientGroups> {
  const owner = options?.owner === true;
  const read = async (): Promise<ClientGroups> =>
    groupsFromRows(await ctx.run<Row>(owner ? OWNER_RULINGS : RULINGS, []));
  const memo = ctx.groups;
  if (memo === undefined) return read();
  const which = owner ? "owner" : "client";
  return (memo[which] ??= read());
}

// The groups of these ruling rows: groupsOf, the one computation of groups, and the visible people.
export function groupsFromRows(rows: readonly Row[]): ClientGroups {
  const rulings: IdentityRuling[] = rows.map((row, i) => ({
    id: `r${i}`,
    verdict: row.verdict,
    aFp: row.a_fp,
    bFp: row.b_fp,
    liftedAt: null,
  }));
  const groups = groupsOf(rulings, []);
  const peopleOf = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const [fp, people] of [
      [row.a_fp, row.a_people],
      ...(row.b_fp === null ? [] : [[row.b_fp, row.b_people] as const]),
    ] as const) {
      const known = peopleOf.get(fp) ?? new Set<string>();
      for (const person of people) known.add(person);
      peopleOf.set(fp, known);
    }
  }
  const members = new Map<string, string[]>();
  const fpsOf = new Map<string, string[]>();
  for (const [fp, people] of peopleOf)
    for (const person of people) fpsOf.set(person, [...(fpsOf.get(person) ?? []), fp]);
  for (const [person, fps] of fpsOf) {
    const all = new Set<string>();
    for (const fp of fps)
      for (const one of groupOf(groups, fp)) for (const other of peopleOf.get(one) ?? []) all.add(other);
    all.add(person);
    members.set(person, [...all].sort(byText));
  }
  const sharedFps = new Set(rows.filter((row) => row.verdict === "shared").map((row) => row.a_fp));
  const sharedPeople = new Set([...sharedFps].flatMap((fp) => [...(peopleOf.get(fp) ?? [])]));
  const membersOf = (id: string): string[] => members.get(id) ?? [id];
  const joined = [...members]
    .filter(([, all]) => all.length > 1)
    .map(([person, all]) => [person, all[0] ?? person] as const)
    .sort(([a], [b]) => byText(a, b));
  return {
    joined,
    empty: rows.length === 0,
    membersOf,
    idOf: (id) => membersOf(id)[0] ?? id,
    shared: (id) => membersOf(id).some((one) => sharedPeople.has(one)),
  };
}
