import { type Mention, RequestId, Timestamp } from "@intelligence/contracts";
import { keepAlias } from "../core/aliases.ts";
import { stamp } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { notOwnerAddress } from "../core/statements.ts";
import type { Tx } from "../core/tx.ts";
import { anySuppressedUnder } from "../core/vocabulary.ts";
import type { identityPort } from "./identity-port.ts";

// The core of the participant step: one name, under one label,
// bound by code to a person or made one. Model output never chooses a binding (invariant 5).
// `participant-binding.ts` calls it for a meeting's or a chat's participants; what a caller varies
// is only its key, its scope, its event (a ranking signal only a meeting has) and its daily cap.

// The people a name may be, under the item's compartments, best first: a participant of the
// meeting's linked event, then one a stored contact lists, then one the owner has written to,
// then the lower id, each signal read under the item's compartments alone (invariant 6); less the
// people the owner's lifts excluded.
const CANDIDATES = `
  select s.entity_id from knowledge.aliases s
  join knowledge.entities e on e.id = s.entity_id and e.kind = 'person'
  where s.value_fp = $1 and s.compartments <@ $2::text[]
    -- A one-word name never takes a named person as a candidate, so a meeting's "Theo" is not
    -- bound to the "Theo" one speaker named (SD-R6: a one-word named person is its speaker's,
    -- keyed by them).
    and not ($5::boolean and e.named)
    and not exists (
      select 1 from knowledge.mention_bindings b join knowledge.accounts a on a.value_fp = b.address_fp
      where b.mention_fp = $1 and b.lifted_at is not null and a.entity_id = s.entity_id and b.evidence_id = any($4::text[]))
  group by s.entity_id
  order by
    bool_or(exists (select 1 from knowledge.event_participants p where p.event_id = $3 and p.entity_id = s.entity_id and p.compartments <@ $2::text[])) desc,
    bool_or(exists (select 1 from knowledge.contact_addresses k where k.entity_id = s.entity_id and k.compartments <@ $2::text[])) desc,
    bool_or(exists (select 1 from knowledge.interaction_log i where i.entity_id = s.entity_id and i.direction = 'outbound' and i.compartments <@ $2::text[])) desc,
    s.entity_id collate "C"`;

// The address a binding names, as the owner's bind chooses it (admin-mentions.ts): the person's
// lowest account fingerprint under the compartments that is not the owner's and no other person
// holds. Null when there is none.
export const ADDRESS = `
  select min(a.value_fp) as fp from knowledge.accounts a
  where a.entity_id = $1 and a.compartments <@ $2::text[]
    and ${notOwnerAddress("a.value_fp")}
    and not exists (select 1 from knowledge.accounts o join knowledge.entities p on p.id = o.entity_id and p.kind = 'person' where o.value_fp = a.value_fp and o.entity_id <> a.entity_id)`;

// The writer's port asked for the person an address (or a made key) names, under the caller's
// request id. Both the participant step's addresses and bindName's made keys ask through it.
export const askAddress = (port: ReturnType<typeof identityPort>, value: string, now: Date, requestId: string) =>
  port.resolver.resolve(
    { key: { kind: "address", value }, observedAt: Timestamp.parse(stamp(now)) } as Mention,
    "people",
    RequestId.parse(requestId),
  );

export type NameCounts = { bound: number; ambiguous: number; created: number; skipped: number; capped: number };

// The item a name was read from: its evidence, its source item's fingerprint, every revision of it
// (for the owner's lifts) and its label.
type NameItem = { evidenceId: string; sourceItemFp: string; revisions: string[]; label: string[] };

export type NameRules = {
  scope: string;
  requestId: string;
  key: (sourceId: string) => string | null;
  eventId: string | null;
  cap: { full(): Promise<boolean>; made(entity: string): void | Promise<void> };
  keyOnly?: true;
};

// Binds a name not bound live, and not the owner's, to the first candidate with an address the
// label can name, or makes a person by its key and binds to them. True when it wrote a binding.
export async function bindName(
  tx: Tx,
  port: ReturnType<typeof identityPort>,
  item: NameItem,
  name: string,
  rules: NameRules,
  now: Date,
  counts: NameCounts,
): Promise<boolean> {
  const label = item.label;
  const nameFp = fingerprint(tx.keys, "name", name);
  const candidates =
    rules.keyOnly === true
      ? []
      : await tx.query<{ entity_id: string }>(CANDIDATES, [
          nameFp,
          label,
          rules.eventId,
          item.revisions,
          !/\s/u.test(name.trim()),
        ]);
  let addressFp: string | null = null;
  for (const candidate of candidates) {
    const [row] = await tx.query<{ fp: string | null }>(ADDRESS, [candidate.entity_id, label]);
    if (row?.fp !== null && row?.fp !== undefined) {
      addressFp = row.fp;
      break;
    }
  }
  if (candidates.length > 1) counts.ambiguous += 1;
  // A person of the name whose every address this label cannot name is no one to make again; the
  // name waits, filed for the owner.
  if (addressFp === null && candidates.length > 0) {
    counts.skipped += 1;
    return false;
  }
  if (addressFp === null) {
    // No one to bind: a new person by the name, unless the owner's erasure suppressed it.
    // A name the owner's erasure suppressed under a compartment of the item's label.
    const suppressed = rules.keyOnly !== true && (await anySuppressedUnder(tx.query, [nameFp], label));
    if (suppressed) {
      counts.skipped += 1;
      return false;
    }
    const [lifts] = await tx.query<{ n: number }>(
      "select count(*)::int as n from knowledge.mention_bindings where mention_fp = $1 and lifted_at is not null and evidence_id = any($2::text[])",
      [nameFp, item.revisions],
    );
    const split = lifts?.n ?? 0;
    // The owner outranks it (invariant 11): after the owner's lifts, the person made is keyed by the item and
    // the count of lifts, so `pi identity unbind` splits it.
    const key = rules.key(
      fingerprint(tx.keys, "source_id", split === 0 ? rules.scope : `${rules.scope}\n${item.sourceItemFp}\n${split}`),
    );
    if (key === null) return false;
    // The forgery bound: a person not yet made, past the day's people, waits.
    const [held] = await tx.query<{ yes: boolean }>(
      "select exists (select 1 from knowledge.accounts where value_fp = $1) as yes",
      [fingerprint(tx.keys, "address", key)],
    );
    if (held?.yes !== true && (await rules.cap.full())) {
      counts.capped += 1;
      return false;
    }
    const answer = await askAddress(port, key, now, rules.requestId);
    if (answer.outcome !== "created" && answer.outcome !== "linked") {
      counts.skipped += 1;
      return false;
    }
    await port.write(label);
    if (answer.outcome === "created") {
      counts.created += 1;
      await rules.cap.made(answer.entity);
    }
    await keepAlias(tx, { entity: answer.entity, nameFp, evidenceId: item.evidenceId, name, label });
    addressFp = fingerprint(tx.keys, "address", key);
  }
  await tx.query(
    "insert into knowledge.mention_bindings (id, ruling_id, origin, evidence_id, mention_fp, address_fp, created_at, compartments) values ($1, null, 'code', $2, $3, $4, $5, $6)",
    [newId("mbd"), item.evidenceId, nameFp, addressFp, stamp(now), label],
  );
  counts.bound += 1;
  return true;
}
