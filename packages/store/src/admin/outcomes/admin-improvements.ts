import type { Timestamp } from "@intelligence/contracts";
import {
  type FixNoneCode,
  HEALTH_PARTS_MOST,
  HealthPartKey,
  type ImprovementArea,
  type ImprovementSeverity,
  type ImprovementStatus,
  OPEN_IMPROVEMENT_STATUSES,
} from "@intelligence/contracts/personal";
import { KIND_REGISTRY_DATA } from "@intelligence/contracts/personal/kinds";
import { DAY_MS } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { newId } from "../../core/ids.ts";
import type { Sealed } from "../../core/seal.ts";
import { open, sealUnder } from "../../core/seal.ts";
import { lever } from "../../core/settings.ts";
import { CARD_STATE, IMPROVEMENT_OPEN, improvementStatus } from "../../core/statements.ts";
import { decideDefectRole } from "../admin-tasks.ts";
import { unrestrictedOf } from "../admin-time-base.ts";
import { type OutcomeTestView, outcomeTestView } from "./admin-outcome-tests.ts";
import { type OutcomesView, outcomes } from "./admin-outcomes.ts";
import {
  CAUSE_KINDS,
  emptiedNote,
  type FilingInput,
  type FoundCause,
  filingWords,
  findCauses,
  healthSubject,
  kindOfCause,
  NO_DATA_STATE,
  recoveredNote,
} from "./improvement-filing.ts";
import { servedPartKey } from "./served-parts.ts";

// The improvement store's owner side, as pi_admin: `pia improvements`, which reads it in ids, counts and
// codes, and `pia improvements file`, the daily pass, which writes through two definer functions and
// opens nothing.

const WINDOW_DAYS = 14;
// A second reading must be a separate look: a pass run twice in a morning is one reading.
const READING_GAP_HOURS = 12;

const EARLIER = `
  select distinct on (metric) metric, state from ledger.measure_readings
  where read_at <= $1 order by metric, read_at desc, id desc`;
const OPEN_CAUSES = `
  select i.cause, i.cause_state, i.compartments from ledger.improvements i
  where i.cause is not null and ${IMPROVEMENT_OPEN}`;
// The reading's time to the microsecond, as text: a defect closed in the same millisecond as a
// later red reading must still reopen (ledger.file_improvement compares the two times).
const NIGHTLY = `select value, to_char(read_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as read_at
  from ledger.measure_readings where metric = 'nightly_red' order by read_at desc, id desc limit 1`;
const FILE = `select improvement_id, action from ledger.file_improvement($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text[], $10::text, $11::jsonb, $12::jsonb, $13::jsonb, $14::timestamptz)`;
const CLOSE = "select ledger.close_improvement_cause($1::text, $2::text, $3::text, $4::jsonb, $5::text) as improvement";
// The box health cards standing open, each with its kind and what it is about, from its case key.
const HEALTH_CARDS = `
  select c.id, (regexp_match(c.case_key, '^box:([a-z_]+):'))[1] as kind,
    (regexp_match(c.case_key, '^box:[a-z_]+:(.+)$'))[1] as about, c.compartments, c.created_at
  from ledger.cards c
  where c.kind = 'box_health' and c.created_by = 'system:health' and c.tainted_at is null
    and ${CARD_STATE} in ('pending', 'deferred')
  order by c.created_at, c.id`;
// Each lever's latest change, for the guard: whether the owner made it, and its age in days.
// `before`: the judging measure's last reading before the change, which the guard compares with now.
const LEVER_CHANGES = `
  select distinct on (c.key) c.id, c.key, c.measure, c.changed_by = 'owner' as owner,
    (extract(epoch from ($1::timestamptz - c.at)) / 86400)::float8 as age_days,
    (select r.value from ledger.measure_readings r where r.metric = c.measure and r.read_at <= c.at
     order by r.read_at desc, r.id desc limit 1) as before
  from policy.setting_changes c order by c.key, c.id desc`;
const ASSIGN_DEFECTS = "select ledger.assign_defects($1::text) as set";
const SET_DEFECT_ROLE = "update policy.work_settings set defect_role = $1";
const DEFECT_ROLE = "select defect_role from policy.work_settings";
const OWNER_CLOSE =
  "select ledger.owner_close_improvement($1::text, $2::text, $3::text, $4::text, $5::text, $6::jsonb) as status";
const SET_ROLE = "select ledger.set_improvement_role($1::text, $2::text) as found";

type FilingResult = {
  filed: number;
  reopened: number;
  reported: number;
  unchanged: number;
  vetoed: number;
  closed: number;
  // Closed because the measure had no data left, not because it recovered.
  emptied: number;
};

// Each type and reason of what extraction refused in the window, whatever week, with its counts by
// field and issue (`field.issue`): the refusal rows' own codes, a schema field's key and an issue
// code (`refusalWords`), never a value. A row filed before fields were kept adds to the count alone.
function refusalClusters(view: OutcomesView["refusals"]): FilingInput["refusals"] {
  const counts = new Map<string, { type: string; reason: string; count: number; why: Map<string, number> }>();
  for (const row of view.weeks.flatMap((week) => week.rows)) {
    const at = JSON.stringify([row.type, row.reason]);
    const seen = counts.get(at) ?? { type: row.type, reason: row.reason, count: 0, why: new Map<string, number>() };
    seen.count += row.count;
    // A field with no issue says nothing of what was wrong with it, and would read as an issue code.
    const code = row.issue === null ? null : row.field === null ? row.issue : `${row.field}.${row.issue}`;
    if (code !== null) seen.why.set(code, (seen.why.get(code) ?? 0) + row.count);
    counts.set(at, seen);
  }
  return [...counts.values()].map(({ why, ...one }) => ({
    ...one,
    why: [...why].map(([code, count]) => ({ code, count })),
  }));
}

// A type a model wrote is ours only if the registry holds it: lower case alone proves nothing.
const knownType = (type: string): string => (Object.hasOwn(KIND_REGISTRY_DATA.kinds, type) ? type : "other");

const refusedOf = (tool: OutcomesView["usage"]["tools"][number]): number =>
  Object.values(tool.refusals).reduce((sum, count) => sum + count, 0);

// A tool's refused calls by outcome, reason and argument, most first (`refusedFields` is in that
// order). The argument is a key of the tool's own schema, never a name the call sent.
const whyRefused = (fields: OutcomesView["usage"]["refusedFields"], tool: string): { code: string; calls: number }[] =>
  fields
    .filter((one) => one.tool === tool)
    .map((one) => ({
      code: [one.outcome, one.reason, one.field]
        .filter((part) => part !== null)
        .join(".")
        .toLowerCase(),
      calls: one.calls,
    }));

function inputOf(
  view: OutcomesView,
  read: Pick<FilingInput, "earlierStates" | "nightlyRed" | "nightlyAt" | "openCauses" | "healthCards">,
  tests: OutcomeTestView,
  baselines: Map<string, number>,
): FilingInput {
  return {
    metrics: view.metrics.map((one) => ({
      metric: one.metric,
      state: one.state,
      value: one.value,
      sample: one.sample,
      healthy: one.healthy.value,
      test: one.healthy.test,
    })),
    ...read,
    refusals: refusalClusters(view.refusals).map((one) => ({ ...one, type: knownType(one.type) })),
    tools: view.usage.tools.map((one) => ({
      tool: one.tool,
      calls: one.calls,
      refused: refusedOf(one),
      why: whyRefused(view.usage.refusedFields, one.tool),
    })),
    canary: view.canary,
    ...(tests.measuredAt === null ? {} : { scoresAt: tests.measuredAt }),
    scores: { latest: tests.latest, before: tests.before, baselines },
    heldOut: tests.comparison,
  };
}

// One cause filed, in the caller's transaction: `filed`, `reopened`, `reported`, `unchanged`, or
// `vetoed` when the owner dismissed its defect.
export async function fileCause(
  admin: Pick<AdminContext, "keys" | "now">,
  query: Query,
  measures: string[],
  found: FoundCause,
): Promise<string> {
  const words = filingWords(found);
  const label = found.label ?? measures;
  const id = newId("imp");
  const event = newId("ime");
  const sealed = (table: string, row: string, column: string, text: string) =>
    sealUnder(admin.keys, label, { table, id: row, column }, text);
  const rows = await query<{ action: string }>(FILE, [
    id,
    event,
    `measure-${event.slice(4, 44)}`,
    found.cause,
    found.state,
    "bug",
    found.area,
    found.severity,
    label,
    fingerprint(admin.keys, "improvement_title", found.cause),
    sealed("ledger.improvements", id, "title_enc", words.title),
    sealed("ledger.improvements", id, "detail_enc", words.detail),
    sealed("ledger.improvement_events", event, "note_enc", words.note),
    found.measuredAt ?? stamp(admin.now()),
  ]);
  return rows[0]?.action ?? "unchanged";
}

// One cause closed because what it measured recovered, in the caller's transaction, its note sealed
// under `label`, the defect's own. True when a defect stood open under it.
export async function closeCause(
  admin: Pick<AdminContext, "keys">,
  query: Query,
  cause: string,
  label: string[],
  // `no_data`: the measure has none left; the defect keeps that as its state.
  why: "recovered" | "no_data" = "recovered",
): Promise<boolean> {
  const event = newId("ime");
  const closed = await query<{ improvement: string | null }>(CLOSE, [
    cause,
    event,
    `measure-${event.slice(4, 44)}`,
    sealUnder(
      admin.keys,
      label,
      { table: "ledger.improvement_events", id: event, column: "note_enc" },
      why === "no_data" ? emptiedNote(cause) : recoveredNote(cause),
    ),
    why === "no_data" ? NO_DATA_STATE : null,
  ]);
  return (closed[0]?.improvement ?? null) !== null;
}

// A measure's parts as a reading keeps them: the keys the closed list admits for the measure
// (served-parts.ts), with finite numbers, at most HEALTH_PARTS_MOST, by code; anything else is left
// out. Null where the measure has none. `ownerParts` are never passed here.
export function partsOf(metric: string, parts: Record<string, number> | undefined): string | null {
  if (parts === undefined) return null;
  const kept = Object.entries(parts)
    .filter(
      ([key, value]) =>
        servedPartKey(metric, key) &&
        HealthPartKey.safeParse(key).success &&
        typeof value === "number" &&
        Number.isFinite(value),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, HEALTH_PARTS_MOST)
    .map(([key, value]) => [key, Math.round(value * 1000) / 1000]);
  return kept.length === 0 ? null : JSON.stringify(Object.fromEntries(kept));
}

// One pass: read the measures, keep this reading, file what fails and close what recovered.
export async function fileImprovements(admin: AdminContext): Promise<FilingResult> {
  const now = admin.now();
  const view = await outcomes(admin, WINDOW_DAYS);
  const label = unrestrictedOf(admin.keys);
  const result: FilingResult = { filed: 0, reopened: 0, reported: 0, unchanged: 0, vetoed: 0, closed: 0, emptied: 0 };
  if (label.length === 0) return result;
  await admin.transaction(async (query) => {
    const earlier = await query<{ metric: string; state: string }>(EARLIER, [
      stamp(new Date(now.getTime() - READING_GAP_HOURS * 3_600_000)),
    ]);
    const nightly = await query<{ value: number | null; read_at: string }>(NIGHTLY);
    const open = await query<{ cause: string; cause_state: string | null; compartments: string[] }>(OPEN_CAUSES);
    // A close is written under the defect's own label, so its note is sealed under that one.
    const labelOf = new Map(open.map((row) => [row.cause, row.compartments]));
    const cards = await query<{
      id: string;
      kind: string | null;
      about: string | null;
      compartments: string[];
      created_at: Date;
    }>(HEALTH_CARDS);
    const baselines = new Map(
      open.flatMap((row) => {
        const baseline = /baseline=(\d)/.exec(row.cause_state ?? "")?.[1];
        return baseline === undefined || !row.cause.startsWith("outcome_drop:")
          ? []
          : [[row.cause.slice("outcome_drop:".length), Number(baseline)] as const];
      }),
    );
    const tests = await outcomeTestView(query);
    const changes = await query<{
      id: string;
      key: string;
      measure: string;
      owner: boolean;
      age_days: number;
      before: number | null;
    }>(LEVER_CHANGES, [stamp(now)]);
    const { failing, recovered, emptied } = findCauses({
      floors: {
        refusal: await lever(query, "filing.refusal_floor"),
        toolShare: await lever(query, "filing.tool_refusal_share"),
      },
      leverChanges: changes.map((row) => ({
        id: Number(row.id),
        key: row.key,
        measure: row.measure,
        by: row.owner ? ("owner" as const) : ("agent" as const),
        ageDays: row.age_days,
        before: row.before,
      })),
      ...inputOf(
        view,
        {
          earlierStates: new Map(earlier.map((row) => [row.metric, row.state])),
          nightlyRed: nightly[0]?.value ?? null,
          ...(nightly[0] === undefined ? {} : { nightlyAt: nightly[0].read_at }),
          openCauses: open.map((row) => row.cause),
          healthCards: cards.map((card) => ({
            subject: healthSubject(card.about ?? "", (text) => fingerprint(admin.keys, "improvement_title", text)),
            kind: card.kind ?? "other",
            compartments: card.compartments,
            at: stamp(card.created_at),
          })),
        },
        tests,
        baselines,
      ),
    });
    for (const one of view.metrics)
      await query(
        "insert into ledger.measure_readings (metric, value, sample, state, compartments, parts) values ($1, $2, $3, $4, $5, $6::jsonb)",
        [one.metric, one.value, one.sample, one.state, label, partsOf(one.metric, one.parts)],
      );
    for (const found of failing) {
      const action = (await fileCause(admin, query, label, found)) as keyof FilingResult;
      result[action] = (result[action] ?? 0) + 1;
    }
    for (const cause of recovered)
      if (await closeCause(admin, query, cause, labelOf.get(cause) ?? label)) result.closed += 1;
    for (const cause of emptied)
      if (await closeCause(admin, query, cause, labelOf.get(cause) ?? label, "no_data")) result.emptied += 1;
  });
  return result;
}

// The nightly report's count, from the Mac when the owner turns that on. A number and nothing else.
export async function recordNightly(admin: AdminContext, red: number): Promise<void> {
  if (!Number.isInteger(red) || red < 0 || red > 100_000) throw new AdminError("invalid_argument");
  // Under the measures' own label, as every reading is; with no unrestricted key it has none.
  const label = unrestrictedOf(admin.keys);
  await admin.transaction((query) =>
    query(
      "insert into ledger.measure_readings (metric, value, sample, state, compartments) values ('nightly_red', $1, 1, $2, $3)",
      [red, red === 0 ? "ok" : "failing", label.length === 0 ? null : label],
    ),
  );
}

// The owner's dismissal of a defect: the only close of one the system filed that is not its
// measure's, and the only one that stops its cause being filed again.
export async function closeImprovement(
  admin: AdminContext,
  improvement: string,
  status: "wont_do" | "duplicate",
  duplicateOf: string | null,
): Promise<void> {
  if ((status === "duplicate") !== (duplicateOf !== null) || duplicateOf === improvement)
    throw new AdminError("invalid_argument");
  const event = newId("ime");
  const rows = await admin.transaction((query) =>
    query<{ status: string | null }>(OWNER_CLOSE, [
      improvement,
      event,
      `owner-${event.slice(4, 44)}`,
      status,
      duplicateOf,
      null,
    ]),
  );
  if ((rows[0]?.status ?? null) === null) throw new AdminError("not_found");
}

// The owner's change of a defect's role; null gives it to any agent.
export async function setImprovementRole(admin: AdminContext, improvement: string, role: string | null): Promise<void> {
  if (role !== null && !/^[a-z][a-z0-9-]{1,31}$/.test(role)) throw new AdminError("invalid_argument");
  const rows = await admin.transaction((query) => query<{ found: boolean }>(SET_ROLE, [improvement, role]));
  if (rows[0]?.found !== true) throw new AdminError("not_found");
}

// The owner's setting of the role defects go to; null unsets it, and then no agent is assigned any.
// Throws unknown_role for a role no active agent holds.
export async function setDefectRole(admin: AdminContext, role: string | null): Promise<void> {
  if (role !== null && !/^[a-z][a-z0-9-]{1,31}$/.test(role)) throw new AdminError("invalid_argument");
  await admin.transaction(async (query) => {
    const rows = await query<{ set: boolean }>(ASSIGN_DEFECTS, [role]);
    if (rows[0]?.set !== true) throw new AdminError("unknown_role");
    await query(SET_DEFECT_ROLE, [role]);
    await decideDefectRole(query, role, admin.now());
  });
}

// What an agent wrote of each open defect an agent filed, for the owner's page alone (`pia
// improvements` stays ids, counts and codes): its title, detail and evidence, opened under the
// owner's keys, within the key file's compartments but the restricted ones. An agent's words:
// each is served inside `untrusted` and rendered as text. One that does not open is null.
type DefectWords = { title: string | null; detail: string | null; evidence: string | null };
const AGENT_WORDS = `
  select i.id, i.compartments, i.title_enc, i.detail_enc, i.evidence_enc
  from ledger.improvements i
  where i.compartments <@ $1::text[] and i.tainted_at is null and i.cause is null and ${IMPROVEMENT_OPEN}
  order by i.id collate "C"`;
export async function defectWords(admin: AdminContext): Promise<Record<string, DefectWords>> {
  const rows = await admin.transaction((query) =>
    query<{ id: string; compartments: string[]; title_enc: Sealed; detail_enc: Sealed; evidence_enc: Sealed }>(
      AGENT_WORDS,
      [unrestrictedOf(admin.keys)],
    ),
  );
  return Object.fromEntries(
    rows.map((row) => [
      row.id,
      {
        title: open(admin.keys, row, "ledger.improvements.title_enc", "null"),
        detail: open(admin.keys, row, "ledger.improvements.detail_enc", "null"),
        evidence: open(admin.keys, row, "ledger.improvements.evidence_enc", "null"),
      },
    ]),
  );
}

// The role, that agent and how many; for the owner's page, which says so and names `pia work free`.
// Within the key file's compartments but the restricted ones.
const HELD_BY_ONE = `
  select o.role, count(*)::int as tasks, min(h.name) as agent
  from ledger.opportunities o
  left join lateral (
    select c.name from queue.leases l join policy.clients c on c.id = l.holder
    where l.resource_kind = 'opportunity' and l.resource_id = o.id
      and ledger.check_back_holds(o.id, l.holder)) h on true
  where o.gap_trigger = 'defect' and o.tainted_at is null and o.role is not null and o.compartments <@ $1::text[]
    and (select r.event from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id
         order by r.id desc limit 1) in ('proposed', 'later', 'go', 'claimed', 'handed_to_owner')
  group by o.role
  having count(*) >= 2 and count(h.name) = count(*) and count(distinct h.name) = 1
  order by o.role collate "C"`;
export const defectHolds = (admin: AdminContext): Promise<{ role: string; agent: string; tasks: number }[]> =>
  admin.transaction((query) => query(HELD_BY_ONE, [unrestrictedOf(admin.keys)]));

type Row = {
  id: string;
  created_by: string;
  created_at: Date;
  tainted_at: Date | null;
  kind: string;
  area: ImprovementArea;
  severity: ImprovementSeverity;
  cause: string | null;
  cause_state: string | null;
  compartments: string[];
  status: ImprovementStatus;
  since: Date;
  reports: number;
  assignee_role: string | null;
  held_by: string | null;
  fix_ref: string | null;
  // The reference on its latest status.
  status_ref: string | null;
};
const ROWS = `
  select i.id, i.created_by, i.created_at, i.tainted_at, i.kind, i.area, i.severity, i.cause, i.cause_state, i.compartments,
    coalesce(s.status, 'open') as status, coalesce(s.created_at, i.created_at) as since,
    (select 1 + count(*)::int from ledger.improvement_events e where e.improvement_id = i.id and e.event = 'reported') as reports,
    i.assignee_role, s.fix_ref as status_ref,
    case when s.status = 'in_progress' then (select k.name from policy.clients k where k.id = s.client_id) end as held_by,
    (select e.fix_ref from ledger.improvement_events e where e.improvement_id = i.id and e.fix_ref is not null
     order by e.created_at desc, e.id collate "C" desc limit 1) as fix_ref
  from ledger.improvements i
  left join lateral (${improvementStatus("e.status, e.created_at, e.client_id, e.fix_ref")}) s on true
  where i.compartments <@ $1::text[]
  order by i.created_at, i.id collate "C"`;
const CLIENTS = `
  select c.name, c.compartments, 'get_health' = any (c.tools) as health from policy.clients c
  where c.status = 'active' and 'list_improvements' = any (c.tools) and 'work' = any (c.views)
  order by c.name collate "C"`;

// The label of each measure's latest reading.
const READINGS = `
  select distinct on (metric) metric, compartments from ledger.measure_readings
  where compartments is not null order by metric, read_at desc, id desc`;

const OPEN: ReadonlySet<string> = new Set(OPEN_IMPROVEMENT_STATUSES);
const OWNERS = "none:owners_to_change" satisfies `none:${FixNoneCode}`;
// The most severe first; a severity not listed sorts before them all, so it is never lost at the end.
const SEVERITY = ["critical", "high", "medium", "low"] as const satisfies readonly ImprovementSeverity[];
const tally = (values: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};

type ImprovementsView = {
  at: Timestamp;
  total: number;
  open: number;
  byStatus: Record<string, number>;
  bySeverity: Record<string, number>;
  byArea: Record<string, number>;
  byFiler: { system: number; agents: number };
  oldestOpen: { improvement: string; since: Timestamp; days: number; cause: string | null } | null;
  causes: {
    cause: string;
    measures: string;
    improvement: string;
    status: ImprovementStatus;
    severity: ImprovementSeverity;
    area: ImprovementArea;
    state: string | null;
    reports: number;
    since: Timestamp;
    days: number;
    role: string | null;
    heldBy: string | null;
    fixRef: string | null;
  }[];
  // Every open defect, whoever filed it, the most severe first and the oldest first within a
  // severity: the dashboard's list. `cause` is null for one an agent filed.
  defects: {
    improvement: string;
    kind: string;
    severity: ImprovementSeverity;
    area: ImprovementArea;
    status: ImprovementStatus;
    role: string | null;
    heldBy: string | null;
    fixRef: string | null;
    filedAt: Timestamp;
    days: number;
    reports: number;
    cause: string | null;
    // An agent looked and said the change is the owner's to make.
    ownersToChange: boolean;
  }[];
  // The role defects go to; null while the owner has set none, and then no agent is assigned any.
  defectRole: string | null;
  // Of the open ones, how many an agent marked the owner's to change.
  ownersToChange: number;
  // What each client that may list the store is served of it: an empty answer with rows here means
  // a label, not an empty store.
  // `readings`: the measures whose latest reading get_health serves it.
  servedTo: { client: string; rows: number; readings: number }[];
};

// `pia improvements`: ids, counts and codes. No title, detail or evidence is opened.
export async function improvementsView(admin: AdminContext): Promise<ImprovementsView> {
  const now = admin.now();
  const within = unrestrictedOf(admin.keys);
  const { rows, clients, readings, role } = await admin.transaction(async (query) => ({
    role: (await query<{ defect_role: string | null }>(DEFECT_ROLE))[0]?.defect_role ?? null,
    rows: await query<Row>(ROWS, [within]),
    clients: await query<{ name: string; compartments: string[]; health: boolean }>(CLIENTS),
    readings: await query<{ metric: string; compartments: string[] }>(READINGS),
  }));
  const days = (at: Date): number => Math.floor((now.getTime() - at.getTime()) / DAY_MS);
  const live = rows.filter((row) => row.tainted_at === null);
  const open = live.filter((row) => OPEN.has(row.status));
  const oldest = [...open].sort((a, b) => a.since.getTime() - b.since.getTime())[0];
  return {
    at: stamp(now),
    total: live.length,
    open: open.length,
    byStatus: tally(live.map((row) => row.status)),
    bySeverity: tally(open.map((row) => row.severity)),
    byArea: tally(open.map((row) => row.area)),
    defectRole: role,
    ownersToChange: open.filter((row) => row.status_ref === OWNERS).length,
    byFiler: {
      system: live.filter((row) => row.cause !== null).length,
      agents: live.filter((row) => row.cause === null).length,
    },
    oldestOpen:
      oldest === undefined
        ? null
        : { improvement: oldest.id, since: stamp(oldest.since), days: days(oldest.since), cause: oldest.cause },
    causes: live.flatMap((row) => {
      if (row.cause === null) return [];
      const kind = kindOfCause(row.cause);
      return [
        {
          cause: row.cause,
          measures: kind === null ? "unknown" : CAUSE_KINDS[kind].measures,
          improvement: row.id,
          status: row.status,
          severity: row.severity,
          area: row.area,
          state: row.cause_state,
          reports: row.reports,
          since: stamp(row.since),
          days: days(row.since),
          role: row.assignee_role,
          heldBy: row.held_by,
          fixRef: row.fix_ref,
        },
      ];
    }),
    defects: [...open]
      .sort(
        (a, b) =>
          SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity) ||
          a.created_at.getTime() - b.created_at.getTime() ||
          (a.id < b.id ? -1 : 1),
      )
      .map((row) => ({
        improvement: row.id,
        kind: row.kind,
        severity: row.severity,
        area: row.area,
        status: row.status,
        role: row.assignee_role,
        heldBy: row.held_by,
        fixRef: row.fix_ref,
        filedAt: stamp(row.created_at),
        days: days(row.created_at),
        reports: row.reports,
        cause: row.cause,
        ownersToChange: row.status_ref === OWNERS,
      })),
    servedTo: clients.map((client) => ({
      client: client.name,
      rows: live.filter((row) => row.compartments.every((one) => client.compartments.includes(one))).length,
      readings: client.health
        ? readings.filter((row) => row.compartments.every((one) => client.compartments.includes(one))).length
        : 0,
    })),
  };
}
