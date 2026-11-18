import type { CardId, ErasureId, ErasureReport, PersonalCompartment } from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { claimKeysOf } from "../../core/claim-columns.ts";
import { type Query, stamp } from "../../core/db.ts";
import { newId } from "../../core/ids.ts";
import { appendJournal, type JournalEntry, erasureLevel as levelOf, readJournal } from "../../core/journal.ts";
import { BELIEFS_LOCK, TAINT_ALONE } from "../../core/locks.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { raiseCard } from "../../core/queue.ts";
import { setTriggerCause } from "../../core/stored-forms.ts";
import type { Tx } from "../../core/tx.ts";
import { goneKeys } from "../../erasure/erasure-fact-keys.ts";
import { allEvidence, type Erased, peopleOf } from "../../erasure/erasure-hook.ts";
import { ERASURE_HOOKS } from "../../erasure/erasure-hooks.ts";
import { anchoredKeys, anchoredRulings, CARRY_CLAIM, taintCiting } from "../../erasure/taint.ts";
import { eraseFromQuestions } from "../../identity/identity-answers-erasure.ts";
import { removeSourceItem } from "../../write/writer-item-removal.ts";
import { removeClaims, removeForGood } from "../../write/writer-removal.ts";

// The agent records resting on the items an erasure removes: found, then locked with them.

import { lockRecords, RESTING } from "../../write/writer-records.ts";

// The owner's erasure, each in one transaction behind the sync lock. An erasure removes each source
// item through the path a deletion at the source uses (`removeSourceItem`), and writes around it
// the journal line, the decision, the erasure row, the removed-evidence rows and the suppressions.
// Nothing here logs or returns content: ids, fingerprints and counts only.

// The count of claims naming the person, in a person's report.
const CLAIMS_NAMING = "claims_naming";
const AUTHOR = "system:erase";

// What an erasure removes: its source items, by account and source fingerprint; for a person, the
// person's entities and address fingerprints. A `device_forget` is a forget from a Mac: its items
// are the (account, fingerprint) pairs of the keys it names, stored or not, under that device's own
// accounts, with no entity and nothing to suppress. `nameFps`, a person's names, suppressed beside
// the addresses so the sync's participant step makes no one of them again, and handed to the hooks
// beside the addresses, so the `captures` hook drops the history pages naming the person. `goals`:
// the goals an erasure of a goal the owner set removes; their state rows go after the journal line,
// so a replay deletes them again.
export type Target = {
  kind: "item" | "person" | "device_forget";
  items: { accountId: string; fp: string }[];
  entities: string[];
  addressFps: string[];
  nameFps?: string[];
  goals?: string[];
};

// The rows a ref can name that hold a source item by its evidence id, by the ref's kind.
export const ITEM_ROWS = {
  message: "knowledge.messages",
  event: "knowledge.events",
  document: "knowledge.documents",
  page: "knowledge.pages",
  capture: "knowledge.captures",
} as const;
type ItemKind = keyof typeof ITEM_ROWS;

// What the reads of step 1 find for a target.
type Found = {
  revisions: { id: string; accountId: string; fp: string; compartments: string[]; ingestedAt: Date }[];
  held: Record<ItemKind, string[]>;
  records: string[];
  recordEvidence: string[];
};

export const journalOf = (admin: AdminContext): string => {
  if (admin.journal === undefined) throw new Error("the admin was made without the journal's path");
  return admin.journal;
};

// A label: sorted, each once, never empty.
const labelOf = (lists: string[][]): PersonalCompartment[] => {
  const all = [...new Set(lists.flat())].sort();
  return all.length === 0 ? ["own"] : all;
};

export async function nextSeq(query: Query, journal: string): Promise<number> {
  if ((await levelOf(query, journal)) !== "level") throw new AdminError("erasure_replay_needed");
  return (await readJournal(journal)).seq + 1;
}

// Step 1, by reads alone: every revision of every target item, their message and event rows,
// and the agent records resting on them.
async function find(query: Query, target: Target): Promise<Found> {
  const revisions = await query<{
    id: string;
    source_account_id: string;
    source_item_fp: string;
    compartments: string[];
    ingested_at: Date;
  }>(
    `select id, source_account_id, source_item_fp, compartments, ingested_at from vault.evidence_items
     where (source_account_id, source_item_fp) in (select * from unnest($1::text[], $2::text[])) order by id`,
    [target.items.map((item) => item.accountId), target.items.map((item) => item.fp)],
  );
  const ids = revisions.map((row) => row.id);
  const held = {} as Found["held"];
  for (const [kind, table] of Object.entries(ITEM_ROWS) as [ItemKind, string][])
    held[kind] = (
      await query<{ id: string }>(`select id from ${table} where evidence_id = any($1) order by id`, [ids])
    ).map((row) => row.id);
  const records = ids.length === 0 ? [] : await query<{ id: string }>(RESTING, [ids]);
  const recordEvidence = await query<{ evidence_id: string }>(
    "select evidence_id from ledger.agent_writes where id = any($1) and evidence_id is not null",
    [records.map((row) => row.id)],
  );
  return {
    revisions: revisions.map((row) => ({
      id: row.id,
      accountId: row.source_account_id,
      fp: row.source_item_fp,
      compartments: row.compartments,
      ingestedAt: row.ingested_at,
    })),
    held,
    records: records.map((row) => row.id),
    recordEvidence: recordEvidence.map((row) => row.evidence_id),
  };
}

// The pairs that have no removed-evidence row, each once, in the order given.
async function notRemoved(query: Query, items: Target["items"]): Promise<Target["items"]> {
  const removed = await query<{ account: string; fp: string }>(
    `select source_account_id as account, source_item_fp as fp from knowledge.removed_evidence
     where (source_account_id, source_item_fp) in (select * from unnest($1::text[], $2::text[]))`,
    [items.map((item) => item.accountId), items.map((item) => item.fp)],
  );
  const gone = new Set(removed.map((one) => `${one.account} ${one.fp}`));
  const seen = new Set<string>();
  return items.filter((item) => {
    const at = `${item.accountId} ${item.fp}`;
    if (gone.has(at) || seen.has(at)) return false;
    seen.add(at);
    return true;
  });
}

// An erasure reads them after its locks and before anything is removed: a claim commits holding its
// evidence row and its entities on their keys, which the erasure holds `for update`, so none it
// would remove commits after this read. A dry run reads them under no lock. Each claim's version 1
// keys are among them: a ruling made before the key changed holds one, and no other read of the
// erasure's would name it. So are the keys of the rulings anchored on what is erased (taint.ts,
// anchoredKeys), read here because the removal empties those anchors. And the key of every belief
// ruling the scrub reaches (knowledge.scrub_belief_rulings): one anchored on any of what goes, or
// that names a claim or an item the erasure removes, whatever its key. So the keys the erasure
// judges hold every key the scrub could take, and there is one set of gone keys: a key taken from a
// ruling is taken from everything else that holds it, an agent's close emptied first.
async function factKeys(query: Query, found: Found, target: Target, claimIds: string[]): Promise<string[]> {
  const evidence = [...found.revisions.map((row) => row.id), ...found.recordEvidence];
  const facts = await query<{ fp: string }>(
    `select distinct k.fp from (
       select c.id, c.fact_key_fp, c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp from knowledge.claims c where c.evidence_id = any($1)
       union
       select c.id, c.fact_key_fp, c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp from knowledge.claims c
       join knowledge.claim_entities e on e.claim_id = c.id where e.entity_id = any($2)) c
     cross join lateral (values (c.fact_key_fp), (c.legacy_fact_key_fp), (c.legacy_alt_fact_key_fp)) as k (fp)
     where k.fp is not null order by 1`,
    [evidence, target.entities],
  );
  const anchored = await anchoredKeys(query, evidence, target.entities);
  const ruled = await query<{ fp: string }>(
    `select distinct r.fact_key_fp as fp from knowledge.belief_rulings r
     where r.evidence_ids && $1::text[] or r.entity_ids && $2::text[] or r.claim_fp = any ($3::text[])
        or r.source_item_fp = any ($4::text[]) or r.item_fps && $4::text[]`,
    [evidence, target.entities, claimIds, target.items.map((item) => item.fp)],
  );
  return [...new Set([...facts.map((row) => row.fp), ...anchored, ...ruled.map((row) => row.fp)])].sort();
}

// Every claim key of the claims factKeys reads, each claim's own
// and its version 1 keys', over its evidence id, so the erasure's relations go with its claims.
// Computed from the claims, not their value rows, so a claim stored before its value row is
// reached too.
// And the claims' ids, so the `triggers` hook
// removes every pending recheck that names one.
async function claimKeys(tx: Tx, found: Found, target: Target): Promise<{ keys: string[]; ids: string[] }> {
  const claims = await tx.query<{
    id: string;
    evidence_id: string;
    fact_key_fp: string;
    legacy_fact_key_fp: string | null;
    legacy_alt_fact_key_fp: string | null;
  }>(
    `select c.id, c.evidence_id, c.fact_key_fp, c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp from knowledge.claims c where c.evidence_id = any($1)
     union
     select c.id, c.evidence_id, c.fact_key_fp, c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp from knowledge.claims c join knowledge.claim_entities e on e.claim_id = c.id where e.entity_id = any($2)`,
    [[...found.revisions.map((row) => row.id), ...found.recordEvidence], target.entities],
  );
  return {
    keys: [
      ...new Set(
        claims.flatMap((row) =>
          claimKeysOf(tx, row.evidence_id, [row.fact_key_fp, row.legacy_fact_key_fp, row.legacy_alt_fact_key_fp]),
        ),
      ),
    ].sort(),
    ids: [...new Set(claims.map((row) => row.id))].sort(),
  };
}

// The items a target names, each once, with its account's compartment and the revisions of it
// that are stored. A replayed item the database no longer holds has none, and still gets its
// removed-evidence row, so no later sync stores it again.
// An item whose account the store lacks (an account connected after the backup a replay runs
// on) is not stored and cannot be again under that id: it gets no removed-evidence row, which
// would fail on the account's foreign key and leave the replay failing for good.
async function itemsOf(
  query: Query,
  target: Target,
  found: Found,
): Promise<{ accountId: string; fp: string; compartment: string; evidenceIds: string[]; known: boolean }[]> {
  const accounts = await query<{ id: string; compartments: string[] }>(
    "select id, compartments from vault.source_accounts where id = any($1)",
    [[...new Set(target.items.map((item) => item.accountId))]],
  );
  const compartmentOf = new Map(accounts.map((row) => [row.id, row.compartments[0] ?? "own"]));
  const items = new Map<
    string,
    { accountId: string; fp: string; compartment: string; evidenceIds: string[]; known: boolean }
  >();
  for (const { accountId, fp } of target.items) {
    const evidenceIds = found.revisions
      .filter((row) => row.accountId === accountId && row.fp === fp)
      .map((row) => row.id);
    items.set(`${accountId} ${fp}`, {
      accountId,
      fp,
      compartment: compartmentOf.get(accountId) ?? "own",
      evidenceIds,
      known: compartmentOf.has(accountId),
    });
  }
  return [...items.values()];
}

// Lens: a person's erasure opens every meeting's and moment's CaptureFacts in the captures hook,
// after its journal line. A compartment of theirs whose key the file lacks refuses it before that
// line, dry run or not.
async function captureKeysHeld(query: Query, admin: AdminContext): Promise<void> {
  const rows = await query<{ compartment: string }>(
    "select distinct unnest(compartments) as compartment from knowledge.captures where kind in ('meeting', 'moment')",
  );
  if (rows.some((row) => !admin.keys.compartments.has(row.compartment))) throw new AdminError("keys_missing");
}

const refsOf = (found: Found, target: Target): { kind: string; id: string }[] => [
  ...(Object.keys(ITEM_ROWS) as ItemKind[]).flatMap((kind) => found.held[kind].map((id) => ({ kind, id }))),
  ...target.entities.map((id) => ({ kind: "entity", id })),
  ...(target.goals ?? []).map((id) => ({ kind: "goal", id })),
];

// The claims an erasure removes, as what names them in the ledger: the refs a `ruling_carry` card's
// basis holds its candidates by, and the target of a card about one claim (`same_fact`, a title
// link's `agent_claim`), which cites no evidence and would otherwise keep waiting on a claim that
// is gone.
const claimRefs = (claimIds: readonly string[]): { kind: string; id: string }[] =>
  claimIds.flatMap((id) => [
    { kind: CARRY_CLAIM, id },
    { kind: "claim", id },
  ]);

// The claims that name one of the entities.
const claimsNaming = async (query: Query, entities: string[]): Promise<string[]> =>
  (
    await query<{ claim_id: string }>(
      "select distinct claim_id from knowledge.claim_entities where entity_id = any($1) order by claim_id",
      [entities],
    )
  ).map((row) => row.claim_id);

// The undecided rows the taint would reach, for a dry run: the cards and decisions that cite,
// or are about, what the erasure removes, and the memory projections that rest on it.
async function wouldTaint(query: Query, evidenceIds: string[], refs: { kind: string; id: string }[]): Promise<number> {
  const [row] = await query<{ n: number }>(
    `with gone as (select * from unnest($2::text[], $3::text[]) as g (kind, id)),
     cited as (select distinct b.row_kind, b.row_id from ledger.basis b
               where b.tainted_at is null and (b.evidence_id = any($1) or (b.ref_kind, b.ref_id) in (select kind, id from gone)))
     select ((select count(*) from ledger.cards c where c.tainted_at is null
                and (exists (select 1 from cited m where m.row_kind = 'card' and m.row_id = c.id) or (c.target_kind, c.target_id) in (select kind, id from gone)))
           + (select count(*) from knowledge.owner_decisions o where o.tainted_at is null and (o.target_kind, o.target_id) in (select kind, id from gone))
           + (select count(*) from ledger.memory_projections p where p.tainted_at is null and p.evidence_ids && $1::text[]))::int as n`,
    [evidenceIds, refs.map((ref) => ref.kind), refs.map((ref) => ref.id)],
  );
  return row?.n ?? 0;
}

const TAINTED = `select ((select count(*) from ledger.cards where tainted_at is not null) + (select count(*) from knowledge.owner_decisions where tainted_at is not null)
  + (select count(*) from ledger.memory_projections where tainted_at is not null))::int as n`;

// A Lens device's capture client reads nothing, so its pushes expose nothing and it is never
// counted.
async function exposedClients(query: Query, found: Found): Promise<string[]> {
  if (found.revisions.length === 0) return [];
  const since = found.revisions.reduce(
    (earliest, row) => (row.ingestedAt < earliest ? row.ingestedAt : earliest),
    found.revisions[0]?.ingestedAt ?? new Date(),
  );
  const labels = [...new Set(found.revisions.map((row) => row.compartments.join(",")))];
  return (
    await query<{ id: string }>(
      `select c.id from policy.clients c
       where c.status = 'active' and c.kind <> 'device'
         and exists (select 1 from unnest($1::text[]) as l (joined) where c.compartments @> string_to_array(l.joined, ','))
         and exists (select 1 from policy.calls k where k.client_id = c.id and k.outcome = 'ok' and k.at >= $2)
       order by c.id`,
      [labels, since],
    )
  ).map((row) => row.id);
}

// `seq` is null for a dry run and for a new erasure, whose number is taken after the locks; a
// replay hands its entry's.
export async function apply(
  admin: AdminContext,
  query: Query,
  target: Target,
  options: { erasure: ErasureId; requestId: string; dryRun: boolean; replay: number | null },
): Promise<ErasureReport> {
  const now = admin.now();
  const journal = journalOf(admin);
  if (target.kind === "device_forget") target = { ...target, items: await notRemoved(query, target.items) };
  const found = await find(query, target);
  const items = await itemsOf(query, target, found);
  const refs = refsOf(found, target);
  const evidenceIds = found.revisions.map((row) => row.id);
  const sources = items.map((item) => ({ accountId: item.accountId, sourceItemFp: item.fp }));
  const erased = (factKeyFps: string[], claims: { keys: string[]; ids: string[] }): Erased => ({
    evidenceIds,
    refs,
    addressFps: target.addressFps,
    nameFps: target.nameFps ?? [],
    sources,
    records: found.records,
    recordEvidenceIds: found.recordEvidence,
    erasureId: options.dryRun ? null : options.erasure,
    factKeyFps,
    claimKeys: claims.keys,
    claimIds: claims.ids,
  });
  const people = target.kind === "person" ? 1 : 0;
  if (target.kind === "person") await captureKeysHeld(query, admin);

  if (options.dryRun) {
    const more: Record<string, number> = {};
    const keyed = await claimKeys({ query, keys: admin.keys }, found, target);
    const dry = erased(await factKeys(query, found, target, keyed.ids), keyed);
    dry.goneKeyFps = await goneKeys(query, dry);
    for (const hook of ERASURE_HOOKS)
      more[hook.name] = await hook.run(query, dry, { dryRun: true, now, keys: admin.keys });
    if (target.kind === "person") more[CLAIMS_NAMING] = (await claimsNaming(query, target.entities)).length;
    return {
      erasure: null,
      items: items.length,
      people,
      suppressed: target.addressFps.length,
      // What the erasure's taint will be handed: the revisions and the resting agent records'
      // evidence rows (removeSourceItem's one call).
      taintedRows: await wouldTaint(
        query,
        [...evidenceIds, ...found.recordEvidence],
        [...refs, ...claimRefs(dry.claimIds)],
      ),
      exposedClients: (await exposedClients(query, found)).length,
      more,
    };
  }

  // After it, no message, evidence or agent-record row is locked that was not here.
  await query("select id from knowledge.messages where id = any($1) order by id for update", [found.held.message]);
  // A document's row before its evidence rows, as the owner's release and the writer lock them.
  await query("select id from knowledge.documents where id = any($1) order by id for update", [found.held.document]);
  await query("select id from vault.evidence_items where id = any($1) order by id for update", [
    [...new Set([...evidenceIds, ...found.recordEvidence])],
  ]);
  const tx: Tx = { query, keys: admin.keys };
  if (found.records.length > 0) await lockRecords(tx, found.records);
  await query(BELIEFS_LOCK);
  if (target.entities.length > 0)
    await query("select id from knowledge.entities where id = any($1) order by id for update", [target.entities]);
  await query(TAINT_ALONE);
  const keyed = await claimKeys(tx, found, target);
  const removing = erased(await factKeys(query, found, target, keyed.ids), keyed);
  removing.anchoredRulings = await anchoredRulings(query, allEvidence(removing), peopleOf(removing));
  removing.identityQuestions = await eraseFromQuestions(
    query,
    removing.addressFps,
    removing.evidenceIds,
    peopleOf(removing),
    true,
  );

  // Step 7: the journal line, on disk before anything is removed. A replay's is there.
  const seq = options.replay ?? (await nextSeq(query, journal));
  if (options.replay === null) {
    await appendJournal(journal, {
      seq,
      erasure: options.erasure,
      kind: target.kind,
      items: items.map((item) => ({ account: item.accountId, fp: item.fp })),
      suppress: [...new Set([...target.addressFps, ...(target.nameFps ?? [])])].sort(),
      ...(target.goals === undefined || target.goals.length === 0 ? {} : { goals: target.goals }),
      ...(target.kind === "person" ? { entities: target.entities } : {}),
    } as JournalEntry);
  }
  if (target.goals !== undefined && target.goals.length > 0)
    await query("delete from projections.goal_state where goal_id = any($1)", [target.goals]);
  // A join or a split names a person its anchors do not when a claim under either of its keys does:
  // said on the ruling now, while the claims are still there to say it.
  if (target.entities.length > 0) await query("select knowledge.name_ruling_people($1::text[])", [target.entities]);

  const before = (await query<{ n: number }>(TAINTED))[0]?.n ?? 0;
  const more: Record<string, number> = {};
  // The rechecks this erasure's removals write are its own, and every trigger row citing a claim it
  // removes goes with it.
  await setTriggerCause(query, "erasure");
  // Step 8, for a person: every claim that names the person, with its entity links and the beliefs
  // resting on it, under the entity lock above.
  let named: string[] = [];
  if (target.kind === "person") {
    const claims = await claimsNaming(query, target.entities);
    named = (
      await query<{ entity_id: string }>(
        "select distinct entity_id from knowledge.claim_entities where claim_id = any($1)",
        [claims],
      )
    ).map((row) => row.entity_id);
    await removeClaims(query, claims);
    more[CLAIMS_NAMING] = claims.length;
  }
  // Step 9: each item through the deletion path, every lock of which this transaction holds. What
  // it returns of each capture item it removed.
  const captures: { key: string; device: string; compartments: string[] }[] = [];
  for (const item of items)
    if (item.evidenceIds.length > 0)
      captures.push(
        ...(await removeSourceItem(tx, { id: item.accountId, compartment: item.compartment }, item.fp, "erased"))
          .captures,
      );
  // The person too, when no item or claim named them.
  await removeForGood(tx, [...new Set([...named, ...target.entities])]);
  // A goal's own decisions hold its words: tainted, their bodies dropped, with whatever else is about
  // it. And each card about a claim this erasure removed: one whose target it is, and each
  // `ruling_carry` card that lists it as a candidate.
  await taintCiting(query, {
    evidenceIds: [],
    refs: [...refs.filter((ref) => ref.kind === "goal"), ...claimRefs(removing.claimIds)],
  });
  const taintedRows = Math.max(0, ((await query<{ n: number }>(TAINTED))[0]?.n ?? 0) - before);
  // After the removal, as every hook reads: what is left is what stays.
  removing.goneKeyFps = await goneKeys(query, removing);

  // Step 10: the hooks, after the removal and before anything the erasure writes of its own.
  for (const hook of ERASURE_HOOKS)
    more[hook.name] = await hook.run(query, removing, { dryRun: false, now, keys: admin.keys });
  await query("select ledger.taint_citing('{}'::text[], '{}'::text[], '{}'::text[])");

  const label = labelOf([
    ...found.revisions.map((row) => row.compartments),
    ...items.map((item) => [item.compartment]),
  ]);
  const exposed = await exposedClients(query, found);
  // A forget writes none, and no ruling and no card: the act was the owner's on the desktop, and
  // Lens already deleted the items.
  const forget = target.kind === "device_forget";
  if (!forget && captures.length > 0) {
    await query("select ledger.capture_erased($1::text[], $2::text[], $3::jsonb)", [
      captures.map((one) => one.device),
      captures.map((one) => one.key),
      JSON.stringify(captures.map((one) => one.compartments)),
    ]);
  }
  const ruling = forget
    ? null
    : await ownerDecision(query, { requestId: options.requestId, kind: "erase", compartments: label }, now);
  if (exposed.length > 0 && !forget) {
    await raiseCard(
      query,
      {
        id: newId("crd") as CardId,
        requestId: `erase_${options.erasure.slice(4)}`,
        kind: "notice",
        author: AUTHOR,
        options: ["acknowledge"],
        target: null,
        refs: [],
        compartments: label,
        expiresAt: null,
        expiresAfterDays: null,
        caseKey: null,
        run: null,
        body: null,
        bodyFrom: null,
      },
      { now, log: admin.log },
    );
  }
  await query(
    `insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, exposed_client_ids, compartments)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, ledger.label($10))`,
    [
      options.erasure,
      ruling,
      target.kind,
      seq,
      stamp(now),
      items.length,
      target.addressFps.length,
      taintedRows,
      exposed,
      label,
    ],
  );
  for (const item of items.filter((one) => one.known)) {
    await query(
      `insert into knowledge.removed_evidence (id, erasure_id, source_account_id, source_item_fp, evidence_ids, reason, removed_at, compartments)
       values ($1, $2, $3, $4, $5, $8, $6, $7)`,
      [
        newId("rme"),
        options.erasure,
        item.accountId,
        item.fp,
        item.evidenceIds,
        stamp(now),
        [item.compartment],
        forget ? "device_forget" : "owner_erasure",
      ],
    );
  }
  for (const fp of new Set([...target.addressFps, ...(target.nameFps ?? [])])) {
    await query(
      `insert into knowledge.suppressions (id, erasure_id, kind, value_fp, added_at, compartments) values ($1, $2, 'address', $3, $4, ledger.label($5))
       on conflict (erasure_id, kind, value_fp) do nothing`,
      [newId("sup"), options.erasure, fp, stamp(now), label],
    );
  }
  return {
    erasure: options.erasure,
    items: items.length,
    people,
    suppressed: target.addressFps.length,
    taintedRows,
    exposedClients: exposed.length,
    more,
  };
}

export type StoredErasure = {
  id: string;
  kind: "item" | "person" | "device_forget";
  journal_seq: string;
  lift_seq: string | null;
  erased_at: Date;
  lifted_at: Date | null;
  items: number;
  suppressed: number;
  tainted_rows: number;
  exposed_client_ids: string[];
  ruling_id: string | null;
};
