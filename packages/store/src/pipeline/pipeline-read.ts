import { BELIEF_TYPES, isRestricted, ownLabel } from "@intelligence/contracts/personal";
import { isPhoneKey, MEETING_KEY_PREFIX, NAMED_KEY_PREFIX, normalizeAddress } from "@intelligence/personal-core";
import { byText, type Query } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import type { Keys } from "../core/keys.ts";
import { open, type Sealed } from "../core/seal.ts";
import { NOT_CANARY_SQL } from "../core/statements.ts";
import type { StatusFacts } from "../core/status-facts.ts";

// What the pipeline, the admin and coverage share about extraction: the owner's audience, claim
// keys and the owner's confirmations, and the test that leaves an item due (the status row an
// item seals is core/status-facts.ts); and the pipeline's own small reads. Nothing here writes.

// The owner's audience as the pipeline's processes read it: every compartment of the stored claims of a type that builds a belief and that no ruling in force removes, sorted, read through
// the definers the pipeline holds. A claim is removed by a reject of its item and its fact key or a version 1 key of it (as beliefClaims leaves one out); a veto or a retire keeps its claims,
// since a veto counts only for an audience that holds its whole label. The same rule as the owner's own reads (core/audience.ts), which pi_admin runs on the rulings table itself. A finding
// the owner has not confirmed is counted: whether they have is read by a function only pi_pipeline may call, and an extra compartment with no counted claim changes no belief. The standing
// check's compartments are never the owner's.
export async function ownerAudienceOf(query: Query): Promise<string[]> {
  const rows = await query<{ compartment: string }>(
    `select distinct x collate "C" as compartment
     from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id
     cross join unnest(c.compartments) as x
     where c.type = any ($1::text[]) and ${NOT_CANARY_SQL}
       and not exists (select 1 from policy.rejected_claims() r
                       where r.source_account_id = e.source_account_id and r.source_item_fp = e.source_item_fp
                         and r.fact_key_fp in (c.fact_key_fp, c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp))
     order by 1`,
    [[...BELIEF_TYPES]],
  );
  return rows.map((row) => row.compartment).sort(byText);
}

// policy.confirmed_claims takes at most this many keys in one call.
const CONFIRMED_PAGE = 1000;

// The claim keys of `keys` the owner confirmed, asked in pages.
export async function confirmedKeys(query: Query, keys: string[]): Promise<Set<string>> {
  const asked = [...new Set(keys)].sort();
  const confirmed = new Set<string>();
  for (let start = 0; start < asked.length; start += CONFIRMED_PAGE) {
    for (const answer of await query<{ key: string }>("select k as key from policy.confirmed_claims($1) as k", [
      asked.slice(start, start + CONFIRMED_PAGE),
    ]))
      confirmed.add(answer.key);
  }
  return confirmed;
}

// The claim keys of `keys` a second agent confirmed on the card and the owner has not answered or
// reopened: policy.agent_confirmed_claims, in pages.
export async function agentConfirmedKeys(query: Query, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const asked = [...new Set(keys)].sort();
  const confirmed = new Set<string>();
  for (let start = 0; start < asked.length; start += CONFIRMED_PAGE) {
    for (const answer of await query<{ key: string }>("select k as key from policy.agent_confirmed_claims($1) as k", [
      asked.slice(start, start + CONFIRMED_PAGE),
    ]))
      confirmed.add(answer.key);
  }
  return confirmed;
}

// The claim keys of `keys` whose card the owner's confirm, relayed by an agent, answered and the
// owner has not answered or reopened themselves: policy.relayed_claims, in pages.
export async function relayedKeys(query: Query, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const asked = [...new Set(keys)].sort();
  const relayed = new Set<string>();
  for (let start = 0; start < asked.length; start += CONFIRMED_PAGE) {
    for (const answer of await query<{ key: string }>("select k as key from policy.relayed_claims($1) as k", [
      asked.slice(start, start + CONFIRMED_PAGE),
    ]))
      relayed.add(answer.key);
  }
  return relayed;
}

// Of the agent records' evidence ids given, those the owner answered: an answer is the owner's own
// statement, so its claims count as their confirmed ones, with no card. Asked in pages, as the keys
// are.
export async function answeredEvidence(query: Query, evidenceIds: string[]): Promise<Set<string>> {
  const asked = [...new Set(evidenceIds)].sort();
  const answered = new Set<string>();
  for (let start = 0; start < asked.length; start += CONFIRMED_PAGE) {
    for (const row of await query<{ id: string }>("select e as id from policy.answered_records($1) as e", [
      asked.slice(start, start + CONFIRMED_PAGE),
    ]))
      answered.add(row.id);
  }
  return answered;
}

// An item's source compartment: the one of its label that is not restricted.
export const sourceCompartment = (label: readonly string[]): string => label.find((one) => !isRestricted(one)) ?? "";

// The people of those given that the sync's participant step (participant-binding.ts) made by a
// name alone and that nothing else names: every account of theirs is a `profile:meeting/` key. An
// account that does not open is counted as one, so the rule fails closed. A named person's
// `profile:named/` key is one too, so a heard claim naming a named person builds no belief until
// its meeting is linked. `within`: a computed belief's read, held to the accounts a clearance can
// see, and failing closed: a person with no account in it that a source made counts as named only,
// so an account the caller cannot see never vouches for a claim it can (invariant 6). With no
// `within`, the stored build's rule over every account.
export async function namedOnly(
  query: Query,
  keys: Keys,
  entities: readonly string[],
  within?: readonly string[],
): Promise<Set<string>> {
  if (entities.length === 0) return new Set();
  const all = await query<{ id: string; entity_id: string; value_enc: Sealed; compartments: string[] }>(
    "select id, entity_id, value_enc, compartments from knowledge.accounts where entity_id = any($1::text[]) order by id",
    [[...entities]],
  );
  const rows = within === undefined ? all : all.filter((row) => row.compartments.every((one) => within.includes(one)));
  // Only people are bound: the step makes no organization, project or owner from a name. An
  // organization or project holds no account, so under `within` each would count as named only,
  // and an unlinked moment's claim naming one (an affiliation's organization) would be dropped
  // where the stored build keeps it. An id the read does not resolve stays named.
  const others =
    within === undefined
      ? new Set<string>()
      : new Set(
          (
            await query<{ id: string }>(
              "select id from knowledge.entities where id = any($1::text[]) and kind <> 'person' order by id",
              [[...entities]],
            )
          ).map((row) => row.id),
        );
  const minted = (row: (typeof rows)[number]): boolean => {
    try {
      const key = open(keys, row, "knowledge.accounts.value_enc", "throw");
      return key.startsWith(MEETING_KEY_PREFIX) || key.startsWith(NAMED_KEY_PREFIX);
    } catch {
      return true;
    }
  };
  const named = new Set(
    within === undefined ? rows.map((row) => row.entity_id) : entities.filter((id) => !others.has(id)),
  );
  for (const row of rows) if (!minted(row)) named.delete(row.entity_id);
  return named;
}

// Every audience policy.audiences() names.
export async function audiencesOf(query: Query): Promise<string[][]> {
  return (await query<{ audience: string[] }>("select a as audience from policy.audiences() a")).map(
    (row) => row.audience,
  );
}

// The rung suspensions not lifted.
export function suspensionsOf(query: Query): Promise<{ point: string; version: number }[]> {
  return query<{ point: string; version: number }>(
    "select distinct point, version from policy.rung_suspensions where lifted_at is null order by point, version",
  );
}

// The model key alone: the role reads no other secret, and this asks for none.
export async function modelSecret(query: Query, keys: Keys, name: string): Promise<string | null> {
  if (!name.startsWith("openrouter/")) return null;
  const [row] = await query<{ value_enc: Sealed }>("select value_enc from policy.secrets where name = $1", [name]);
  return row === undefined
    ? null
    : open(keys, { id: name, compartments: ownLabel(), value_enc: row.value_enc }, "policy.secrets.value_enc", "throw");
}

export function keyFingerprint(keys: Keys, key: { kind: "address" | "name"; value: string }): string | null {
  if (key.kind === "name") return fingerprint(keys, "name", key.value);
  const address = isPhoneKey(key.value) ? key.value : normalizeAddress(key.value);
  return address === null ? null : fingerprint(keys, "address", address);
}

// What a due item reads of its status row: its attempts, its owner's lane and its release.
export const dueStatus = (status: StatusFacts | undefined) => ({
  attempts: status?.attempts ?? 0,
  ...(status?.laneOverride === undefined ? {} : { lane: status.laneOverride }),
  override: status?.override === true,
});
