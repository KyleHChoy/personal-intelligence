import { isProfileKey } from "@intelligence/personal-core";
import type { Query } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";
import { open, type Sealed } from "../core/seal.ts";
import type { IdentitySide } from "./identity-points.ts";
import { domainOf } from "./identity-port.ts";

// The `pair` slot for one same_person candidate: each person's names from email aliases, the
// address, its domain, counts and UTC months. Never a contact's field, and nothing of a message
// body. `refs` are what the input rested on: the two address fingerprints and the evidence id of
// each alias whose name was sent. `compartments` are the union of every row read.

type PairPerson = { entity: string; fp: string; compartments: string[] };
export type PairInput = { slot: { a: IdentitySide; b: IdentitySide }; refs: string[]; compartments: string[] };

const NAMES = 5;
const NAME_POINTS = 200;

async function sideOf(
  query: Query,
  keys: Keys,
  person: PairPerson,
): Promise<{ side: IdentitySide; refs: string[]; compartments: string[] } | null> {
  const [account] = await query<{ id: string; value_enc: Sealed; compartments: string[] }>(
    "select id, value_enc, compartments from knowledge.accounts where entity_id = $1 and value_fp = $2 order by id limit 1",
    [person.entity, person.fp],
  );
  const address = account === undefined ? null : open(keys, account, "knowledge.accounts.value_enc", "null");
  if (account === undefined || address === null) return null;
  // An alias whose evidence item is an email; a contact's names are never sent.
  const aliases = await query<{ id: string; evidence_id: string; value_enc: Sealed; compartments: string[] }>(
    `select s.id, s.evidence_id, s.value_enc, s.compartments from knowledge.aliases s join vault.evidence_items e on e.id = s.evidence_id
     where s.entity_id = $1 and e.source_kind = 'email' order by s.id`,
    [person.entity],
  );
  const names: string[] = [];
  const refs: string[] = [];
  const compartments = [...account.compartments];
  for (const alias of aliases) {
    const opened = open(keys, alias, "knowledge.aliases.value_enc", "null");
    if (opened === null) continue;
    const name = [...opened].slice(0, NAME_POINTS).join("");
    if (!names.includes(name)) {
      if (names.length === NAMES) continue;
      names.push(name);
    }
    refs.push(alias.evidence_id);
    compartments.push(...alias.compartments);
  }
  const [counts] = await query<{
    sent: number;
    received: number;
    meetings: number;
    first: string | null;
    last: string | null;
    compartments: string[] | null;
  }>(
    `select (select count(distinct evidence_id)::int from knowledge.interaction_log where entity_id = $1 and direction = 'outbound') as sent,
       (select count(distinct evidence_id)::int from knowledge.interaction_log where entity_id = $1 and direction = 'inbound') as received,
       (select count(distinct event_id)::int from knowledge.event_participants where entity_id = $1) as meetings,
       (select to_char(min(occurred_at) at time zone 'UTC', 'YYYY-MM') from knowledge.interaction_log where entity_id = $1) as first,
       (select to_char(max(occurred_at) at time zone 'UTC', 'YYYY-MM') from knowledge.interaction_log where entity_id = $1) as last,
       (select array_agg(distinct c) from (select unnest(compartments) as c from knowledge.interaction_log where entity_id = $1
          union select unnest(compartments) from knowledge.event_participants where entity_id = $1) as read) as compartments`,
    [person.entity],
  );
  return {
    side: {
      names,
      address,
      // A profile key has no domain.
      domain: isProfileKey(address) ? "" : domainOf(address),
      sent: counts?.sent ?? 0,
      received: counts?.received ?? 0,
      meetings: counts?.meetings ?? 0,
      firstSeen: counts?.first ?? null,
      lastSeen: counts?.last ?? null,
    },
    refs,
    compartments: [...compartments, ...(counts?.compartments ?? [])],
  };
}

// A saved call holds at most 100 refs (vault.decision_calls). The two address fingerprints come
// first; an alias's evidence id past the hundredth is left out, since that message names the person
// as sender or recipient, and its removal reaches the call through the address fingerprint.
const REFS = 100;

// The slot, or null when either address no longer opens (the pair waits for the next sweep).
export async function identityPair(query: Query, keys: Keys, a: PairPerson, b: PairPerson): Promise<PairInput | null> {
  const [one, other] = [await sideOf(query, keys, a), await sideOf(query, keys, b)];
  if (one === null || other === null) return null;
  const evidence = [...new Set([...one.refs, ...other.refs])].sort();
  return {
    slot: { a: one.side, b: other.side },
    refs: [a.fp, b.fp, ...evidence].slice(0, REFS),
    compartments: [...new Set([...one.compartments, ...other.compartments])].sort(),
  };
}
