import type {
  ClaimRecord,
  OutcomeAttribution,
  OutcomeCandidate,
  OutcomeLinkKind,
  OutcomePath,
  PersonalLogger,
} from "@intelligence/contracts/personal";
import { byText } from "../core/db.ts";
import { trackedCalls } from "../core/decision-calls.ts";
import { claimKey, fingerprint } from "../core/fingerprint.ts";
import { createDb, type Db } from "../core/job-db.ts";
import type { Keys } from "../core/keys.ts";
import { open, type Sealed } from "../core/seal.ts";
import { factsSubject } from "../core/stored-forms.ts";
import { claimRecordOf } from "../core/tx.ts";
import { claimPassage } from "./claim-passage.ts";
import { itemFacts, restricted } from "./code-relations.ts";

// An outcome check that reached the model, what the relation step's day cap counts, two calls each.
// The claim relations' store and the outcome judge's both count these beside the relation checks,
// since they share the cap.
export const ASKED_OUTCOME_CHECKS = `state = 'judged' and (code is null or code not in ('flagged', 'rule_decline', 'rule_reply', 'no_passage'))`;

// The outcome judge's store, run as pi_pipeline in the relation step after the claim relations and
// before the after-commit diff. It finds the candidates: on the watched path, each item on a
// channel an open work (or one in its grace) watches, first stored after the watch began, for each
// of that work's expectations; on the open path, each claim the pending rechecks name, for each
// open expectation on its subject, an entity of the same address, or the organization of its
// address's domain; and the candidates an earlier run left unjudged, first. Candidates are built
// (passages opened) only for the calls the run can reach; the rest are marked unjudged. It writes
// the step's links and checks. What a work is, whether it is open, and what it sent come from
// ledger.outcome_channels alone: the Pipeline reads no opportunity, send or status. Shapes are the
// contracts'. Ids, counts and codes in its log lines only.

type OutcomeCandidateRow = OutcomeCandidate;
type OutcomeCheckRow = {
  expectationId: string;
  evidenceId: string;
  claimKey: string | null;
  path: OutcomePath;
  state: "judged" | "unjudged";
  firstAnswer: string | null;
  secondAnswer: string | null;
  agreed: boolean | null;
  written: OutcomeLinkKind | null;
  code: string | null;
  compartments: string[];
};
export type OutcomeRunRow = {
  links: {
    expectationId: string;
    opportunityId: string;
    evidenceId: string;
    claimKey: string | null;
    kind: OutcomeLinkKind;
    path: OutcomePath;
    judge: string;
    attribution: OutcomeAttribution;
    passage: { start: number; end: number } | null;
    applied: boolean;
    compartments: string[];
  }[];
  checks: OutcomeCheckRow[];
};

export type OutcomeStore = {
  // The candidates under `judge` and those already judged. `budget`: the run's calls left after the
  // claim relations, and the day's cap the relation step shares (ontology/relations.json).
  jobs(
    judge: string,
    now: string,
    budget: { calls: number; callsPerDay: number },
  ): Promise<{ candidates: OutcomeCandidateRow[]; checked: Set<string>; deferred: OutcomeCheckRow[]; calls: number }>;
  calls(): ReturnType<typeof trackedCalls>;
  // The saved calls' subject for a candidate: `facts:` and two keyed fingerprints.
  subjectOf(candidate: Pick<OutcomeCandidateRow, "expectation" | "item">): string;
  save(run: OutcomeRunRow, judge: string): Promise<{ links: number; checks: number }>;
  close(): Promise<void>;
};

const labelOf = (...labels: readonly (readonly string[])[]): string[] => [...new Set(labels.flat())].sort(byText);
const key = (expectation: string, evidence: string): string => `${expectation}\n${evidence}`;
// An expectation waits on a named person when what it expects is that person's act or word.
const PERSON_TYPES: ReadonlySet<string> = new Set(["answered", "meeting_held", "commitment", "consent"]);
const DECLINES: ReadonlySet<string> = new Set(["reversal", "objection"]);
// What a claim states, from the typed fields code read: its typed text fields, named.
const statedOf = (record: ClaimRecord): string | null => {
  const { fields } = record.claim.content;
  const text = Object.entries(fields)
    .filter(([, value]) => typeof value === "string" && !/^ent_[0-9A-Z]{26}$/.test(value))
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join("; ");
  return text === "" ? null : text;
};

type Channel = {
  opportunity_id: string;
  kind: string | null;
  account_id: string | null;
  watch_key: string | null;
  began_at: Date | null;
  until: Date | null;
  moved_at: Date | null;
  counterpart_fps: string[];
  compartments: string[];
};
type ExpectationRow = {
  id: string;
  opportunity_id: string;
  ordinal: number;
  subject_kind: string;
  subject_id: string | null;
  outcome_type: string;
  success_enc: Sealed | null;
  failure_enc: Sealed | null;
  compartments: string[];
  person: boolean;
};
type ItemRow = {
  evidence_id: string;
  account_id: string | null;
  thread_fp: string | null;
  first_at: Date;
  sender_fp: string | null;
  direction: string | null;
  message_id: string | null;
  compartments: string[];
};
type ClaimRow = { id: string; evidence_id: string; fact_key_fp: string; compartments: string[]; content_enc: Sealed };
// One candidate before its item is built: where it came from.
type Found = {
  expectation: ExpectationRow;
  evidenceId: string;
  path: OutcomePath;
  channel: Channel | null;
  claimId: string | null;
};

const ITEMS = `
  select e.id as evidence_id, e.source_account_id as account_id, coalesce(m.thread_fp, e.thread_fp) as thread_fp, f.first_at, m.sender_fp, m.direction, m.id as message_id,
    ledger.label(e.compartments || coalesce(m.compartments, '{}'::text[])) as compartments
  from vault.evidence_items e
  left join knowledge.messages m on m.evidence_id = e.id
  cross join lateral (
    select min(x.observed_at) as first_at from vault.evidence_items x where x.source_account_id = e.source_account_id and x.source_item_fp = e.source_item_fp) f
  where e.id = any ($1::text[]) and not e.system_originated and not coalesce(m.held, false)`;

// What the store's operations share: its database and the keys its rows open under.
type Ctx = { db: Db; keys: Keys; judgeGapDefaults: boolean };
type Budget = { calls: number; callsPerDay: number };
type Jobs = Awaited<ReturnType<OutcomeStore["jobs"]>>;
type ItemFlags = Awaited<ReturnType<typeof itemFacts>>;

const opens = (keys: Keys, compartments: readonly string[]): boolean =>
  compartments.length > 0 && compartments.every((one) => keys.compartments.has(one));
const words = (text: string | null): string | null => {
  if (text === null) return null;
  try {
    const fields = JSON.parse(text) as Record<string, unknown>;
    return Object.entries(fields)
      .map(([name, value]) => `${name}: ${String(value)}`)
      .join("; ");
  } catch {
    return null;
  }
};
const claimKeyOf = (keys: Keys, row: ClaimRow): string => claimKey(keys, row.evidence_id, row.fact_key_fp);
const claimsOfItems = async (db: Db, evidenceIds: readonly string[]): Promise<ClaimRow[]> =>
  evidenceIds.length === 0
    ? []
    : db.query<ClaimRow>(
        'select id, evidence_id, fact_key_fp, compartments, content_enc from knowledge.claims where evidence_id = any ($1::text[]) and not released and not closes order by id collate "C"',
        [[...new Set(evidenceIds)]],
      );

// An item's text on a watched channel: a message's body, opened under its label.
async function messageText({ db, keys }: Ctx, messageId: string): Promise<string | null> {
  const [row] = await db.query<{ id: string; compartments: string[]; body_enc: Sealed | null }>(
    "select id, compartments, body_enc from knowledge.messages where id = $1 and not held",
    [messageId],
  );
  return row === undefined ? null : open(keys, row, "knowledge.messages.body_enc", "null");
}

export function createOutcomeStore({
  url,
  keys,
  log,
  judgeGapDefaults = false,
}: {
  url: string;
  keys: Keys;
  log: PersonalLogger;
  // Whether code-raised work's default expectations are judged: when the owner turns it on (PI_JUDGE_GAP_DEFAULTS=1)
  // alone, so a deploy with every switch off adds no model call.
  judgeGapDefaults?: boolean;
}): OutcomeStore {
  const ctx: Ctx = { db: createDb(url, log), keys, judgeGapDefaults };
  // The claim each candidate of the last `jobs` was found by (the open path's), for its check rows.
  let claimIds = new Map<string, string | null>();
  return {
    async jobs(judge, now, budget) {
      const found = await findJobs(ctx, judge, now, budget);
      claimIds = found.claimIds;
      return found.jobs;
    },
    calls: () => trackedCalls(ctx.db.query, keys),
    subjectOf: ({ expectation, item }) => {
      const [a, b] = [
        fingerprint(keys, "fact", `outcome expectation ${expectation.id}`),
        fingerprint(keys, "fact", `outcome item ${item.evidenceId}`),
      ].sort(byText) as [string, string];
      return factsSubject(a, b);
    },
    save: (run, judge) => saveRun(ctx.db, run, judge, claimIds),
    close: () => ctx.db.close(),
  };
}

// The candidates under `judge`, built while the run's calls reach them, and the claim each was
// found by.
async function findJobs(
  ctx: Ctx,
  judge: string,
  now: string,
  budget: Budget,
): Promise<{ jobs: Jobs; claimIds: Map<string, string | null> }> {
  const calls = await callsLeft(ctx.db, judge, now, budget);
  const { channels, expectations, byWork } = await openWorks(ctx, now);
  const { checked, left, unjudged } = await priorStates(ctx.db, judge);
  const found = new Map<string, Found>();
  const add = (one: Found): void => {
    const k = key(one.expectation.id, one.evidenceId);
    if (checked.has(k)) return;
    const had = found.get(k);
    // A watched candidate is kept over an open one: it knows its channel.
    if (had === undefined || (had.path === "open" && one.path === "watched"))
      found.set(
        k,
        had?.claimId !== undefined && had.claimId !== null && one.claimId === null
          ? { ...one, claimId: had.claimId }
          : one,
      );
  };
  await findWatched(ctx.db, now, channels, byWork, add);
  await findOpen(ctx.db, expectations, add);
  // An earlier run's unjudged candidates, found again by their claim when they had one.
  for (const row of left) {
    const expectation = expectations.find((one) => one.id === row.expected_outcome_id);
    if (expectation === undefined || found.has(key(row.expected_outcome_id, row.evidence_id))) continue;
    add({ expectation, evidenceId: row.evidence_id, path: row.path, channel: null, claimId: row.claim_id });
  }

  const ordered = [...found.entries()].sort(
    ([a], [b]) => Number(unjudged.has(b)) - Number(unjudged.has(a)) || byText(a, b),
  );
  const { candidates, deferred } = await buildCandidates(ctx, ordered, channels, unjudged, calls);
  // The claims each candidate was found by, for save's rows.
  return {
    jobs: { candidates, checked, deferred, calls },
    claimIds: new Map(ordered.map(([k, one]) => [k, one.claimId])),
  };
}

// The day's calls so far under this model, the claim relations' and the outcome judge's, and so
// the calls this run has.
async function callsLeft(db: Db, judge: string, now: string, budget: Budget): Promise<number> {
  const model = judge.split("@")[0] as string;
  const [today] = await db.query<{ pairs: number; asked: number }>(
    `select (select count(*) from ledger.relation_checks where split_part(judge, '@', 1) = $1 and other_key is not null and created_at >= date_trunc('day', $2::timestamptz))::int as pairs,
       (select count(*) from ledger.outcome_checks where split_part(judge, '@', 1) = $1 and ${ASKED_OUTCOME_CHECKS} and created_at >= date_trunc('day', $2::timestamptz))::int as asked`,
    [model, now],
  );
  return Math.max(0, Math.min(budget.calls, budget.callsPerDay - 2 * ((today?.pairs ?? 0) + (today?.asked ?? 0))));
}

// The open works with expectations, their channels, and the expectations of the open ones that
// open, by work.
async function openWorks(
  { db, keys, judgeGapDefaults }: Ctx,
  now: string,
): Promise<{ channels: Channel[]; expectations: ExpectationRow[]; byWork: Map<string, ExpectationRow[]> }> {
  const all = await db.query<{ opportunity_id: string }>(
    "select distinct opportunity_id from ledger.expected_outcomes where not policy.is_restricted(compartments) order by 1",
  );
  // Code-raised work is judged when the owner turned it on, and only then.
  const left =
    judgeGapDefaults || all.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db.query<{ opportunity_id: string }>(
              "select opportunity_id from ledger.gap_default_works($1::text[])",
              [all.map((row) => row.opportunity_id)],
            )
          ).map((row) => row.opportunity_id),
        );
  const works = all.filter((row) => !left.has(row.opportunity_id));
  const channels =
    works.length === 0
      ? []
      : await db.query<Channel>("select * from ledger.outcome_channels($1::text[], $2::timestamptz)", [
          works.map((row) => row.opportunity_id),
          now,
        ]);
  const open = new Set(channels.filter((row) => row.kind === null).map((row) => row.opportunity_id));
  const expectations = (
    await db.query<ExpectationRow>(
      `select x.id::text as id, x.opportunity_id, x.ordinal, x.subject_kind, x.subject_id, x.outcome_type, x.success_enc, x.failure_enc, x.compartments,
         (x.subject_kind = 'counterpart' or exists (select 1 from knowledge.entities n where n.id = x.subject_id and n.kind = 'person')) and x.outcome_type = any ($2::text[]) as person
       from ledger.expected_outcomes x where x.opportunity_id = any ($1::text[]) and not policy.is_restricted(x.compartments) order by x.id`,
      [[...open], [...PERSON_TYPES]],
    )
  ).filter((row) => opens(keys, row.compartments));
  const byWork = new Map<string, ExpectationRow[]>();
  for (const row of expectations) byWork.set(row.opportunity_id, [...(byWork.get(row.opportunity_id) ?? []), row]);
  return { channels, expectations, byWork };
}

// What was judged, and what an earlier run left unjudged, under this judge: a candidate's
// state is its latest row.
async function priorStates(
  db: Db,
  judge: string,
): Promise<{
  checked: Set<string>;
  left: { expected_outcome_id: string; evidence_id: string; claim_id: string | null; path: OutcomePath }[];
  unjudged: Set<string>;
}> {
  const states = await db.query<{
    expected_outcome_id: string;
    evidence_id: string;
    state: string;
    claim_id: string | null;
    path: OutcomePath;
  }>(
    `select distinct on (expected_outcome_id, evidence_id) expected_outcome_id::text, evidence_id, state, claim_id, path from ledger.outcome_checks
     where judge = $1 order by expected_outcome_id, evidence_id, id desc`,
    [judge],
  );
  const checked = new Set(
    states.filter((row) => row.state === "judged").map((row) => key(row.expected_outcome_id, row.evidence_id)),
  );
  const left = states.filter((row) => row.state === "unjudged");
  const unjudged = new Set(left.map((row) => key(row.expected_outcome_id, row.evidence_id)));
  return { checked, left, unjudged };
}

// The watched path: the items on each watched channel, after it began, within its grace.
async function findWatched(
  db: Db,
  now: string,
  channels: Channel[],
  byWork: Map<string, ExpectationRow[]>,
  add: (one: Found) => void,
): Promise<void> {
  const nowAt = Date.parse(now);
  const inWindow = (channel: Channel, at: Date): boolean =>
    channel.began_at !== null &&
    at.getTime() >= channel.began_at.getTime() &&
    (channel.until === null || at.getTime() <= channel.until.getTime()) &&
    at.getTime() <= nowAt;
  for (const channel of channels) {
    if (channel.kind === null || channel.watch_key === null) continue;
    const forWork = byWork.get(channel.opportunity_id) ?? [];
    if (forWork.length === 0) continue;
    const ids = await watchedItemIds(db, channel);
    // A series has no item source yet: no writer adds one.
    if (ids.length === 0) continue;
    const items = await db.query<ItemRow>(ITEMS, [ids]);
    for (const row of items) {
      if (!inWindow(channel, row.first_at) || row.direction === "outbound") continue;
      for (const expectation of forWork)
        add({ expectation, evidenceId: row.evidence_id, path: "watched", channel, claimId: null });
    }
  }
}

// The items of one watched channel: a thread's inbound mail, an entity's inbound mail and the
// items of claims about it, a document's other revisions.
async function watchedItemIds(db: Db, channel: Channel): Promise<string[]> {
  if (channel.kind === "thread")
    return (
      await db.query<{ id: string }>(
        `select e.id from vault.evidence_items e join knowledge.messages m on m.evidence_id = e.id
         where e.source_account_id = $1 and e.thread_fp = $2 and m.direction = 'inbound' and not m.bulk order by e.id collate "C"`,
        [channel.account_id, channel.watch_key],
      )
    ).map((row) => row.id);
  if (channel.kind === "entity")
    return (
      await db.query<{ id: string }>(
        `select m.evidence_id as id from knowledge.messages m join knowledge.accounts a on a.value_fp = m.sender_fp
         where a.entity_id = $1 and m.direction = 'inbound' and not m.bulk
         union select c.evidence_id from knowledge.claim_entities x join knowledge.claims c on c.id = x.claim_id where x.entity_id = $1
         order by 1`,
        [channel.watch_key],
      )
    ).map((row) => row.id);
  if (channel.kind === "document")
    return (
      await db.query<{ id: string }>(
        `select d.evidence_id as id from knowledge.documents w join knowledge.documents d on d.file_fp = w.file_fp and d.evidence_id <> w.evidence_id
         where w.id = $1 and not d.held order by 1`,
        [channel.watch_key],
      )
    ).map((row) => row.id);
  return [];
}

// The open path: the claims the pending rechecks name, by subject, an entity of the same
// address, or the organization of the address's domain, against the open entity expectations.
async function findOpen(db: Db, expectations: ExpectationRow[], add: (one: Found) => void): Promise<void> {
  const named = await db.query<ClaimRow & { subjects: string[] }>(
    `select c.id, c.evidence_id, c.fact_key_fp, c.compartments, c.content_enc, array(select x.entity_id from knowledge.claim_entities x where x.claim_id = c.id order by 1) as subjects
     from knowledge.claims c
     where c.id in (select unnest(r.added_claims) from ledger.trigger_rechecks r where r.cause in ('claim', 'backfill'))
       and not c.released and not c.closes and not policy.is_restricted(c.compartments)
     order by c.id collate "C"`,
  );
  const entityExpectations = expectations.filter((row) => row.subject_kind === "entity" && row.subject_id !== null);
  if (entityExpectations.length === 0) return;
  for (const claim of named) {
    const subjects = [...new Set(claim.subjects)];
    if (subjects.length === 0) continue;
    const [wider] = await db.query<{ ids: string[] }>(
      `select array(select distinct one from (
         select unnest($1::text[]) as one
         union select b.entity_id from knowledge.accounts a join knowledge.accounts b on b.value_fp = a.value_fp where a.entity_id = any ($1::text[])
         union select d.entity_id from knowledge.accounts a join knowledge.domains d on d.domain_fp = a.domain_fp where a.entity_id = any ($1::text[])) s order by 1) as ids`,
      [subjects],
    );
    const reach = new Set(wider?.ids ?? subjects);
    for (const expectation of entityExpectations)
      if (reach.has(expectation.subject_id as string))
        add({ expectation, evidenceId: claim.evidence_id, path: "open", channel: null, claimId: claim.id });
  }
}

// Built only while the run's calls can reach them; the rest are marked unjudged without opening
// anything.
async function buildCandidates(
  ctx: Ctx,
  ordered: [string, Found][],
  channels: Channel[],
  unjudged: Set<string>,
  calls: number,
): Promise<{ candidates: OutcomeCandidateRow[]; deferred: OutcomeCheckRow[] }> {
  const { db } = ctx;
  const flags = await itemFacts(
    db.query,
    ordered.map(([, one]) => one.evidenceId),
  );
  const itemRows = new Map(
    (await db.query<ItemRow>(ITEMS, [[...new Set(ordered.map(([, one]) => one.evidenceId))]])).map((row) => [
      row.evidence_id,
      row,
    ]),
  );
  let pairsLeft = Math.floor(calls / 2);
  const candidates: OutcomeCandidateRow[] = [];
  const deferred: OutcomeCheckRow[] = [];
  const threadsOf = new Map<string, Channel[]>();
  for (const channel of channels)
    if (channel.kind === "thread")
      threadsOf.set(channel.opportunity_id, [...(threadsOf.get(channel.opportunity_id) ?? []), channel]);
  const personFps = new Map<string, string[]>();
  for (const [k, one] of ordered) {
    const row = itemRows.get(one.evidenceId);
    if (row === undefined) continue;
    const flagged = flags.get(one.evidenceId)?.flagged ?? false;
    const compartments = labelOf(one.expectation.compartments, row.compartments, one.channel?.compartments ?? []);
    if (restricted(compartments)) continue;
    if (!flagged && pairsLeft <= 0) {
      deferred.push({
        expectationId: one.expectation.id,
        evidenceId: one.evidenceId,
        claimKey: null,
        path: one.path,
        state: "unjudged",
        firstAnswer: null,
        secondAnswer: null,
        agreed: null,
        written: null,
        code: null,
        compartments,
      });
      continue;
    }
    const fps = await personFpsOf(db, one.expectation, personFps);
    const channel =
      one.channel ??
      (threadsOf.get(one.expectation.opportunity_id) ?? []).find(
        (c) => c.account_id === row.account_id && c.watch_key === row.thread_fp,
      ) ??
      null;
    candidates.push(await buildCandidate(ctx, one, row, { channel, fps, flags, flagged, unjudged: unjudged.has(k) }));
    if (!flagged) pairsLeft -= 1;
  }
  return { candidates, deferred };
}

// The person the work waits on, for an entity expectation: its entity's addresses, read once.
async function personFpsOf(
  db: Db,
  expectation: ExpectationRow,
  cache: Map<string, string[]>,
): Promise<string[] | undefined> {
  let fps = expectation.subject_kind === "entity" ? cache.get(expectation.subject_id as string) : undefined;
  if (expectation.subject_kind === "entity" && fps === undefined) {
    fps = (
      await db.query<{ value_fp: string }>(
        "select distinct value_fp from knowledge.accounts where entity_id = $1 order by 1",
        [expectation.subject_id],
      )
    ).map((r) => r.value_fp);
    cache.set(expectation.subject_id as string, fps);
  }
  return fps;
}

// One candidate, its item built: its claims, who sent it, its passage and the facts the judge reads.
async function buildCandidate(
  ctx: Ctx,
  one: Found,
  row: ItemRow,
  context: {
    channel: Channel | null;
    fps: string[] | undefined;
    flags: ItemFlags;
    flagged: boolean;
    unjudged: boolean;
  },
): Promise<OutcomeCandidateRow> {
  const { db, keys } = ctx;
  const { channel, fps, flags, flagged } = context;
  const expectation = one.expectation;
  // The person the work waits on: the expectation's entity's addresses, or the channel's counterparts.
  const expected = new Set(expectation.subject_kind === "counterpart" ? (channel?.counterpart_fps ?? []) : (fps ?? []));
  const claims = (await claimsOfItems(db, [one.evidenceId])).flatMap((claimRow) => {
    const record = claimRecordOf(open(keys, claimRow, "knowledge.claims.content_enc", "null"));
    return record === null ? [] : [{ row: claimRow, record }];
  });
  const senders =
    row.sender_fp === null
      ? []
      : (
          await db.query<{ entity_id: string }>(
            "select distinct entity_id from knowledge.accounts where value_fp = $1",
            [row.sender_fp],
          )
        ).map((r) => r.entity_id);
  const subject = expectation.subject_kind === "entity" ? expectation.subject_id : null;
  const decline = claims.some(
    ({ record }) =>
      DECLINES.has(record.claim.statementKind) &&
      record.claim.assertedBy !== undefined &&
      senders.includes(record.claim.assertedBy),
  );
  const firstHand =
    subject !== null &&
    claims.some(({ record }) => record.claim.assertedBy === subject && record.claim.content.subject === subject);
  const fromPerson =
    (row.sender_fp !== null && row.direction === "inbound" && expected.has(row.sender_fp)) ||
    (subject !== null && claims.some(({ record }) => record.claim.assertedBy === subject));
  const own = one.claimId === null ? undefined : claims.find(({ row: claimRow }) => claimRow.id === one.claimId);
  const passage = await passageOf(ctx, one.evidenceId, row, claims, own);
  const facts = flags.get(one.evidenceId);
  const at = own?.record.claim.validFrom ?? row.first_at.toISOString();
  const afterMove =
    channel !== null &&
    channel.kind === "thread" &&
    channel.moved_at !== null &&
    row.thread_fp === channel.watch_key &&
    row.first_at.getTime() > channel.moved_at.getTime();
  return {
    expectation: expectationOf(keys, expectation),
    item: {
      evidenceId: one.evidenceId,
      claimKey: own === undefined ? null : claimKeyOf(keys, own.row),
      passage,
      at,
      compartments: labelOf(row.compartments, one.channel?.compartments ?? []),
      flagged,
      fromPerson,
      firstHand,
      decline,
      reply:
        one.path === "watched" && channel?.kind === "thread" && row.direction === "inbound" && row.message_id !== null,
      afterMove,
      source: {
        item: one.evidenceId,
        domain: facts?.domain ?? null,
        thread: facts?.thread ?? null,
        agent: facts?.agent ?? false,
        firstHand,
        authenticated: facts?.auth === "pass",
        domainMatches: false,
        at,
        flagged,
      },
    },
    path: one.path,
    unjudged: context.unjudged,
  };
}

// A message's text; else each claim's passage of the item, or what it states in its typed
// words (an import or a record keeps no passage), one a line, the claim found by first.
async function passageOf(
  ctx: Ctx,
  evidenceId: string,
  row: ItemRow,
  claims: { row: ClaimRow; record: ClaimRecord }[],
  own: { row: ClaimRow; record: ClaimRecord } | undefined,
): Promise<string | null> {
  const claimText = async (record: ClaimRecord): Promise<string | null> =>
    (await claimPassage(ctx.db.query, ctx.keys, record, evidenceId)) ?? statedOf(record);
  let passage: string | null = null;
  try {
    if (row.message_id !== null) passage = await messageText(ctx, row.message_id);
    if (passage === null) {
      const ordered = own === undefined ? claims : [own, ...claims.filter((other) => other !== own)];
      const lines = [
        ...new Set(
          (await Promise.all(ordered.map(({ record }) => claimText(record)))).filter(
            (line): line is string => line !== null,
          ),
        ),
      ];
      passage = lines.length === 0 ? null : lines.join("\n");
    }
  } catch {
    passage = null;
  }
  return passage;
}

// The expectation as the judge reads it, its success and failure words opened.
function expectationOf(keys: Keys, expectation: ExpectationRow): OutcomeCandidateRow["expectation"] {
  const sealed = {
    id: `${expectation.opportunity_id}/${expectation.ordinal}`,
    compartments: expectation.compartments,
    success_enc: expectation.success_enc,
    failure_enc: expectation.failure_enc,
  };
  return {
    id: expectation.id,
    opportunityId: expectation.opportunity_id,
    type: expectation.outcome_type,
    success: words(open(keys, sealed, "ledger.expected_outcomes.success_enc", "null")),
    failure: words(open(keys, sealed, "ledger.expected_outcomes.failure_enc", "null")),
    person: expectation.person,
    compartments: [...expectation.compartments].sort(byText),
  };
}

// One transaction: each link, then each check. A check already there is kept, since ledger rows are
// never updated; a candidate holds an unjudged row and a judged one at most.
function saveRun(
  db: Db,
  run: OutcomeRunRow,
  judge: string,
  claimIds: Map<string, string | null>,
): Promise<{ links: number; checks: number }> {
  return db.transaction(async (query) => {
    let links = 0;
    let checks = 0;
    for (const link of run.links) {
      if (restricted(link.compartments)) continue;
      await query(
        `insert into ledger.outcome_links (opportunity_id, expected_outcome_id, evidence_id, claim_key, kind, path, judge, attribution, passage_start, passage_end, applied, compartments)
         values ($1, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text[])`,
        [
          link.opportunityId,
          link.expectationId,
          link.evidenceId,
          link.claimKey,
          link.kind,
          link.path,
          link.judge,
          link.attribution,
          link.passage?.start ?? null,
          link.passage?.end ?? null,
          link.applied,
          labelOf(link.compartments),
        ],
      );
      links += 1;
    }
    for (const check of run.checks) {
      if (restricted(check.compartments)) continue;
      const rows = await query<{ id: string }>(
        `insert into ledger.outcome_checks (expected_outcome_id, evidence_id, claim_key, claim_id, path, judge, state, first_answer, second_answer, agreed, written, code, compartments, judged_at)
         values ($1::bigint, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text[], case when $7 = 'judged' then now() end)
         on conflict (expected_outcome_id, evidence_id, judge, state) do nothing returning id::text`,
        [
          check.expectationId,
          check.evidenceId,
          check.claimKey,
          claimIds.get(key(check.expectationId, check.evidenceId)) ?? null,
          check.path,
          judge,
          check.state,
          check.firstAnswer,
          check.secondAnswer,
          check.agreed,
          check.written,
          check.code,
          labelOf(check.compartments),
        ],
      );
      checks += rows.length;
    }
    return { links, checks };
  });
}
