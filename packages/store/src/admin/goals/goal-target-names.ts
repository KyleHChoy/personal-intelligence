import {
  type EntityId,
  FiledMention,
  type GoalId,
  type PersonalCompartment,
  type RulingId,
  sortedLabel,
} from "@intelligence/contracts/personal";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { newId } from "../../core/ids.ts";
import type { Keys } from "../../core/keys.ts";
import { GOAL_TARGET_ORG_FIELD, orgNameFp } from "../../core/org-names.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { open, type Sealed, sealUnder } from "../../core/seal.ts";
import { commandItem, goalKeyOf } from "./goal-claims.ts";
import { writeCommandEvidence } from "./owner-command.ts";

// The people an alias of whose under the label has the name's fingerprint, as admin-mentions.ts lists
// candidates: one a stored contact lists, then one the owner has written to, then the lower id, each
// signal read under the label alone (invariant 6). `named`: a named person.
const HOLDERS = `
  select e.id as entity_id, e.named,
    exists (select 1 from knowledge.contact_addresses k where k.entity_id = e.id and k.compartments <@ $2::text[]) as on_contact,
    exists (select 1 from knowledge.interaction_log i where i.entity_id = e.id and i.direction = 'outbound' and i.compartments <@ $2::text[]) as written_to
  from knowledge.entities e
  where e.kind = 'person' and exists (select 1 from knowledge.aliases s where s.entity_id = e.id and s.value_fp = $1 and s.compartments <@ $2::text[])
  order by on_contact desc, written_to desc, e.id collate "C"`;

// The organizations holding a name under the label: a name row, or a name the owner gave one.
const ORG_HOLDERS = `
  select distinct o.entity_id, e.named from knowledge.org_names o
  join knowledge.entities e on e.id = o.entity_id and e.kind = 'organization'
  where o.name_fp = $1 and o.compartments <@ $2::text[]
  order by o.entity_id`;
const OWNER_NAMED_ORGS = `
  select n.id, n.name_enc, n.compartments, min(d.entity_id) as entity_id, bool_or(e.named) as named
  from knowledge.organization_names n
  join knowledge.domains d on d.domain_fp = n.domain_fp and d.compartments <@ $1::text[]
  join knowledge.entities e on e.id = d.entity_id and e.kind = 'organization'
  where n.lifted_at is null and n.compartments <@ $1::text[]
  group by n.id, n.name_enc, n.compartments
  order by n.id`;

// The newest row of each holder under the label alone (invariant 6).
const LAST_SEEN = `
  select i.entity_id, max(i.occurred_at) as at from knowledge.interaction_log i
  where i.entity_id = any ($1::text[]) and i.compartments <@ $2::text[]
  group by i.entity_id
  order by i.entity_id`;

// `lastSeen`: holders share the name, so when each was last seen tells the owner which is which.
type NameHolder = { entity: EntityId; established: boolean; named: boolean; lastSeen: string | null };
export type GoalNameHolder = NameHolder;
export type GoalNameTarget =
  | { kind: "holders"; holders: NameHolder[] }
  | { kind: "set"; entity: EntityId }
  | { kind: "pending" };

const oneWordName = (name: string): boolean => !/\s/u.test(name.trim());

async function nameHolders(query: Query, keys: Keys, name: string, label: readonly string[]): Promise<NameHolder[]> {
  const rows = await query<{ entity_id: EntityId; named: boolean; on_contact: boolean; written_to: boolean }>(HOLDERS, [
    fingerprint(keys, "name", name),
    [...label],
  ]);
  return withLastSeen(
    query,
    rows.map((row) => ({ entity: row.entity_id, established: row.on_contact || row.written_to, named: row.named })),
    label,
  );
}

async function withLastSeen(
  query: Query,
  holders: Omit<NameHolder, "lastSeen">[],
  label: readonly string[],
): Promise<NameHolder[]> {
  if (holders.length === 0) return [];
  const seen = new Map(
    (await query<{ entity_id: string; at: Date }>(LAST_SEEN, [holders.map((one) => one.entity), [...label]])).map(
      (row) => [row.entity_id, stamp(row.at)],
    ),
  );
  return holders.map((one) => ({ ...one, lastSeen: seen.get(one.entity) ?? null }));
}

async function orgHolders(query: Query, keys: Keys, name: string, label: readonly string[]): Promise<NameHolder[]> {
  const nameFp = orgNameFp(keys, name);
  const holders = new Map<string, boolean>();
  for (const row of await query<{ entity_id: string; named: boolean }>(ORG_HOLDERS, [nameFp, [...label]]))
    holders.set(row.entity_id, row.named);
  for (const row of await query<{
    id: string;
    name_enc: Sealed;
    compartments: string[];
    entity_id: string;
    named: boolean;
  }>(OWNER_NAMED_ORGS, [[...label]])) {
    const named = open(keys, row, "knowledge.organization_names.name_enc", "throw");
    if (orgNameFp(keys, named) === nameFp) holders.set(row.entity_id, row.named);
  }
  // An organization has no contact or thread of its own: being one the owner's sources or words name is
  // what `established` says of it.
  return withLastSeen(
    query,
    [...holders].map(([entity, named]) => ({ entity: entity as EntityId, established: !named, named })),
    label,
  );
}

// The goal_target decision and the state row, as setGoalTarget writes them, in the caller's
// transaction; `named` for a target pending on a name. False for a repeated request id.
async function writeTarget(
  query: Query,
  input: {
    goal: GoalId;
    entity: EntityId | null;
    named?: { item: string; name: string };
    id: RulingId;
    requestId: string;
    compartments: PersonalCompartment[];
    now: Date;
  },
): Promise<boolean> {
  const fact = await goalKeyOf(query, input.goal);
  const ruling = await ownerDecision(
    query,
    {
      id: input.id,
      requestId: input.requestId,
      kind: "goal_target",
      target: { kind: "goal", id: input.goal },
      details: {
        entity: input.entity,
        ...(fact === undefined ? {} : { fact }),
        ...(input.named === undefined ? {} : { named: input.named }),
      },
      compartments: input.compartments,
    },
    input.now,
  );
  if (ruling !== input.id) return false;
  await query("update projections.goal_state set target_entity_id = $2 where goal_id = $1", [input.goal, input.entity]);
  return true;
}

// The owner_command item holding the name, and its one filed row, under the goal's label. Its
// evidence id.
async function writeNameItem(
  query: Query,
  keys: Keys,
  input: {
    ruling: RulingId;
    goal: GoalId;
    name: string;
    nameFp: string;
    organization: boolean;
    compartments: string[];
    now: Date;
  },
): Promise<string> {
  const { compartments, name, nameFp, now } = input;
  const { accountId, source, evidenceId } = await commandItem(query, compartments, `goal-target:${input.ruling}`);
  await writeCommandEvidence(
    { query, keys },
    {
      source,
      evidenceId,
      accountId,
      ruling: input.ruling,
      words: name,
      at: now,
      item: { command: "goal_target", goal: input.goal, ruling: input.ruling },
      compartments,
    },
  );
  const id = newId("umn");
  const filed = FiledMention.parse({
    name,
    type: "goal",
    field: input.organization ? GOAL_TARGET_ORG_FIELD : "target",
  });
  await query(
    "insert into vault.unresolved_mentions (id, evidence_id, extractor_generation, name_fp, facts_enc, compartments) values ($1, $2, 0, $3, $4, $5)",
    [
      id,
      evidenceId,
      nameFp,
      sealUnder(
        keys,
        compartments,
        { table: "vault.unresolved_mentions", id, column: "facts_enc" },
        JSON.stringify(filed),
      ),
      compartments,
    ],
  );
  return evidenceId;
}

// Those holding a name under a goal's label, for the owner's card on a proposed target.
export async function targetHolders(
  query: Query,
  keys: Keys,
  input: { goal: GoalId; name: string; organization: boolean },
): Promise<NameHolder[]> {
  const [state] = await query<{ compartments: string[] }>(
    "select compartments from projections.goal_state where goal_id = $1",
    [input.goal],
  );
  if (state === undefined) return [];
  const label = [...new Set(state.compartments)].sort();
  // What the key file cannot open, the card does not read.
  if (!label.every((one) => keys.compartments.has(one))) return [];
  return input.organization ? orgHolders(query, keys, input.name, label) : nameHolders(query, keys, input.name, label);
}

// Those a source's rows make holders of the name now whom the card was not raised with. A name the
// owner gave an organization is their own word, and not among them.
export async function holdersSince(
  query: Query,
  keys: Keys,
  input: { goal: GoalId; name: string; organization: boolean; raisedWith: readonly string[] },
): Promise<string[]> {
  const [state] = await query<{ compartments: string[] }>(
    "select compartments from projections.goal_state where goal_id = $1",
    [input.goal],
  );
  if (state === undefined) return [];
  const label = [...new Set(state.compartments)].sort();
  const holders = input.organization
    ? (await query<{ entity_id: string }>(ORG_HOLDERS, [orgNameFp(keys, input.name), label])).map(
        (row) => row.entity_id,
      )
    : (await nameHolders(query, keys, input.name, label)).map((one) => one.entity as string);
  return holders.filter((one) => !input.raisedWith.includes(one));
}

// Null for a goal that does not exist. With `entity`, the person the owner picked, who must hold
// the name under the goal's label (`not_found` otherwise); without it, the holders when there are
// any, else the pending target. A repeated request id writes nothing.
export async function targetGoalByName(
  query: Query,
  keys: Keys,
  input: { goal: GoalId; name: string; organization?: boolean; entity?: EntityId; requestId: string; now: Date },
): Promise<GoalNameTarget | null> {
  const name = input.name.trim();
  const organization = input.organization === true;
  if (name === "" || (!organization && oneWordName(name)) || [...name].length > 200)
    throw new AdminError("invalid_argument");
  const [state] = await query<{ compartments: PersonalCompartment[] }>(
    "select compartments from projections.goal_state where goal_id = $1",
    [input.goal],
  );
  if (state === undefined) return null;
  const label = sortedLabel(state.compartments);
  if (!label.every((one) => keys.compartments.has(one))) throw new AdminError("unknown_compartment");
  const holders = organization
    ? await orgHolders(query, keys, name, label)
    : await nameHolders(query, keys, name, label);
  if (input.entity !== undefined) {
    if (!holders.some((one) => one.entity === input.entity)) throw new AdminError("not_found");
    await writeTarget(query, {
      goal: input.goal,
      entity: input.entity,
      id: newId("rul") as RulingId,
      requestId: input.requestId,
      compartments: label,
      now: input.now,
    });
    return { kind: "set", entity: input.entity };
  }
  if (holders.length > 0) return { kind: "holders", holders };
  const id = newId("rul") as RulingId;
  const nameFp = organization ? orgNameFp(keys, name) : fingerprint(keys, "name", name);
  const [repeated] = await query<{ id: string }>("select id from knowledge.owner_decisions where request_id = $1", [
    input.requestId,
  ]);
  if (repeated !== undefined) return { kind: "pending" };
  const item = await writeNameItem(query, keys, {
    ruling: id,
    goal: input.goal,
    name,
    nameFp,
    organization,
    compartments: label,
    now: input.now,
  });
  await writeTarget(query, {
    goal: input.goal,
    entity: null,
    named: { item, name: nameFp },
    id,
    requestId: input.requestId,
    compartments: label,
    now: input.now,
  });
  return { kind: "pending" };
}
