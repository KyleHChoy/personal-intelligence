import type { EvidenceId, Timestamp } from "@intelligence/contracts";
import {
  type DueCapture,
  MOMENT_BATCH_GROUP_MAX,
  MOMENT_GROUP_MAX,
  type MomentCaptureFacts,
  PersonalEvidenceId,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { MOMENT_THREAD_DAYS, momentBatchCutoff, threadWindows } from "@intelligence/personal-core/lens";
import { byText, stamp } from "../core/db.ts";
import { CAPTURE_LANES, dueWhen } from "../core/lanes.ts";
import { open, type Sealed } from "../core/seal.ts";
import { openStatus } from "../core/status-facts.ts";
import type { Tx } from "../core/tx.ts";
import { ownerZoneOf } from "../core/zone.ts";
import { dueStatus } from "./pipeline-read.ts";

// Which meetings, moments and block days are due for extraction, and how due moments are grouped
// into one call by day, thread window and saved call. Nothing here writes.

type DueCaptureRow = {
  evidence_id: string;
  compartments: string[];
  observed_at: Date;
  status_facts: Sealed | null;
  due: boolean;
};

// `pi extract --capture`: the stored meeting or moment a `cap_` id or capture key names, as
// `pi extract retry --capture` reads it (admin-extraction.ts, captureOf): its latest revision when
// the key has several rows; a block day, or a row the role does not read, is none.
export async function captureNamed(
  tx: Tx,
  value: string,
): Promise<{ evidenceId: EvidenceId; kind: "meeting" | "moment" } | null> {
  const [row] = await tx.query<{ evidence_id: string; kind: "meeting" | "moment" }>(
    "select evidence_id, kind from knowledge.captures where (id = $1 or capture_key = $1) and kind in ('meeting', 'moment') order by revision desc limit 1",
    [value],
  );
  return row === undefined ? null : { evidenceId: PersonalEvidenceId.parse(row.evidence_id), kind: row.kind };
}

// A row is due as `due`'s rows are; with the lane switched on, a row skipped `not_extracted` at
// this generation is due as well. Its status is sealed, so such rows are picked in code, a page at
// a time, before the limit.
const DUE_CAPTURES = `
  select e.id as evidence_id, e.compartments, e.observed_at, p.facts_enc as status_facts, ${dueWhen("$2")} as due
  from knowledge.captures c
  join vault.evidence_items e on e.id = c.evidence_id
  left join vault.pipeline_items p on p.evidence_id = e.id
  where e.source_kind = $1 and c.kind = $8 and e.blob_ref is not null and (c.kind <> 'block' or c.work_enc is not null)
    and (${dueWhen("$2")} or ($7::boolean and not p.waiting and not p.withheld and p.extractor_generation = $2))
    and ($3::text[] is null or e.compartments <@ $3::text[])
    and ($4::timestamptz is null or e.observed_at < $4::timestamptz or (e.observed_at = $4::timestamptz and e.id collate "C" > $5::text))
    and ($9::text is null or e.id = $9::text)
  order by e.observed_at desc, e.id collate "C"
  limit $6`;

const CAPTURE_PAGE = 200;

type DueOptions = {
  switchedOn: boolean;
  compartments?: string[];
  after?: { observedAt: Timestamp; evidenceId: EvidenceId };
  settledBefore?: Timestamp;
  batchedAt?: Timestamp;
  only?: EvidenceId;
};

// A capture lane's due items, by its source kind. A block day split, `time_block`, is for the
// activity step alone, which sends it to no model.
export async function dueCaptures(
  tx: Tx,
  lane: "meeting" | "moment" | "block",
  limit: number,
  generation: number,
  options: DueOptions,
): Promise<DueCapture[]> {
  if (lane === "moment") return dueMomentGroups(tx, limit, generation, options);
  const found: DueCapture[] = [];
  let after: { observedAt: string; evidenceId: string } | undefined = options.after;
  while (found.length < limit) {
    const page = options.switchedOn ? Math.max(limit - found.length, CAPTURE_PAGE) : limit - found.length;
    const rows = await tx.query<DueCaptureRow>(DUE_CAPTURES, [
      CAPTURE_LANES[lane].source,
      generation,
      options.compartments ?? null,
      after?.observedAt ?? null,
      after?.evidenceId ?? null,
      page,
      options.switchedOn,
      lane,
      options.only ?? null,
    ]);
    for (const row of rows) {
      if (found.length >= limit) break;
      const status =
        row.status_facts === null ? undefined : openStatus(tx, row.compartments, row.evidence_id, row.status_facts);
      if (!row.due && !(status?.status === "skipped" && status.code === "not_extracted")) continue;
      found.push({
        evidenceId: PersonalEvidenceId.parse(row.evidence_id),
        compartments: [...row.compartments].sort(byText),
        observedAt: stamp(row.observed_at),
        ...dueStatus(status),
      });
    }
    const last = rows.at(-1);
    if (rows.length < page || last === undefined) break;
    after = { observedAt: stamp(last.observed_at), evidenceId: last.evidence_id };
  }
  return found;
}

// For `pi extract --capture` (`$4`), the named moment's day, and for a source moment the
// MOMENT_THREAD_DAYS - 1 days before it and every day after it, so its thread's windows are cut
// from its newest due day as a run cuts them and the window that holds it is read whole.
const MOMENT_DAYS = `
  select c.local_day::text as day from knowledge.captures c
  where c.kind = 'moment'
    and ($1::timestamptz is null or c.local_day <= ($1::timestamptz at time zone 'utc')::date + 1)
    and ($2::date is null or c.local_day < $2::date)
    and ($4::text is null or exists (
      select 1 from knowledge.captures k where k.evidence_id = $4::text and k.kind = 'moment'
        and c.local_day >= k.local_day - (case when k.source is null then 0 else $5::int - 1 end) and (k.source is not null or c.local_day = k.local_day)))
  group by c.local_day
  order by c.local_day desc
  limit $3`;

// The moments that may be due on those days, with what groups them, as DUE_CAPTURES reads a
// meeting's rows: whole local days at once, since a group never cuts a day. With `source`, whether
// it is a source moment, whose thread is grouped over several days; `--capture` (`$6`) takes the
// named moment's thread on the days MOMENT_DAYS reads for it.
const DUE_MOMENTS = `
  select e.id as evidence_id, e.compartments, e.observed_at, p.facts_enc as status_facts, ${dueWhen("$2")} as due,
    c.local_day::text as local_day, c.bundle_fp, c.thread_fp, c.agent_app, c.source is not null as source,
    ($5::timestamptz is not null and c.first_pushed_at > $5::timestamptz) as after_cutoff, c.id as capture_id,
    case when $5::timestamptz is not null and c.first_pushed_at > $5::timestamptz then c.facts_enc end as capture_facts, c.compartments as capture_compartments
  from knowledge.captures c
  join vault.evidence_items e on e.id = c.evidence_id
  left join vault.pipeline_items p on p.evidence_id = e.id
  where e.source_kind = 'screen_activity' and c.kind = 'moment' and e.blob_ref is not null
    and (${dueWhen("$2")} or ($3::boolean and not p.waiting and not p.withheld and p.extractor_generation = $2))
    and ($1::text[] is null or e.compartments <@ $1::text[])
    and c.local_day = any ($4::date[])
    and ($6::text is null or exists (
      select 1 from knowledge.captures k join vault.evidence_items o on o.id = k.evidence_id
      where k.evidence_id = $6::text and k.kind = 'moment' and k.agent_app = c.agent_app
        and (k.local_day = c.local_day or (k.source is not null and c.source is not null and c.local_day - k.local_day > -$7::int))
        and k.bundle_fp is not distinct from c.bundle_fp and k.thread_fp is not distinct from c.thread_fp
        and o.compartments @> e.compartments and o.compartments <@ e.compartments))
  order by e.observed_at, e.id collate "C"`;

// The local days after a page's newest that hold a source moment, read once on
// a page past a cursor, so a source thread's windows are cut from its newest due day as on the
// first page (threadWindows reads from the newest day down): their groups come before the cursor
// and are left out, and their days only fix where the older windows begin.
const NEWER_SOURCE_DAYS = `
  select c.local_day::text as day from knowledge.captures c
  join vault.evidence_items e on e.id = c.evidence_id
  left join vault.pipeline_items p on p.evidence_id = e.id
  where c.kind = 'moment' and c.source is not null and c.local_day > $1::date and e.blob_ref is not null
    and (${dueWhen("$2")} or ($3::boolean and not p.waiting and not p.withheld and p.extractor_generation = $2))
    and ($4::text[] is null or e.compartments <@ $4::text[])
  group by c.local_day
  order by c.local_day desc`;

// The local days one read of DUE_MOMENTS takes.
const MOMENT_DAYS_READ = 3;

type DueMomentRow = DueCaptureRow & {
  local_day: string;
  bundle_fp: string | null;
  thread_fp: string | null;
  agent_app: boolean;
  source: boolean;
  after_cutoff: boolean;
  capture_id: string;
  capture_facts: Sealed | null;
  capture_compartments: string[];
};

// Newest latest moment first, its evidence id breaking a tie in byte order.
const groupOrder = (
  a: { observedAt: string; evidenceId: string },
  b: { observedAt: string; evidenceId: string },
): number =>
  Date.parse(b.observedAt) - Date.parse(a.observedAt) ||
  (a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0);

async function savedSets(tx: Tx, evidenceIds: string[]): Promise<Map<string, string[]>> {
  if (evidenceIds.length === 0) return new Map();
  const newest = new Map<string, string>();
  for (const row of await tx.query<{ call_id: string; evidence_id: string }>(
    'select call_id, evidence_id from vault.model_call_members where evidence_id = any($1) order by call_id collate "C" desc, evidence_id',
    [evidenceIds],
  )) {
    if (!newest.has(row.evidence_id)) newest.set(row.evidence_id, row.call_id);
  }
  const calls = [...new Set(newest.values())];
  const members = new Map<string, string[]>();
  for (const row of await tx.query<{ call_id: string; evidence_id: string }>(
    "select call_id, evidence_id from vault.model_call_members where call_id = any($1) order by call_id, evidence_id",
    [calls],
  )) {
    members.set(row.call_id, [...(members.get(row.call_id) ?? []), row.evidence_id]);
  }
  return new Map([...newest].map(([evidenceId, call]) => [evidenceId, members.get(call) ?? [evidenceId]]));
}

// Two saved sets that share a due moment merge into one group, whose request is asked again.
export function regrouped<M extends { evidenceId: string }>(
  members: M[],
  saved: ReadonlyMap<string, readonly string[]>,
): M[][] {
  const due = new Set(members.map((one) => one.evidenceId));
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    let at = id;
    while (parent.has(at) && parent.get(at) !== at) at = parent.get(at) as string;
    return at;
  };
  for (const one of members) {
    const set = saved.get(one.evidenceId);
    if (set === undefined) continue;
    if (!parent.has(one.evidenceId)) parent.set(one.evidenceId, one.evidenceId);
    for (const other of set) {
      if (!due.has(other)) continue;
      if (!parent.has(other)) parent.set(other, other);
      const [a, b] = [root(one.evidenceId), root(other)];
      if (a !== b) parent.set(b, a);
    }
  }
  const groups = new Map<string, M[]>();
  const rest: M[] = [];
  for (const one of members) {
    if (!parent.has(one.evidenceId)) rest.push(one);
    else {
      const key = root(one.evidenceId);
      groups.set(key, [...(groups.get(key) ?? []), one]);
    }
  }
  return [...groups.values(), ...(rest.length === 0 ? [] : [rest])];
}

// The groups are formed from whole local days before the cursor and the limit apply, so a page
// never cuts one. A page reads its days newest first, MOMENT_DAYS_READ at a time, and stops once it
// holds `limit` groups that no day it has not read can come before: a group of an earlier day has
// its latest moment before the UTC midnight that ends the earliest day read.
//
// The batched mode (`batchedAt`, the run's time): only the moments first pushed at
// or before the cutoff (the latest 00:00 or 12:00 on the owner's clock at or before the run) are
// read, every group is settled by then, and a group holds up to MOMENT_BATCH_GROUP_MAX, so each
// half day makes one group per bundle, thread, local day and label.
//
// A window's latest moment is its newest day's, and older days only add members to it, so the page
// reads MOMENT_THREAD_DAYS more days before it counts such a group as whole.
async function dueMomentGroups(tx: Tx, limit: number, generation: number, options: DueOptions): Promise<DueCapture[]> {
  const { after, batchedAt } = options;
  const cutoff =
    batchedAt === undefined ? null : momentBatchCutoff(new Date(batchedAt), await ownerZoneOf(tx.query)).toISOString();
  const { settledBefore } = options;
  if (cutoff === null && settledBefore === undefined)
    throw new Error("dueCaptures: the moment lane needs settledBefore or batchedAt");
  const most = cutoff === null ? MOMENT_GROUP_MAX : MOMENT_BATCH_GROUP_MAX;
  type Member = Omit<DueCapture, "moments">;
  const read: { member: Member; day: string; base: string; source: boolean }[] = [];
  let groups: DueCapture[] = [];
  let before: string | null = null;
  let sources = false;
  // Each due moment's newest saved call's members, asked once a moment.
  const saved = new Map<string, string[]>();
  const asked = new Set<string>();
  // The due moments of these days, each read once; with `sourceOnly`, the source moments alone.
  const take = async (days: string[], sourceOnly = false): Promise<void> => {
    const rows = await tx.query<DueMomentRow>(DUE_MOMENTS, [
      options.compartments ?? null,
      generation,
      options.switchedOn,
      days,
      cutoff,
      options.only ?? null,
      MOMENT_THREAD_DAYS,
    ]);
    for (const row of rows) {
      if (sourceOnly && !row.source) continue;
      const status =
        row.status_facts === null ? undefined : openStatus(tx, row.compartments, row.evidence_id, row.status_facts);
      // An agent app's moment is then committed `agent_app`, which is not taken again.
      const retaken = status?.status === "skipped" && status.code === "not_extracted";
      if (!row.due && !retaken) continue;
      // The batched mode: a moment pushed after the cutoff waits for the next half
      // day, but a page, which no model is sent, is due at once, in a group of pages of its own.
      let page = false;
      if (row.after_cutoff) {
        const facts = JSON.parse(
          open(
            tx.keys,
            { id: row.capture_id, compartments: row.capture_compartments, facts_enc: row.capture_facts },
            "knowledge.captures.facts_enc",
            "throw",
          ),
        ) as MomentCaptureFacts;
        if (facts.entity !== "page") continue;
        page = true;
      }
      const compartments = [...row.compartments].sort(byText);
      // An agent app's moments are never grouped with another's; a source moment's thread over days.
      const source = row.source && !page;
      sources ||= source;
      read.push({
        member: {
          evidenceId: PersonalEvidenceId.parse(row.evidence_id),
          compartments,
          observedAt: stamp(row.observed_at),
          ...dueStatus(status),
        },
        day: row.local_day,
        base: JSON.stringify([row.bundle_fp, row.thread_fp, compartments, page, row.agent_app, source]),
        source,
      });
    }
  };
  for (;;) {
    const days: string[] = (
      await tx.query<{ day: string }>(MOMENT_DAYS, [
        after?.observedAt ?? null,
        before,
        MOMENT_DAYS_READ,
        options.only ?? null,
        MOMENT_THREAD_DAYS,
      ])
    ).map((row) => row.day);
    if (days.length === 0) break;
    await take(days);
    if (before === null && after !== undefined && options.only === undefined && days[0] !== undefined) {
      const newer = (
        await tx.query<{ day: string }>(NEWER_SOURCE_DAYS, [
          days[0],
          generation,
          options.switchedOn,
          options.compartments ?? null,
        ])
      ).map((row) => row.day);
      if (newer.length > 0) await take(newer, true);
    }
    read.sort(
      (a, b) =>
        Date.parse(a.member.observedAt) - Date.parse(b.member.observedAt) ||
        (a.member.evidenceId < b.member.evidenceId ? -1 : a.member.evidenceId > b.member.evidenceId ? 1 : 0),
    );
    // `--capture` is the owner's re-ask of a thread, so it is not regrouped by saved calls: a
    // moment once asked alone would otherwise stay a group of its own, and its thread's other
    // moments would never join it.
    if (options.only === undefined) {
      const fresh = read.map((one) => one.member.evidenceId).filter((id) => !asked.has(id));
      for (const id of fresh) asked.add(id);
      for (const [id, members] of await savedSets(tx, fresh)) saved.set(id, members);
    }
    groups = momentGroups(read, saved, { most, cutoff, settledBefore, after, only: options.only });
    before = days[days.length - 1] ?? null;
    if (days.length < MOMENT_DAYS_READ || before === null) break;
    const final = Date.parse(`${before}T00:00:00Z`) + DAY_MS * (sources ? MOMENT_THREAD_DAYS + 1 : 1);
    if (groups.filter((group) => Date.parse(group.observedAt) >= final).length >= limit) break;
  }
  return groups.sort(groupOrder).slice(0, limit);
}

// The groups of the due moments read, in observed order: a screen moment's by its local day, a
// source moment's by its thread's window, each key's members regrouped by their saved calls and
// chunked by `most`, a chunk due once its latest moment settled.
function momentGroups(
  read: { member: Omit<DueCapture, "moments">; day: string; base: string; source: boolean }[],
  saved: ReadonlyMap<string, readonly string[]>,
  options: {
    most: number;
    cutoff: string | null;
    settledBefore: Timestamp | undefined;
    after: DueOptions["after"];
    only: EvidenceId | undefined;
  },
): DueCapture[] {
  const { most, cutoff, settledBefore, after, only } = options;
  const days = new Map<string, string[]>();
  for (const { base, day, source } of read) {
    if (!source) continue;
    const list = days.get(base);
    if (list === undefined) days.set(base, [day]);
    else list.push(day);
  }
  const windows = new Map([...days].map(([base, list]) => [base, threadWindows(list)]));
  const keyed = new Map<string, Omit<DueCapture, "moments">[]>();
  for (const { member, day, base, source } of read) {
    const key = JSON.stringify([source ? windows.get(base)?.get(day) : day, base]);
    const list = keyed.get(key);
    if (list === undefined) keyed.set(key, [member]);
    else list.push(member);
  }
  const groups: DueCapture[] = [];
  for (const members of [...keyed.values()].flatMap((one) => regrouped(one, saved))) {
    for (let at = 0; at < members.length; at += most) {
      const chunk = members.slice(at, at + most);
      const lead = chunk[chunk.length - 1];
      // In the batched mode every moment read was pushed by the cutoff, so none waits to settle
      // (a Mac clock ahead of the box's would otherwise hold one a half day more).
      if (lead === undefined || (cutoff === null && Date.parse(lead.observedAt) > Date.parse(settledBefore as string)))
        continue;
      const group = { ...lead, moments: chunk };
      // `pi extract --capture` names one moment and takes the group that holds it.
      if (only !== undefined && !chunk.some((one) => one.evidenceId === only)) continue;
      if (after === undefined || groupOrder(after, group) < 0) groups.push(group);
    }
  }
  return groups;
}

// An agent-app rule's moments, newest first, in the groups a run forms (one bundle, thread, local day
// and label). Their status is sealed, so a moment committed `agent_app` is picked here, and whether it
// holds a line of the owner's only by opening it.
const OWN_LINE_CANDIDATES = `
  select e.id as evidence_id, e.compartments, e.observed_at, p.facts_enc as status_facts,
    c.local_day::text as local_day, c.bundle_fp, c.thread_fp
  from knowledge.captures c
  join vault.evidence_items e on e.id = c.evidence_id
  join vault.pipeline_items p on p.evidence_id = e.id
  where e.source_kind = 'screen_activity' and c.kind = 'moment' and c.agent_app and e.blob_ref is not null
    and not p.waiting and not p.withheld
    and ($1::text[] is null or e.compartments <@ $1::text[])
  order by e.observed_at desc, e.id collate "C"
  limit $2`;

export async function ownLineCandidates(
  tx: Tx,
  limit: number,
  options: { compartments?: string[] },
): Promise<DueCapture[]> {
  const rows = await tx.query<{
    evidence_id: string;
    compartments: string[];
    observed_at: Date;
    status_facts: Sealed | null;
    local_day: string;
    bundle_fp: string | null;
    thread_fp: string | null;
  }>(OWN_LINE_CANDIDATES, [options.compartments ?? null, limit]);
  const groups = new Map<string, Omit<DueCapture, "moments">[]>();
  for (const row of rows) {
    const status = openStatus(tx, row.compartments, row.evidence_id, row.status_facts);
    if (status?.status !== "skipped" || status.code !== "agent_app") continue;
    const compartments = [...row.compartments].sort(byText);
    const key = JSON.stringify([row.local_day, row.bundle_fp, row.thread_fp, compartments]);
    const group = groups.get(key) ?? [];
    groups.set(key, group);
    if (group.length < MOMENT_BATCH_GROUP_MAX)
      group.push({
        evidenceId: PersonalEvidenceId.parse(row.evidence_id),
        compartments,
        observedAt: stamp(row.observed_at),
        ...dueStatus(status),
      });
  }
  // Each group in observed order and led by its newest, as a run forms it, so its request is the one
  // a run asks and the saved call replays.
  return [...groups.values()].map((newestFirst) => {
    const moments = newestFirst.reverse();
    return { ...(moments[moments.length - 1] as Omit<DueCapture, "moments">), moments };
  });
}
