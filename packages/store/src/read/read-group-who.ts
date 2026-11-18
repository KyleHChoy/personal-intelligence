import type { Who } from "@intelligence/contracts/personal";
import { byText } from "../core/db.ts";
import type { ClientGroups, Ctx } from "../core/read-ctx.ts";
import type { SealedRow } from "../core/seal.ts";
import { type AliasRow, served } from "../core/served.ts";
import { whoOf } from "./read-who.ts";

// A group of records as one person: what its members' contacts and latest names say it is called.

// The visible contacts that list two or more addresses and fewer than CONTACT_LIMITS.addresses
// rows, so none past the twentieth is unknown, every one of them a person of `$1` (the visible
// members of every group asked about), each with the people its addresses name. One statement for
// all the groups: groupContactNames gives a group the contacts all of whose people are its members,
// whose names name the group once a ruling joins them.
const GROUPS_CONTACTS = `
  select c.id, c.compartments, c.facts_enc, c.updated_at, x.people
  from (
    select a.contact_id, array_agg(a.entity_id order by a.entity_id) as people
    from knowledge.contact_addresses a
    where a.contact_id in (select b.contact_id from knowledge.contact_addresses b where b.entity_id = any($1))
    group by a.contact_id
    having count(*) between 2 and 19 and bool_and(a.entity_id = any($1))
  ) x
  join knowledge.contacts c on c.id = x.contact_id
  order by c.id`;

type ContactName = { name: string; at: Date };

// Each group's contact names, in the order of `groups` (each its visible members): what each
// of its contacts' sealed facts hold of its names, by contact id. A group of one has none. Each
// contact is opened once, and only when it names a group.
export async function groupContactNames(ctx: Ctx, groups: readonly (readonly string[])[]): Promise<ContactName[][]> {
  const joined = groups.filter((members) => members.length > 1);
  if (joined.length === 0) return groups.map(() => []);
  const rows = await ctx.run<SealedRow<"knowledge.contacts.facts_enc"> & { updated_at: Date; people: string[] }>(
    GROUPS_CONTACTS,
    [[...new Set(joined.flat())].sort(byText)],
  );
  const opened = new Map<string, ContactName[]>();
  const namesOf = (row: (typeof rows)[number]): ContactName[] => {
    const known = opened.get(row.id);
    if (known !== undefined) return known;
    const facts = JSON.parse(served(ctx, row, "knowledge.contacts.facts_enc").untrusted) as { names?: unknown };
    const names = Array.isArray(facts.names) ? facts.names.filter((one): one is string => typeof one === "string") : [];
    const named = names.map((name) => ({ name, at: row.updated_at }));
    opened.set(row.id, named);
    return named;
  };
  return groups.map((members) => {
    if (members.length < 2) return [];
    const group = new Set(members);
    return rows.filter((row) => row.people.every((person) => group.has(person))).flatMap(namesOf);
  });
}

// The visible alias of the group's members whose evidence is latest, by the time of its message,
// its event or its contact, then by alias id (contacts and identity, "Who"). A held message gives
// no time, in words as well as by the row policy, as in whoOf's LATEST_NAMES.
const GROUP_LATEST_NAME = `
  select s.id, s.compartments, s.value_enc, coalesce(m.sent_at, v.occurred_at, c.updated_at) as at
  from knowledge.aliases s
  left join knowledge.messages m on m.evidence_id = s.evidence_id and not m.held
  left join knowledge.events v on v.evidence_id = s.evidence_id
  left join knowledge.contacts c on c.evidence_id = s.evidence_id
  where s.entity_id = any($1)
  order by at desc nulls last, s.id
  limit 1`;

// Who each id is, for a group as one: its name is the latest of its members' names and contact
// names, and its address its members' first account. A group of one is whoOf's.
export async function groupWho(ctx: Ctx, groups: ClientGroups, ids: string[]): Promise<Map<string, Who>> {
  const members = [...new Set(ids.flatMap((id) => groups.membersOf(id)))];
  const who = await whoOf(ctx, members);
  const out = new Map<string, Who>();
  const known = ids.filter((id) => who.has(id));
  const contactsOf = new Map(
    (
      await groupContactNames(
        ctx,
        known.map((id) => groups.membersOf(id)),
      )
    ).map((names, i) => [known[i] as string, names]),
  );
  for (const id of known) {
    const group = groups.membersOf(id);
    const own = who.get(id);
    if (own === undefined) continue;
    if (group.length < 2) {
      out.set(id, own);
      continue;
    }
    const [alias] = await ctx.run<AliasRow & { at: Date | null }>(GROUP_LATEST_NAME, [group]);
    const contactNames = contactsOf.get(id) ?? [];
    const latestContact = [...contactNames].sort(
      (a, b) => b.at.getTime() - a.at.getTime() || byText(a.name, b.name),
    )[0];
    const aliasName = alias === undefined ? null : served(ctx, alias, "knowledge.aliases.value_enc");
    const name =
      latestContact !== undefined &&
      (aliasName === null || alias?.at === null || (alias?.at?.getTime() ?? 0) < latestContact.at.getTime())
        ? { untrusted: latestContact.name }
        : aliasName;
    const address = group.map((member) => who.get(member)?.address ?? null).find((one) => one !== null) ?? null;
    const { nameOnly: _first, ...rest } = own;
    const nameOnly = group.every((member) => !who.has(member) || who.get(member)?.nameOnly === true);
    out.set(id, { ...rest, name, address, ...(nameOnly ? { nameOnly: true as const } : {}) });
  }
  return out;
}
