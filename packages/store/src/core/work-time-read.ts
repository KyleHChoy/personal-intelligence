import { CaptureWork, canonicalTimeZone, TASK_ITEMS, type Who, WORK_ITEMS } from "@intelligence/contracts/personal";
import {
  blockIntervals,
  deviceAnchorKey,
  type SortTitles,
  titleKeysOf,
  type WorkCommitment,
  type WorkInputs,
  type WorkProject,
  type WorkRequest,
  type WorkRow,
  type WorkViews,
  workTime,
  workWindows,
} from "@intelligence/personal-core/lens";
import { fingerprint } from "./fingerprint.ts";
import { TITLE_LINK_TYPE } from "./link-types.ts";
import { type Ctx, noteServed, type Sealed, untrusted } from "./read-ctx.ts";
import { ownerTimeZone } from "./zone.ts";

// Work time at read. `workViews` gathers, under the caller's token as pi_reader, what core's
// `workTime` takes, one statement per kind of input, over the union of the windows the request
// serves (core's `workWindows`), never their hull, and calls it: the projects, the task rows whole
// (newest latest event first, at most TASK_ITEMS), the other capture rows the windows touch (at most
// WORK_ITEMS, the oldest left out), their project links and the live device anchors. Every row is
// one the token returns, so a row the caller cannot see changes nothing it is served. It writes
// nothing; `shown` joins the read log of the tool that serves the views. admin-work-time.ts runs the
// same gathering as pi_admin for `pi time`.

// What the gathering reads with: a statement runner, a way to open a sealed column, and for
// pi_admin the compartments the row policies give pi_reader.
export type Source = {
  run<Row>(text: string, values: unknown[]): Promise<Row[]>;
  open(table: string, column: string, row: Sealed): string;
  within: string[] | null;
  // The supports, by stored claim id, of the beliefs of these fact keys computed under the caller's
  // clearance, which decide a title link.
  supportOf: SupportOf;
  clearance(): Promise<string[]>;
  // An anchor key's keyed fingerprint, to meet agents' anchors. A source without it
  // (the daily pass's) reads no agent anchor or ruling.
  anchorFp?: (key: string) => string;
};

const CLEARANCE = "select policy.client_clearance() as clearance";

const PROJECTS = `
  select p.id, p.status, p.name_enc, p.compartments from knowledge.projects p
  where ($1::text[] is null or p.compartments <@ $1::text[])
  order by p.id`;

const TASKS = `
  select c.id, c.evidence_id, c.started_at, c.ended_at, c.compartments, c.work_enc from knowledge.captures c
  where c.kind = 'task' and ($2::text[] is null or c.compartments <@ $2::text[])
  order by c.ended_at desc, c.id
  limit $1`;

const ROWS = `
  select c.id, c.evidence_id, c.kind, c.started_at, c.ended_at, c.minutes, c.local_day::text as day, c.compartments, c.work_enc
  from knowledge.captures c
  where c.kind <> 'task' and ($4::text[] is null or c.compartments <@ $4::text[])
    and exists (select 1 from unnest($1::timestamptz[], $2::timestamptz[]) as w (f, t) where c.ended_at >= w.f and c.started_at < w.t)
  order by c.started_at desc, c.id
  limit $3`;

// A stretch waiting on the owner's answer to a card credits nothing, and neither does a lifted one.
const RULINGS = `
  select r.from_at, r.to_at, r.project_id, r.source, r.proposal_id, r.compartments from knowledge.time_rulings r
  where r.lifted_at is null and r.pending_card is null and ($3::text[] is null or r.compartments <@ $3::text[])
    and exists (select 1 from unnest($1::timestamptz[], $2::timestamptz[]) as w (f, t) where r.to_at > w.f and r.from_at < w.t)
  order by r.from_at, r.id`;

// The supports, by stored claim id, of the beliefs of the fact keys given, computed when asked under
// the caller's clearance: read/computed-beliefs.ts beliefsAt's `row.support`, or ownerBeliefs'
// `support` for an owner read.
export type SupportOf = (factKeys: readonly string[]) => Promise<readonly (readonly string[])[]>;

// The one rule, for every statement that reads a capture item's project link: claim `alias` is its
// capture.anchor fact, or a capture.project claim among `$believed`, the ids `believedLinks` gives.
export const linkOf = (alias: string, believed: string): string => `(${alias}.type = 'capture.anchor'
         or (${alias}.type = '${TITLE_LINK_TYPE}' and ${alias}.id = any(${believed}::text[])))`;

// The title links among `claims` that a belief computed when asked counts.
export async function believedLinks(
  claims: readonly { id: string; type: string; fact_key_fp: string }[],
  supportOf: SupportOf,
): Promise<string[]> {
  const titles = claims.filter((one) => one.type === TITLE_LINK_TYPE);
  if (titles.length === 0) return [];
  const counted = new Set((await supportOf([...new Set(titles.map((one) => one.fact_key_fp))])).flat());
  return [...new Set(titles.filter((one) => counted.has(one.id)).map((one) => one.id))].sort();
}

// Every candidate link of these capture items, a capture.anchor fact or a title link, which
// `believedLinks` then keeps or drops.
const LINK_CANDIDATES = `
  select distinct k.id as capture, n.entity_id as project, c.id, c.type, c.fact_key_fp
  from knowledge.captures k
  join knowledge.claims c on c.evidence_id = k.evidence_id
  join knowledge.claim_entities n on n.claim_id = c.id
  join knowledge.projects p on p.id = n.entity_id
  where k.id = any($1::text[]) and ($2::text[] is null or c.compartments <@ $2::text[])
    and c.type in ('capture.anchor', '${TITLE_LINK_TYPE}')
  order by 1, 2, 3`;

async function linksOf(source: Source, captures: readonly string[]): Promise<{ capture: string; project: string }[]> {
  const candidates = await source.run<{
    capture: string;
    project: string;
    id: string;
    type: string;
    fact_key_fp: string;
  }>(LINK_CANDIDATES, [captures, source.within]);
  const believed = new Set(await believedLinks(candidates, source.supportOf));
  const seen = new Set<string>();
  return candidates.flatMap(({ capture, project, id, type }) => {
    const pair = `${capture}\n${project}`;
    if (seen.has(pair) || (type === TITLE_LINK_TYPE && !believed.has(id))) return [];
    seen.add(pair);
    return [{ capture, project }];
  });
}

// A window title anchor has no value; its key is its anchor_fp, compared with a title's sealed
// fingerprints (titleKeysOf), so the read opens no title.
const ANCHORS = `
  select a.id, a.project_id, a.kind, a.anchor_fp, a.value_enc, a.compartments from knowledge.project_anchors a
  where a.lifted_at is null and a.kind in ('app', 'host', 'url_prefix', 'repository', 'document', 'window_title')
    and ($1::text[] is null or a.compartments <@ $1::text[])
  order by a.id`;

// Agents' live anchors, compared by fingerprint with the blocks' strong keys, and
// their live rulings any window touches.
const AGENT_ANCHORS = `
  select a.project_id, a.anchor_fp from knowledge.agent_anchors a
  where a.lifted_at is null and ($1::text[] is null or a.compartments <@ $1::text[])
  order by a.id`;
const AGENT_RULINGS = `
  select r.from_at, r.to_at, r.project_id, r.compartments, r.reach
  from knowledge.agent_time_rulings r
  where r.lifted_at is null and ($3::text[] is null or r.compartments <@ $3::text[])
    and exists (select 1 from unnest($1::timestamptz[], $2::timestamptz[]) as w (f, t) where r.to_at > w.f and r.from_at < w.t)
  order by r.from_at, r.id`;

type CaptureRowDb = {
  id: string;
  evidence_id: string;
  kind: WorkRow["kind"];
  started_at: Date;
  ended_at: Date;
  minutes: string | number | null;
  day: string | null;
  compartments: string[];
  work_enc: unknown;
};

// A row's work_enc, opened; one that does not parse is counted as pending, as a null one is.
function workOf(source: Source, row: CaptureRowDb): WorkRow {
  let work: WorkRow["work"] = null;
  if (row.work_enc !== null) {
    let value: unknown = null;
    try {
      value = JSON.parse(
        source.open("knowledge.captures", "work_enc", {
          id: row.id,
          compartments: row.compartments,
          value_enc: row.work_enc,
        }),
      );
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const parsed = CaptureWork.safeParse(value);
    if (parsed.success) work = parsed.data;
  }
  return {
    id: row.id,
    evidence: row.evidence_id,
    kind: row.kind,
    startedAt: row.started_at.getTime(),
    endedAt: row.ended_at.getTime(),
    minutes: row.minutes === null ? null : Number(row.minutes),
    day: row.day ?? null,
    compartments: row.compartments,
    work,
  };
}

export async function gather(
  source: Source,
  request: WorkRequest,
  now: Date,
  zone: string | null,
  commitments: readonly WorkCommitment[] = [],
): Promise<WorkViews> {
  return workTime(await gatherInputs(source, request, now, zone, commitments), request);
}

// What core's function takes. A project's name is opened only for an active project or one a link,
// an anchor or a ruling names. `commitments`: the commitments a call serves, for the matcher, from
// commitmentsOf.
export async function gatherInputs(
  source: Source,
  request: WorkRequest,
  now: Date,
  zone: string | null,
  commitments: readonly WorkCommitment[] = [],
): Promise<WorkInputs> {
  const projectRows = await source.run<{ id: string; status: string; name_enc: unknown; compartments: string[] }>(
    PROJECTS,
    [source.within],
  );
  const taskRows = await source.run<CaptureRowDb>(TASKS, [TASK_ITEMS + 1, source.within]);
  const tasks = taskRows
    .slice(0, TASK_ITEMS)
    .map((row) => workOf(source, { ...row, kind: "task", minutes: null, day: null }));
  const projectOf = (row: (typeof projectRows)[number]): WorkProject => {
    const name = source.open("knowledge.projects", "name_enc", {
      id: row.id,
      compartments: row.compartments,
      value_enc: row.name_enc,
    });
    const who: Who = { id: row.id as Who["id"], kind: "project", name: { untrusted: name }, address: null };
    return { id: row.id, who, name, compartments: row.compartments, active: row.status === "active" };
  };
  const active = projectRows.filter((row) => row.status === "active").map(projectOf);
  const windows = workWindows(request, { rows: tasks, commitments, projects: active, zone, now: now.getTime() });
  const found =
    windows.length === 0
      ? []
      : await source.run<CaptureRowDb>(ROWS, [
          windows.map((one) => new Date(one.from).toISOString()),
          windows.map((one) => new Date(one.to).toISOString()),
          WORK_ITEMS + 1,
          source.within,
        ]);
  const rows = found.slice(0, WORK_ITEMS).map((row) => workOf(source, row));
  const linked = rows.filter((row) => row.kind === "meeting" || row.kind === "moment").map((row) => row.id);
  const links = linked.length === 0 ? [] : await linksOf(source, linked);
  const anchorRows = await source.run<{
    id: string;
    project_id: string;
    kind: Parameters<typeof deviceAnchorKey>[0];
    anchor_fp: string;
    value_enc: unknown;
    compartments: string[];
  }>(ANCHORS, [source.within]);
  const anchors = anchorRows.flatMap((row) => {
    if (row.kind === "window_title")
      return titleKeysOf([row.anchor_fp]).map((key) => ({ key, project: row.project_id }));
    const answer = deviceAnchorKey(
      row.kind,
      source.open("knowledge.project_anchors", "value_enc", {
        id: row.id,
        compartments: row.compartments,
        value_enc: row.value_enc,
      }),
    );
    return "key" in answer ? [{ key: answer.key, project: row.project_id }] : [];
  });
  const rulingRows =
    windows.length === 0
      ? []
      : await source.run<{
          from_at: Date;
          to_at: Date;
          project_id: string | null;
          source: "owner" | "system";
          proposal_id: string | null;
          compartments: string[];
        }>(RULINGS, [
          windows.map((one) => new Date(one.from).toISOString()),
          windows.map((one) => new Date(one.to).toISOString()),
          source.within,
        ]);
  const rulings = rulingRows.map((row) => ({
    from: row.from_at.getTime(),
    to: row.to_at.getTime(),
    project: row.project_id,
    source: row.source,
    compartments: row.compartments,
    ...(row.proposal_id === null ? {} : { proposal: row.proposal_id }),
  }));
  const agents = await agentInputs(source, rows, windows);
  const named = new Set([
    ...links.map((one) => one.project),
    ...anchors.map((one) => one.project),
    ...rulings.flatMap((one) => (one.project === null ? [] : [one.project])),
    ...agents.agentAnchors.map((one) => one.project),
    ...agents.agentRulings.map((one) => one.project),
  ]);
  const projects = [
    ...active,
    ...projectRows.filter((row) => row.status !== "active" && named.has(row.id)).map(projectOf),
  ];
  return {
    rows: [...rows, ...tasks],
    links,
    rulings,
    ...agents,
    anchors,
    projects,
    commitments,
    partial: { rows: found.length > WORK_ITEMS, tasks: taskRows.length > TASK_ITEMS },
    clearance: await source.clearance(),
    zone,
    now: now.getTime(),
  };
}

// What agents set, as the source may read it. An anchor's fingerprint is met with the
// fingerprints of the strong keys of the blocks the read holds, and given as that key.
async function agentInputs(
  source: Source,
  rows: readonly WorkRow[],
  windows: readonly { from: number; to: number }[],
): Promise<Required<Pick<WorkInputs, "agentAnchors" | "agentRulings">>> {
  const { anchorFp } = source;
  if (anchorFp === undefined) return { agentAnchors: [], agentRulings: [] };
  const anchorRows = await source.run<{ project_id: string; anchor_fp: string }>(AGENT_ANCHORS, [source.within]);
  const keyOf = new Map<string, string>();
  if (anchorRows.length > 0)
    for (const block of blockIntervals(rows))
      for (const key of block.keys) if (key.strong && !keyOf.has(key.key)) keyOf.set(key.key, anchorFp(key.key));
  const byFp = new Map([...keyOf.entries()].map(([key, fp]) => [fp, key]));
  const agentAnchors = anchorRows.flatMap((row) => {
    const key = byFp.get(row.anchor_fp);
    return key === undefined ? [] : [{ key, project: row.project_id }];
  });
  const rulingRows =
    windows.length === 0
      ? []
      : await source.run<{ from_at: Date; to_at: Date; project_id: string; compartments: string[]; reach: string[] }>(
          AGENT_RULINGS,
          [
            windows.map((one) => new Date(one.from).toISOString()),
            windows.map((one) => new Date(one.to).toISOString()),
            source.within,
          ],
        );
  // Of a ruling's reach, only what the caller is cleared for: a block it can see is within one exactly
  // when it is within the other, and no compartment it is not cleared for reaches core.
  const clearance = rulingRows.length === 0 ? [] : await source.clearance();
  const agentRulings = rulingRows.map((row) => ({
    from: row.from_at.getTime(),
    to: row.to_at.getTime(),
    project: row.project_id,
    compartments: row.compartments,
    reach: row.reach.filter((one) => clearance.includes(one)),
  }));
  return { agentAnchors, agentRulings };
}

// A sealed value the reader opens, as text, under the row's compartments.
const readerSource = (ctx: Ctx, supportOf: SupportOf): Source => ({
  run: (text, values) => ctx.run(text, values),
  open: (table, column, row) => untrusted(ctx, table, column, row).untrusted,
  within: null,
  clearance: async () => (await ctx.run<{ clearance: string[] | null }>(CLEARANCE, []))[0]?.clearance ?? [],
  anchorFp: (key) => fingerprint(ctx.keys, "anchor", key),
  supportOf,
});

// `titlesOf`, get_work_time's for the title role: the titles of what the read holds, or none.
export async function workViews(
  ctx: Ctx,
  request: WorkRequest,
  now: Date,
  commitments: readonly WorkCommitment[],
  titlesOf: ((rows: readonly WorkRow[]) => Promise<SortTitles | undefined>) | undefined,
  supportOf: SupportOf,
): Promise<WorkViews> {
  const inputs = await gatherInputs(readerSource(ctx, supportOf), request, now, await ownerTimeZone(ctx), commitments);
  const titles = titlesOf === undefined ? undefined : await titlesOf(inputs.rows);
  const views = workTime(titles === undefined ? inputs : { ...inputs, titles }, request);
  noteServed(ctx, { shown: views.shown });
  return views;
}

// The owner's zone as core/zone.ts reads it, for pi_admin's own transaction.
export const zoneOfSetting = (zone: string | null): string | null => (zone === null ? null : canonicalTimeZone(zone));
