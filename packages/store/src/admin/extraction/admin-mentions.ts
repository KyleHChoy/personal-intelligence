import {
  EntityId,
  FactType,
  FiledMention,
  type MentionBindingId,
  type MentionCandidate,
  type MentionId,
  type RulingId,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { byText, stamp } from "../../core/db.ts";
import { newId } from "../../core/ids.ts";
import { BELIEFS_LOCK } from "../../core/locks.ts";
import { GOAL_TARGET_ORG_FIELD } from "../../core/org-names.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { waitToReplay } from "../../core/replay.ts";
import { open, type Sealed } from "../../core/seal.ts";
import { notOwnerAddress } from "../../core/statements.ts";
import { openStatus } from "../../core/status-facts.ts";
import type { Tx } from "../../core/tx.ts";
import { removeClaims } from "../../write/writer-removal.ts";
import { repeatedRuling } from "../admin-base.ts";
import { personOf } from "../rulings/admin-identity.ts";
import { tryExtractLock } from "./admin-extraction.ts";

// Each runs as pi_admin in one transaction, the extract lock tried first: while a run holds it each
// refuses with `extract_running` and changes nothing, so no run that resolved by the old binding can
// commit after the change. A name is never a link: only the owner's binding is, and a model never
// proposes one.

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

type CandidateRow = {
  id: string;
  evidence_id: string;
  count: number;
  compartments: string[];
  facts_enc: Sealed;
  entity_id: string;
  on_contact: boolean;
  written_to: boolean;
};

// Ranked: a person a stored contact lists first, then one the owner has written to, then any other;
// ties by the mention's id, then the person's.
const CANDIDATES = `
  select f.id, f.evidence_id, f.count, f.compartments, f.facts_enc, c.entity_id, c.on_contact, c.written_to
  from (
    select distinct on (u.evidence_id, u.name_fp) u.id, u.evidence_id, u.name_fp, u.compartments, u.facts_enc,
      count(*) over (partition by u.evidence_id, u.name_fp)::int as count
    from vault.unresolved_mentions u
    where u.compartments <@ $2::text[] and not exists (
      select 1 from knowledge.mention_bindings b where b.evidence_id = u.evidence_id and b.mention_fp = u.name_fp and b.lifted_at is null)
    order by u.evidence_id, u.name_fp, u.id collate "C"
  ) f
  cross join lateral (
    select distinct s.entity_id,
      exists (select 1 from knowledge.contact_addresses k where k.entity_id = s.entity_id) as on_contact,
      exists (select 1 from knowledge.interaction_log i where i.entity_id = s.entity_id and i.direction = 'outbound') as written_to
    from knowledge.aliases s
    join knowledge.entities e on e.id = s.entity_id and e.kind = 'person'
    where s.value_fp = f.name_fp and s.compartments <@ f.compartments
  ) c
  order by c.on_contact desc, c.written_to desc, f.id collate "C", c.entity_id collate "C"
  limit $1`;

// What a binding or its lift changes of its item: the item set waiting with its saved calls kept, so
// the next run replays it at no cost and commits its claims by the bindings then in force. A lift
// first removes the claims of the item that name the person the binding named, by the address its
// account rows hold, with their claim entities and the beliefs resting on them, under the beliefs
// lock: a claim's id is made from the mention before identity resolves it, and `commit` keeps an id
// already stored, so a claim made by the lifted binding would otherwise stand through a bind to
// another person before any run. Claims are removed and made again from the same evidence, never
// edited (invariant 3); the item's other claims and beliefs are left as they are, so nothing
// unrelated is gone until the run, or reported as new by it. A bind removes nothing: no claim could
// stand on a name no binding resolved, and a lift before it removed what one did. The evidence row is
// taken `for share` before the beliefs lock, in the order every deletion path takes them. A moment's
// saved calls' other moments are set waiting with it, so the group they were asked in forms again and
// its call replays: the owner's bind of a source moment's handle resolves its held claims with no new
// model call.
async function replayItem(tx: Tx, evidenceId: string, lifted?: { addressFp: string }): Promise<void> {
  await tx.query("select id from vault.evidence_items where id = $1 for share", [evidenceId]);
  if (lifted !== undefined) {
    await tx.query(BELIEFS_LOCK);
    const claims = await tx.query<{ id: string }>(
      `select distinct c.id from knowledge.claims c
       join knowledge.claim_entities n on n.claim_id = c.id
       join knowledge.accounts a on a.entity_id = n.entity_id
       where c.evidence_id = $1 and a.value_fp = $2
       order by c.id`,
      [evidenceId, lifted.addressFp],
    );
    await removeClaims(
      tx.query,
      claims.map((row) => row.id),
    );
  }
  const mates = await tx.query<{ evidence_id: string }>(
    "select distinct o.evidence_id from vault.model_call_members m join vault.model_call_members o on o.call_id = m.call_id where m.evidence_id = $1 and o.evidence_id <> $1",
    [evidenceId],
  );
  await waitToReplay(tx, [evidenceId, ...mates.map((row) => row.evidence_id)]);
}

// Every filed row counted by its type and field, opened from its sealed facts, and its clear
// `has_speaker` and `first_hand`, so the owner sees how much the binding step will bind before the
// prompt that asks for more ships. Counts and code words, no name.
type MentionSummaryRow = {
  type: FactType;
  field: string;
  hasSpeaker: boolean;
  firstHand: boolean;
  count: number;
};
export async function summarizeMentions(admin: AdminContext): Promise<MentionSummaryRow[]> {
  return admin.transaction(async (query) => {
    const rows = await query<{
      id: string;
      compartments: string[];
      facts_enc: Sealed;
      has_speaker: boolean;
      first_hand: boolean;
    }>(
      'select id, compartments, facts_enc, has_speaker, first_hand from vault.unresolved_mentions where compartments <@ $1::text[] order by id collate "C"',
      [[...admin.keys.compartments.keys()]],
    );
    const counts = new Map<string, MentionSummaryRow>();
    for (const row of rows) {
      const facts = FiledMention.parse(
        JSON.parse(open(admin.keys, row, "vault.unresolved_mentions.facts_enc", "throw")),
      );
      const key = JSON.stringify([facts.type, facts.field, row.has_speaker, row.first_hand]);
      const found = counts.get(key) ?? {
        type: facts.type,
        field: facts.field,
        hasSpeaker: row.has_speaker,
        firstHand: row.first_hand,
        count: 0,
      };
      found.count += 1;
      counts.set(key, found);
    }
    return [...counts.entries()].sort(([a], [b]) => byText(a, b)).map(([, row]) => row);
  });
}

// Each filed name's facts are opened under the item's compartments for its type, field and name;
// the caller prints the name only on a terminal.
export async function listMentions(admin: AdminContext, options: { limit?: number } = {}): Promise<MentionCandidate[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new AdminError("invalid_argument");
  return admin.transaction(async (query) => {
    const rows = await query<CandidateRow>(CANDIDATES, [limit, [...admin.keys.compartments.keys()]]);
    // An organization's name a goal targets is no person's mention: the sync settles it, and an
    // owner's bind to a person of the same words would stop that.
    return rows.flatMap((row) => {
      const facts = FiledMention.parse(
        JSON.parse(open(admin.keys, row, "vault.unresolved_mentions.facts_enc", "throw")),
      );
      if (facts.field === GOAL_TARGET_ORG_FIELD) return [];
      return [
        {
          mention: row.id as MentionId,
          count: row.count,
          entity: EntityId.parse(row.entity_id),
          established: row.on_contact || row.written_to,
          type: FactType.parse(facts.type),
          field: facts.field,
          name: { untrusted: facts.name },
        },
      ];
    });
  });
}

// The item's claims go and it waits to be replayed. Refused: `not_found` for a mention or a person
// that is not there; `not_a_person` as contacts' personOf says; `compartment_mismatch` for a person
// with no account under the item's compartments, which the port could never resolve to;
// `already_settled`, with the binding's id, when the name is bound in that item already. A binding
// links no address to another, moves no row and joins no group.
export async function bindMention(
  admin: AdminContext,
  mention: MentionId,
  entity: EntityId,
  options: { requestId: string },
): Promise<MentionBindingId> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    const tx: Tx = { query, keys: admin.keys };
    await tryExtractLock(tx);
    const repeat = await repeatedRuling(query, options.requestId);
    if (repeat !== undefined) {
      const [made] = await query<{ id: MentionBindingId }>(
        "select id from knowledge.mention_bindings where ruling_id = $1",
        [repeat.id],
      );
      if (made === undefined) throw new AdminError("invalid_argument");
      return made.id;
    }
    const [filed] = await query<{ evidence_id: string; name_fp: string; compartments: string[] }>(
      "select evidence_id, name_fp, compartments from vault.unresolved_mentions where id = $1",
      [mention],
    );
    if (filed === undefined) throw new AdminError("not_found");
    await personOf(query, entity);
    // The lowest address of the person's under the item's compartments that is not the owner's,
    // and the lowest of those no other person holds: the port resolves a binding to the one person
    // holding its address, so one another person holds too could name someone else.
    const [address] = await query<{ any_fp: string | null; own_fp: string | null }>(
      `select min(a.value_fp) as any_fp,
         min(a.value_fp) filter (where not exists (
           select 1 from knowledge.accounts o join knowledge.entities p on p.id = o.entity_id and p.kind = 'person'
           where o.value_fp = a.value_fp and o.entity_id <> a.entity_id)) as own_fp
       from knowledge.accounts a
       where a.entity_id = $1 and a.compartments <@ $2::text[]
         and ${notOwnerAddress("a.value_fp")}`,
      [entity, filed.compartments],
    );
    if (address?.any_fp === null || address === undefined) throw new AdminError("compartment_mismatch");
    if (address.own_fp === null) throw new AdminError("shared_address");
    const [live] = await query<{ id: string }>(
      "select id from knowledge.mention_bindings where evidence_id = $1 and mention_fp = $2 and lifted_at is null",
      [filed.evidence_id, filed.name_fp],
    );
    if (live !== undefined) throw new AdminError("already_settled", undefined, [live.id]);
    const ruling = await ownerDecision(
      query,
      { requestId: options.requestId, kind: "mention_bind", compartments: filed.compartments },
      now,
    );
    const id = newId("mbd") as MentionBindingId;
    await query(
      "insert into knowledge.mention_bindings (id, ruling_id, evidence_id, mention_fp, address_fp, created_at, compartments) values ($1, $2, $3, $4, $5, $6, $7)",
      [id, ruling, filed.evidence_id, filed.name_fp, address.own_fp, stamp(now), filed.compartments],
    );
    await replayItem(tx, filed.evidence_id);
    return id;
  });
}

// False for an id that names no binding in force.
export async function unbindMention(
  admin: AdminContext,
  binding: MentionBindingId,
  options: { requestId: string },
): Promise<boolean> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    const tx: Tx = { query, keys: admin.keys };
    await tryExtractLock(tx);
    const [row] = await query<{
      ruling_id: string | null;
      evidence_id: string;
      address_fp: string;
      compartments: string[];
      lifted: boolean;
    }>(
      "select ruling_id, evidence_id, address_fp, compartments, lifted_at is not null as lifted from knowledge.mention_bindings where id = $1",
      [binding],
    );
    const repeat = await repeatedRuling(query, options.requestId);
    if (repeat !== undefined) {
      // A code binding has no ruling to supersede, so a repeat of its lift is known by the binding
      // being lifted.
      if (row === undefined || (row.ruling_id === null ? !row.lifted : repeat.supersedes !== row.ruling_id))
        throw new AdminError("invalid_argument");
      return true;
    }
    if (row === undefined || row.lifted) return false;
    await ownerDecision(
      query,
      {
        requestId: options.requestId,
        kind: "mention_unbind",
        supersedes: row.ruling_id as RulingId,
        compartments: row.compartments,
      },
      now,
    );
    // The evidence row and the beliefs lock before the binding's row, in an erasure's order.
    await replayItem(tx, row.evidence_id, { addressFp: row.address_fp });
    await query("update knowledge.mention_bindings set lifted_at = $2 where id = $1", [binding, stamp(now)]);
    return true;
  });
}

// The lanes whose prompt writes a name mention: a message's correspondence, an agent record's.
const NAMING_LANES: ReadonlySet<string> = new Set(["correspondence", "agent"]);

// Those are the items with a saved call that a commit left `done` in a naming lane with a candidate no
// one resolved (`unresolved` above 0): any other replays nothing that files, and an item that failed or
// is waiting may have no saved answer to replay, so the run would buy calls for it. Nothing else
// changes until that run's commits. A moment's call is its group's, kept under the first moment and
// listed for each member: a moment that is a member of a saved call counts as having one, and the
// call's other moments are set waiting with it, so the group forms again and its call replays, as a
// binding's replay does (`replayItem`).
const CAPTURE_LANES: ReadonlySet<string> = new Set(["meeting", "moment"]);

export async function refileMentions(admin: AdminContext): Promise<{ items: number }> {
  return admin.transaction(async (query) => {
    const tx: Tx = { query, keys: admin.keys };
    await tryExtractLock(tx);
    const rows = await query<{ evidence_id: string; compartments: string[]; facts_enc: Sealed; filed: boolean }>(
      `select p.evidence_id, p.compartments, p.facts_enc,
         exists (select 1 from vault.unresolved_mentions u where u.evidence_id = p.evidence_id) as filed
       from vault.pipeline_items p
       where not p.waiting and p.compartments <@ $1::text[]
         and (exists (select 1 from vault.model_calls c where c.evidence_id = p.evidence_id and c.superseded_at is null)
           or exists (select 1 from vault.model_call_members m where m.evidence_id = p.evidence_id))
       order by p.evidence_id collate "C"`,
      [[...tx.keys.compartments.keys()]],
    );
    const naming = rows.filter((row) => {
      const facts = openStatus(tx, row.compartments, row.evidence_id, row.facts_enc);
      if (facts.status !== "done") return false;
      return CAPTURE_LANES.has(facts.lane) ? row.filed : facts.unresolved > 0 && NAMING_LANES.has(facts.lane);
    });
    const ids = naming.map((row) => row.evidence_id);
    const mates = await query<{ evidence_id: string }>(
      "select distinct o.evidence_id from vault.model_call_members m join vault.model_call_members o on o.call_id = m.call_id where m.evidence_id = any ($1) and not (o.evidence_id = any ($1))",
      [ids],
    );
    return { items: await waitToReplay(tx, [...ids, ...mates.map((row) => row.evidence_id)]) };
  });
}

// The bindings the sync's participant step made, in force, newest first, so the owner can see whom
// each meeting's name was bound to and lift one with `pi identity unbind` ("not the same"), after
// which the next sync makes the participant a new person. Ids alone.
export async function listCodeBindings(
  admin: AdminContext,
  options: { limit?: number } = {},
): Promise<{ binding: MentionBindingId; evidence: string; entity: EntityId | null; created: string }[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new AdminError("invalid_argument");
  return admin.transaction(async (query) => {
    const rows = await query<{ id: string; evidence_id: string; entity_id: string | null; created_at: Date }>(
      `select b.id, b.evidence_id, b.created_at,
         (select min(a.entity_id) from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id and e.kind = 'person' where a.value_fp = b.address_fp) as entity_id
       from knowledge.mention_bindings b where b.origin = 'code' and b.lifted_at is null
       order by b.created_at desc, b.id collate "C" limit $1`,
      [limit],
    );
    return rows.map((row) => ({
      binding: row.id as MentionBindingId,
      evidence: row.evidence_id,
      entity: row.entity_id === null ? null : EntityId.parse(row.entity_id),
      created: stamp(row.created_at),
    }));
  });
}
