import type { ClaimRecord } from "@intelligence/contracts/personal";
import { claimKey, fingerprint } from "./fingerprint.ts";
import type { Keys } from "./keys.ts";
import { labelKey } from "./labels.ts";
import type { Tx } from "./tx.ts";

// What every claim writer stores beside a claim. Its end, due and review dates in clear columns of
// knowledge.claims, and one knowledge.claim_values row for each key the claim is known by, with the
// keyed fingerprint of its normalized values.

// The field that holds a claim's due date, by claim type; a type not named has none. The end is the
// `until` field and the review date the `review` field, of any type.
const DUE_FIELD: Readonly<Record<string, string>> = { commitment: "due", goal: "by", need: "by" };
const END_FIELD = "until";
const REVIEW_FIELD = "review";

// A date field as an instant: a day alone is that day's start in UTC; anything that is not a
// date or a timestamp is none.
export function instantOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const at = Date.parse(day === null ? value : `${value}T00:00:00.000Z`);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

type ClaimDates = { validTo: string | null; dueAt: string | null; reviewAt: string | null };

// The claim's end (its `validTo`, else its `until` field), its due date and its review date.
export function claimDates(record: Pick<ClaimRecord, "claim">): ClaimDates {
  const { content } = record.claim;
  const due = DUE_FIELD[content.type];
  return {
    validTo: instantOf(record.claim.validTo) ?? instantOf(content.fields[END_FIELD]),
    dueAt: due === undefined ? null : instantOf(content.fields[due]),
    reviewAt: instantOf(content.fields[REVIEW_FIELD]),
  };
}

// The canonical form of a value: a text in NFKC, trimmed, its white space collapsed and lower
// case; an object's keys sorted. Two claims that say the same thing in other spacing or case
// give one form.
function canonical(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFKC").trim().split(/\s+/).join(" ").toLowerCase();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, canonical(object[key])]),
    );
  }
  return value;
}

// Item 12a: the keyed `value` fingerprint of a claim's type, fields and end. It is compared only
// beside an equal fact key, so it holds every field, the key fields the fact key already fixes
// among them: two claims of one fact key and one value fingerprint say exactly the same.
export const valueFpOf = (keys: Keys, record: Pick<ClaimRecord, "claim">): string =>
  fingerprint(
    keys,
    "value",
    JSON.stringify(
      canonical({
        type: record.claim.content.type,
        fields: record.claim.content.fields,
        validTo: record.claim.validTo ?? null,
      }),
    ),
  );

// Every claim key a claim is known by: its own fact key's and each version 1 key's beside it,
// each over its evidence id (the agent_claim fingerprint, stable across a generation raise):
// made with core/fingerprint.ts's claimKey, so this file imports no reader.
export const claimKeysOf = (
  tx: Pick<Tx, "keys">,
  evidenceId: string,
  factKeyFps: readonly (string | null)[],
): string[] => [
  ...new Set(factKeyFps.filter((fp): fp is string => fp !== null).map((fp) => claimKey(tx.keys, evidenceId, fp))),
];

// A fingerprint holds the claim's type, so an equal one is the same type and value; the fact key is
// left out, so a key version's re-keying keeps the time; the label is in, so a claim never takes a
// time from one under another label (invariant 6). Each time is fixed-width UTC text to the
// microsecond, which orders as it sorts and loses no precision on the way back in.
export type FirstKnown = ReadonlyMap<string, string>;

export const carryKey = (valueFp: string, compartments: readonly string[]): string =>
  `${valueFp}\n${labelKey(compartments)}`;

// The same, in SQL: each value row of the claims `where` names, as (evidence_id, key,
// first_known_at) rows `k`, and the earliest time of a group of them.
export const carryRows = (where: string): string => `
  select c.evidence_id, v.value_fp || chr(10) || array_to_string(array(select distinct x collate "C" from unnest(c.compartments) as x order by 1), '|') as key, c.first_known_at
  from knowledge.claims c join knowledge.claim_values v on v.claim_id = c.id
  where ${where}`;
export const CARRY_AT = `to_char(min(k.first_known_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// The earliest first-known time of each value of these claims, read before they are removed. A
// claim with no value row carries nothing.
export async function firstKnownOf(tx: Pick<Tx, "query">, claimIds: readonly string[]): Promise<Map<string, string>> {
  if (claimIds.length === 0) return new Map();
  const rows = await tx.query<{ key: string; at: string }>(
    `select k.key, ${CARRY_AT} as at from (${carryRows("c.id = any ($1)")}) k group by k.key`,
    [claimIds],
  );
  return new Map(rows.map((row) => [row.key, row.at]));
}

// Two carries as one, the earlier time where both hold a key.
export function earliest(a: FirstKnown, b: FirstKnown): Map<string, string> {
  const out = new Map(a);
  for (const [key, at] of b) {
    const had = out.get(key);
    if (had === undefined || at < had) out.set(key, at);
  }
  return out;
}

// The claim's value rows, written in the claim's transaction under the claim's own label.
export async function insertClaimValues(
  tx: Tx,
  claim: {
    id: string;
    evidenceId: string;
    factKeyFps: readonly (string | null)[];
    compartments: readonly string[];
    valueFp: string;
  },
): Promise<void> {
  await tx.query(
    `insert into knowledge.claim_values (claim_id, claim_key, value_fp, compartments)
     select $1, k.key, $3, $4 from unnest($2::text[]) as k (key) order by k.key collate "C"`,
    [claim.id, claimKeysOf(tx, claim.evidenceId, claim.factKeyFps), claim.valueFp, claim.compartments],
  );
}

export const legacyFactKeyFps = (tx: Pick<Tx, "keys">, record: ClaimRecord): [string | null, string | null] => [
  record.legacyFactKey === undefined ? null : fingerprint(tx.keys, "fact", record.legacyFactKey),
  record.legacyAltFactKey === undefined ? null : fingerprint(tx.keys, "fact", record.legacyAltFactKey),
];
