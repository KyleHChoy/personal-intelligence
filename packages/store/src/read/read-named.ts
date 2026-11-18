import { Timestamp } from "@intelligence/contracts";
import {
  ClaimRecord,
  type FactId,
  IntroOffer,
  type MentionedBy,
  RelationshipRelation,
} from "@intelligence/contracts/personal";
import { isNamedKey } from "@intelligence/personal-core";
import { stamp } from "../core/db.ts";
import { ORGANIZATION_TYPES } from "../core/org-names.ts";
import type { ClientGroups } from "../core/read-ctx.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import type { SealedRow } from "../core/seal.ts";
import { type AccountRow, served, servedJson } from "../core/served.ts";
import { NAMED_ORG_CLAIMS, ORGANIZATION_CLAIM_SEEN, RELATION_SEEN, RELATION_TYPES } from "./read-fragments.ts";
import { groupWho } from "./read-group-who.ts";
import { ACCOUNTS } from "./read-who.ts";

// The reader tells a named person by its accounts alone: every one it opens is a `profile:named/`
// key (pi_reader is granted no `entities.named`). Every statement here reads under the caller's
// token, and is sent only when a named person is among rows the caller already sees, so a row it
// cannot see changes nothing.

// The relation claims the caller can see that name any of `$1`.
const NAMING = `
  from knowledge.claim_entities n
  join knowledge.claims c on c.id = n.claim_id
  left join knowledge.messages m on m.evidence_id = c.evidence_id
  left join knowledge.documents d on d.evidence_id = c.evidence_id
  left join knowledge.captures k on k.evidence_id = c.evidence_id
  where n.entity_id = any($1::text[]) and ${RELATION_SEEN}`;

// Which of `$1` a relation claim the caller can see names, or a goal it can see targets
// (projections.goal_state's row policy shows a goal to the clients that may read goals).
const NAMED_SEEN = `
  select n.entity_id as id${NAMING}
  union
  select g.target_entity_id as id
  from projections.goal_state g
  where g.target_entity_id = any($1::text[])
  order by id`;

// The newest relation claims naming any of `$1` the caller can see, at most `$3`, with whether a
// capture's claim is of a meeting linked to an event.
const RELATIONS_NAMING = `
  select c.id, c.compartments, c.content_enc, c.valid_from, c.fact_key_fp, n.entity_id as named, k.id is not null and k.event_id is not null as linked${NAMING}
  order by c.valid_from desc, c.id, n.entity_id
  limit $3`;

const MENTIONED_BY = 10;

// Whether accounts, opened, are a named person's: one at least, each a named key.
export const namedBy = (addresses: readonly string[]): boolean => addresses.length > 0 && addresses.every(isNamedKey);

// Of `ids`, those a relation claim the caller can see names or a goal it can see targets.
export async function namedSeen(ctx: Ctx, ids: readonly string[]): Promise<Set<string>> {
  return new Set((await ctx.run<{ id: string }>(NAMED_SEEN, [[...ids], RELATION_TYPES])).map((row) => row.id));
}

// Whether the person whose visible members are `members` is withheld as a named person: their
// accounts are all named keys, and no relation claim or goal the caller sees names any of them.
// One statement, and a second only for a named person.
export async function withheldNamed(ctx: Ctx, members: readonly string[]): Promise<boolean> {
  const accounts = await ctx.run<AccountRow & { entity_id: string }>(ACCOUNTS, [[...members]]);
  if (!namedBy(accounts.map((row) => served(ctx, row, "knowledge.accounts.value_enc").untrusted))) return false;
  return (await namedSeen(ctx, members)).size === 0;
}

const NAMED_ORG_SEEN = `
  select o.entity_id as id
  from ${NAMED_ORG_CLAIMS}
  where o.entity_id = any($1::text[]) and ${ORGANIZATION_CLAIM_SEEN}
  union
  select g.target_entity_id as id
  from projections.goal_state g
  where g.target_entity_id = any($1::text[])
  order by id`;

// Whether the organization has a domain row, and a name row, the caller sees.
const ORG_KEYS = `
  select exists (select 1 from knowledge.domains d where d.entity_id = $1) as domain,
    exists (select 1 from knowledge.org_names o where o.entity_id = $1) as named`;

// Of `ids`, the organizations a claim or a goal the caller can see names.
export async function namedOrgSeen(ctx: Ctx, ids: readonly string[]): Promise<Set<string>> {
  return new Set((await ctx.run<{ id: string }>(NAMED_ORG_SEEN, [[...ids], ORGANIZATION_TYPES])).map((row) => row.id));
}

// Whether an organization is named only (a name row, and no domain the caller sees), and, if so,
// whether it is withheld: no claim or goal the caller sees names it. One statement, and a second
// only for a named organization.
export async function namedOrgState(ctx: Ctx, organization: string): Promise<{ nameOnly: boolean; withheld: boolean }> {
  const [keys] = await ctx.run<{ domain: boolean; named: boolean }>(ORG_KEYS, [organization]);
  if (keys === undefined || keys.domain || !keys.named) return { nameOnly: false, withheld: false };
  return { nameOnly: true, withheld: (await namedOrgSeen(ctx, [organization])).size === 0 };
}

type Naming = SealedRow<"knowledge.claims.content_enc"> & {
  valid_from: Date;
  fact_key_fp: string;
  named: string;
  linked: boolean;
};

// get_entity's `mentionedBy` for a named person's visible members: each relation claim naming them,
// once, newest first, at most MENTIONED_BY: the other side as its introducer, the relation or the
// offer, the fact and its date; a meeting's or a chat's claim not linked to an event marked
// `heard`. A claim whose other side is a member, or one the token does not show, is left out. The
// fact keys served, for the read log.
export async function mentionedByOf(
  ctx: Ctx,
  groups: ClientGroups,
  members: readonly string[],
): Promise<{ mentionedBy: MentionedBy[]; factKeyFps: string[] }> {
  const mine = new Set(members);
  const rows = await ctx.run<Naming>(RELATIONS_NAMING, [[...members], RELATION_TYPES, MENTIONED_BY * members.length]);
  const seen = new Set<string>();
  const lines = rows.flatMap((row) => {
    if (seen.has(row.id)) return [];
    seen.add(row.id);
    const parsed = ClaimRecord.safeParse(servedJson(ctx, row, "knowledge.claims.content_enc"));
    if (!parsed.success) throw new Unavailable();
    const { claim, lane } = parsed.data;
    const { subject, fields } = claim.content;
    const other = claim.content.type === "intro_offer" ? fields.person : fields.counterparty;
    const by = mine.has(subject) ? other : subject;
    if (typeof by !== "string" || mine.has(by)) return [];
    const kind =
      claim.content.type === "intro_offer"
        ? { offer: IntroOffer.parse(fields.offer) }
        : { relation: RelationshipRelation.parse(fields.relation) };
    const heard = (lane === "meeting" || lane === "moment") && !row.linked;
    return [{ row, by: groups.idOf(by), kind, heard }];
  });
  const who = await groupWho(ctx, groups, [...new Set(lines.map((line) => line.by))]);
  const served = lines.flatMap(({ row, by, kind, heard }) => {
    const one = who.get(by);
    return one === undefined
      ? []
      : [
          {
            row,
            line: {
              by: one,
              ...kind,
              fact: row.id as FactId,
              at: Timestamp.parse(stamp(row.valid_from)),
              ...(heard ? { heard: true as const } : {}),
            },
          },
        ];
  });
  const kept = served.slice(0, MENTIONED_BY);
  return {
    mentionedBy: kept.map(({ line }) => line),
    factKeyFps: [...new Set(kept.map(({ row }) => row.fact_key_fp))].sort(),
  };
}
