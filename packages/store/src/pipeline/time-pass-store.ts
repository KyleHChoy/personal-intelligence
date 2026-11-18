import type { EvidenceId } from "@intelligence/contracts";
import type { CardId } from "@intelligence/contracts/personal";
import {
  CARD_OPTIONS,
  dayAfter,
  dayIn,
  isCanaryCompartment,
  isCoded,
  type PersonalLogger,
  startOfDay,
  TIME_EFFORT_CARDS_PER_DAY,
  TIME_EFFORT_MIN_MINUTES,
  TIME_GROUPS_MAX,
  TIME_OWN_LINE_CHARS,
  TIME_OWN_LINES,
  TIME_PASS_DAYS,
  type TimeProposalAnswer,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import {
  checkedChoices,
  creditIntervals,
  groupStretches,
  sourceOwnerWord,
  type TimeGroup,
  uncreditedStretches,
  type WorkInputs,
  type WorkRow,
} from "@intelligence/personal-core/lens";
import { titleSeal } from "../core/capture-pages.ts";
import { byText, type Query, stamp } from "../core/db.ts";
import { trackedCalls } from "../core/decision-calls.ts";
import { fingerprint, scopeNormal } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { createDb } from "../core/job-db.ts";
import type { Keys } from "../core/keys.ts";
import { labelKey, within } from "../core/labels.ts";
import { EXTRACT_AUTHOR, raiseCard } from "../core/queue.ts";
import { open, type Sealed } from "../core/seal.ts";
import { LATEST_CARD_EVENT } from "../core/statements.ts";
import { factsSubject } from "../core/stored-forms.ts";
import { openedUnder, type Tx } from "../core/tx.ts";
import { gatherInputs, type Source } from "../core/work-time-read.ts";
import { ownerZoneOf } from "../core/zone.ts";
import { isBrowserBundle } from "../lens/capture-push.ts";
import { blockTitles, titleCovering } from "../lens/time-group-text.ts";
import { supportsUnder } from "./computed-beliefs.ts";
import { openMomentItem } from "./pipeline-open.ts";
import { ownerAudienceOf } from "./pipeline-read.ts";

// The daily proposal pass's store, run as pi_pipeline in `pi extract`. It reads each complete local
// day of the last TIME_PASS_DAYS as the owner's own reads do, one label at a time, so no group
// mixes what one label holds with another's (invariant 4), and hands back what a request may show.
// It writes only rulings marked as the system's, each labelled by code with the block's label, and
// time_effort cards. Ids, counts and codes in logs.

// What one local day and label asks. `slot` is what the model is shown; `groups` what code does
// with its answer.
type TimeJob = {
  day: string;
  label: string[];
  slot: string;
  groups: Map<string, TimeGroup>;
  projects: Set<string>;
  evidence: string[];
  // The day's moments labelled wider than this label, which the pass leaves unread: a count, so
  // what the rule costs shows in the pass's log line.
  momentsWider: number;
};

// The moments whose label holds `label` and more (an agent app's, labelled with its client's whole
// clearance). The pass reads none of them: its request, its proposal and its card all carry the
// block's label, and an output may never be labelled narrower than something it read (invariant 4).
// A client cleared for the block alone would otherwise be served a credit made from words it
// cannot read.
export const widerMoments = (
  rows: readonly Pick<WorkInputs["rows"][number], "kind" | "compartments">[],
  label: readonly string[],
): number =>
  rows.filter((row) => row.kind === "moment" && within(label, row.compartments) && !within(row.compartments, label))
    .length;

export type TimeApplied = { proposed: number; stretches: number; refused: number; cards: number };

export type TimePassStore = {
  // Whether the pass has yet to finish today, on the owner's clock.
  due(now: Date): Promise<boolean>;
  jobs(now: Date, compartments: readonly string[]): Promise<TimeJob[]>;
  calls(): ReturnType<typeof trackedCalls>;
  subjectOf(job: Pick<TimeJob, "day" | "label">): string;
  apply(job: TimeJob, answer: TimeProposalAnswer, now: Date): Promise<TimeApplied>;
  finish(started: Date, now: Date): Promise<void>;
  close(): Promise<void>;
};

const EFFORT_KIND = "time_effort";
// A card nobody answered goes, as an agent claim's does; the time waits on no card and is asked again.
const EFFORT_EXPIRY_DAYS = 30;
const PAGES_SHOWN = 5;
const MOMENTS_READ = 3;
const SLOT_CHARS = 50_000;
// A request's refs hold at most this many items (keyed-replay.ts).
const REFS_MOST = 100;

// The keyed fingerprints an excepted host or bundle is held under, and each parent of a host, so
// naming a site names its subdomains. Browser time whose host cannot be told (an address of digits has no
// normal host, and a moment may have no URL) could be a named site's, so once any host is named it is
// treated as one: it fails closed, and stays unattributed.
const hostForms = (host: string): string[] => {
  const labels = scopeNormal(host).split(".");
  return labels.map((_, at) => labels.slice(at).join("."));
};

async function exceptions(tx: Tx): Promise<(bundle: string, host: string | null) => boolean> {
  const rows = await tx.query<{ match: string; value_fp: string }>(
    "select match, value_fp from policy.time_exceptions",
  );
  const held = new Set(rows.map((row) => `${row.match}:${row.value_fp}`));
  const anyHost = rows.some((row) => row.match === "host");
  const has = (match: string, value: string): boolean =>
    held.has(`${match}:${fingerprint(tx.keys, "capture_scope", value)}`);
  return (bundle, host) =>
    has("bundle", scopeNormal(bundle)) ||
    (host === null ? anyHost && isBrowserBundle(bundle) : hostForms(host).some((form) => has("host", form)));
}

// Words of the owner's own a group's moments hold, where a chat's turns say which are the owner's and the
// moment is one the owner's word holds for. A line naming a person an erasure suppressed is left out.
async function ownLines(tx: Tx, evidence: readonly string[]): Promise<string[]> {
  const lines: string[] = [];
  for (const id of evidence) {
    // One stored moment that no longer parses costs its lines, never the day's pass.
    const opened = await openMomentItem(tx, id as EvidenceId).catch((error: unknown) => {
      if (error instanceof Error && (error.name === "ZodError" || error instanceof SyntaxError)) return null;
      throw error;
    });
    if (opened === null) continue;
    const { item, capture } = opened.moment;
    if (item.turns === undefined || !sourceOwnerWord(capture.facts, capture.endedAt)) continue;
    const said = item.turns
      .filter((turn) => turn.speaker === "owner")
      .map((turn) => item.text.slice(turn.from, turn.to).trim().slice(0, TIME_OWN_LINE_CHARS))
      .filter((line) => line !== "");
    const seal = await titleSeal(tx.query, tx.keys, said);
    lines.push(...said.filter((line) => seal.kept(line)));
    if (lines.length >= TIME_OWN_LINES) break;
  }
  return lines.slice(0, TIME_OWN_LINES);
}

// One group as the model is shown it. All of it is data, never an instruction (the prompt says so,
// and the answer has no place for more than ids).
async function shownGroup(
  tx: Tx,
  id: string,
  group: TimeGroup,
  inputs: WorkInputs,
  excepted: (bundle: string, host: string | null) => boolean,
): Promise<Record<string, unknown>> {
  const blocks = inputs.rows.flatMap((row) => (row.work?.kind === "block" ? row.work.blocks : []));
  const covering = blocks.filter((one) =>
    group.stretches.some(
      (stretch) =>
        one.bundle === stretch.bundle && Date.parse(one.start) <= stretch.from && Date.parse(one.end) >= stretch.to,
    ),
  );
  const pages = covering
    .flatMap((one) => (one.pages ?? []).map((page) => ({ page, bundle: one.bundle })))
    .filter(({ page, bundle }) => !excepted(bundle, URL.parse(page.url)?.hostname ?? null))
    .map(({ page }) => page)
    .slice(0, PAGES_SHOWN)
    .map((page) => ({
      title: page.title ?? null,
      query: page.query ?? null,
      host: URL.parse(page.url)?.hostname ?? null,
    }));
  const places = [
    ...new Set(
      group.stretches.flatMap((one) => one.places.filter((place) => place.kind !== "app").map((p) => p.value)),
    ),
  ].slice(0, PAGES_SHOWN);
  const moments = [
    ...new Set(group.stretches.flatMap((one) => (one.moment === null ? [] : [one.moment.evidence]))),
  ].slice(0, MOMENTS_READ);
  return {
    id,
    minutes: Math.round(group.minutes),
    app: group.bundle,
    host: group.host,
    what: group.text,
    places,
    pages,
    ownLines: await ownLines(tx, moments),
  };
}

// A moment's host, from the facts sealed beside it; undefined when they cannot be read.
async function momentHosts(tx: Tx, rows: readonly WorkRow[]): Promise<Map<string, string | null | undefined>> {
  const ids = rows.filter((row) => row.kind === "moment").map((row) => row.id);
  const found = await tx.query<{ id: string; compartments: string[]; facts_enc: Sealed }>(
    "select id, compartments, facts_enc from knowledge.captures where id = any ($1::text[])",
    [ids],
  );
  return new Map(
    found.map((row) => {
      try {
        const facts = JSON.parse(open(tx.keys, row, "knowledge.captures.facts_enc", "throw")) as {
          url?: string | null;
        };
        const url = facts.url ?? null;
        return [row.id, url === null ? null : (URL.parse(url)?.hostname ?? undefined)];
      } catch (error) {
        if (error instanceof SyntaxError) return [row.id, undefined];
        throw error;
      }
    }),
  );
}

// Where a person's name can sit in a block's own place. A host names a site and an app its bundle.
const NAMING_PLACES: readonly string[] = ["document", "folder", "repository"];

// What one day and label asks, or null when nothing is left to ask. Biggest groups first, as many
// as fit the request's bounds; what does not fit waits unasked.
async function jobOf(
  tx: Tx,
  day: string,
  label: string[],
  inputs: WorkInputs,
  zone: string | null,
): Promise<TimeJob | null> {
  // A block of this very label, since a ruling takes its block's label and one wider than a block
  // would never credit it; the moments and meetings that speak for it may be narrower, never wider
  // (`widerMoments` says why, and counts them). A thread naming a person an erasure suppressed says
  // nothing.
  const seal = await titleSeal(
    tx.query,
    tx.keys,
    inputs.rows.map((row) => (row.work?.kind === "moment" ? row.work.thread : null)),
  );
  const rows = inputs.rows
    .filter(
      (row) =>
        within(row.compartments, label) && (row.kind !== "block" || labelKey(row.compartments) === labelKey(label)),
    )
    .map((row) =>
      row.work?.kind === "moment" && row.work.thread !== null && !seal.kept(row.work.thread)
        ? { ...row, work: { ...row.work, thread: null } }
        : row,
    );
  const window = { from: startOfDay(day, zone), to: startOfDay(dayAfter(day), zone) };
  const credited = creditIntervals({
    ...inputs,
    rows,
    rulings: (inputs.rulings ?? []).filter((one) => within(one.compartments, label)),
  });
  // A person's erasure leaves a place's value in work_enc, so it is judged here.
  const named = (place: { kind: string }): boolean => NAMING_PLACES.includes(place.kind);
  const placeSeal = await titleSeal(tx.query, tx.keys, [
    ...new Set(credited.flatMap((one) => one.places.filter(named).map((place) => place.value))),
  ]);
  const spans = credited.map((one) => ({
    ...one,
    places: one.places.filter((place) => !named(place) || placeSeal.kept(place.value)),
  }));
  const settled = await tx.query<{ from_at: Date; to_at: Date }>(
    `select from_at, to_at from knowledge.time_rulings
     where source = 'system' and (lifted_at is not null or pending_card is not null)
       and compartments <@ $1::text[] and to_at > $2 and from_at < $3`,
    [label, new Date(window.from).toISOString(), new Date(window.to).toISOString()],
  );
  const excepted = await exceptions(tx);
  const hosts = await momentHosts(tx, rows);
  const stretches = uncreditedStretches(
    spans,
    rows,
    window,
    settled.map((row) => ({ from: row.from_at.getTime(), to: row.to_at.getTime() })),
    excepted,
    (moment) => {
      const host = hosts.get(moment.id);
      return host === null || host === undefined ? host : scopeNormal(host);
    },
  );
  if (stretches.length === 0) return null;
  const titles = new Map<string, Awaited<ReturnType<typeof blockTitles>>>();
  for (const evidence of new Set(stretches.map((one) => one.evidence)))
    titles.set(evidence, await blockTitles(tx.query, tx.keys, evidence));
  const groups = groupStretches(stretches, (one) => titleCovering(titles.get(one.evidence) ?? [], one));
  // A project's name may be words of evidence, so it is judged as a title is.
  const offered = inputs.projects.filter((one) => one.active && within(one.compartments, label));
  const nameSeal = await titleSeal(
    tx.query,
    tx.keys,
    offered.map((one) => one.name),
  );
  const projects = offered.filter((one) => nameSeal.kept(one.name));
  const asked = new Map<string, TimeGroup>();
  const shown: Record<string, unknown>[] = [];
  const evidence = new Set<string>();
  const list = projects.map((one) => ({ id: one.id, name: one.name }));
  const slotOf = (): string => JSON.stringify({ day, projects: list, groups: shown });
  for (const group of groups.slice(0, TIME_GROUPS_MAX)) {
    const id = `g${asked.size + 1}`;
    const refs = evidenceOf(group);
    const one = await shownGroup(tx, id, group, { ...inputs, rows }, excepted);
    shown.push(one);
    if (slotOf().length > SLOT_CHARS || new Set([...evidence, ...refs]).size > REFS_MOST) {
      shown.pop();
      break;
    }
    asked.set(id, group);
    for (const ref of refs) evidence.add(ref);
  }
  if (asked.size === 0) return null;
  return {
    day,
    label,
    slot: slotOf(),
    groups: asked,
    projects: new Set(projects.map((one) => one.id)),
    evidence: [...evidence].sort(byText),
    momentsWider: widerMoments(inputs.rows, label),
  };
}

// Every item a group's text came from: the block days and the moments.
const evidenceOf = (group: TimeGroup): string[] =>
  [
    ...new Set(group.stretches.flatMap((one) => [one.evidence, ...(one.moment === null ? [] : [one.moment.evidence])])),
  ].sort(byText);

// Adjacent stretches of one row are one, as long as the table's range allows.
function merged(group: TimeGroup): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  for (const one of [...group.stretches].sort((a, b) => a.from - b.from)) {
    const last = spans.at(-1);
    if (last !== undefined && last.to === one.from && one.to - last.from <= DAY_MS) last.to = one.to;
    else spans.push({ from: one.from, to: one.to });
  }
  return spans;
}

const INSERT = `insert into knowledge.time_rulings (id, project_id, from_at, to_at, source, proposal_id, pending_card, evidence_ids, created_at, compartments)`;

// One proposal's stretches. The project is read again first: active and within the block's label,
// or nothing is written and the choice counts as refused. The label is the block's, never anything a
// model said (invariant 5). A stretch a live proposal of this label already covers is not written
// again, so a day asked twice leaves one row. `written` null means refused.
async function writeProposal(
  query: Query,
  job: TimeJob,
  group: TimeGroup,
  project: string,
  at: string,
): Promise<number | null> {
  const [allowed] = await query(
    "select 1 from knowledge.projects p where p.id = $1 and p.status = 'active' and p.compartments <@ $2::text[]",
    [project, job.label],
  );
  if (allowed === undefined) return null;
  const proposal = newId("tpr");
  let written = 0;
  for (const span of merged(group)) {
    const rows = await query(
      `${INSERT}
       select $1, $2, $3, $4, 'system', $5, null, $6, $7, $8::text[]
       where not exists (
         select 1 from knowledge.time_rulings r
         where r.source = 'system' and r.lifted_at is null and r.pending_card is null
           and r.compartments <@ $8::text[] and r.compartments @> $8::text[] and r.from_at < $4 and r.to_at > $3)
       returning id`,
      [
        newId("tru"),
        project,
        new Date(span.from).toISOString(),
        new Date(span.to).toISOString(),
        proposal,
        evidenceOf(group),
        at,
        job.label,
      ],
    );
    written += rows.length;
  }
  return written;
}

// A group that fits no project: at most a few cards a day, each with its time held on the card
// until the owner answers. One card to a group: while it is undecided a later day's time joins it,
// and once the owner has said no or yes it raises no other, unless a yes found nothing left (a reply from the owner stands, and a project the owner said yes
// to is one the next day's question can name).
async function raiseEffort(tx: Tx, job: TimeJob, group: TimeGroup, room: { left: number }, now: Date): Promise<number> {
  const fp = fingerprint(tx.keys, "fact", `time effort ${labelKey(job.label)}\n${group.key}`);
  const caseKey = `time_effort:${fp.slice(0, 40)}`;
  const [known] = await tx.query<{ id: string; state: string }>(
    `select c.id, (${LATEST_CARD_EVENT}) as state
     from ledger.cards c where c.case_key = $1 and c.created_by = $2 order by c.created_at desc, c.id limit 1`,
    [caseKey, EXTRACT_AUTHOR],
  );
  // A withdrawn card is a yes that found nothing left to name (card-kinds-time.ts), and an expired one
  // no answer at all: each is asked again.
  const lost = known?.state === "withdrawn" || known?.state === "expired";
  if (known !== undefined && !lost && known.state !== "pending" && known.state !== "deferred") return 0;
  const fresh = known === undefined || lost;
  if (fresh && (room.left <= 0 || group.minutes < TIME_EFFORT_MIN_MINUTES)) return 0;
  const card =
    (fresh ? undefined : known?.id) ??
    (
      await raiseCard(
        tx.query,
        {
          id: newId("crd") as CardId,
          requestId: lost ? fingerprint(tx.keys, "fact", `${caseKey}\n${known.id}`) : fp,
          kind: EFFORT_KIND,
          author: EXTRACT_AUTHOR,
          options: [...CARD_OPTIONS.time_effort],
          target: null,
          refs: [],
          compartments: [...job.label].sort(byText),
          expiresAt: null,
          expiresAfterDays: EFFORT_EXPIRY_DAYS,
          caseKey,
          run: null,
          body: null,
          bodyFrom: null,
        },
        { now },
      )
    ).id;
  if (fresh) room.left -= 1;
  const proposal = newId("tpr");
  for (const span of merged(group)) {
    await tx.query(`${INSERT} values ($1, null, $2, $3, 'system', $4, $5, $6, $7, $8)`, [
      newId("tru"),
      new Date(span.from).toISOString(),
      new Date(span.to).toISOString(),
      proposal,
      card,
      evidenceOf(group),
      stamp(now),
      job.label,
    ]);
  }
  return fresh ? 1 : 0;
}

export function createTimePassStore({
  url,
  keys,
  log,
}: {
  url: string;
  keys: Keys;
  log: PersonalLogger;
}): TimePassStore {
  const db = createDb(url, log);
  const tx: Tx = { query: db.query, keys };
  const open = (compartments: string[], at: { table: string; id: string; column: string }, sealed: unknown): string =>
    openedUnder(keys, compartments, at, sealed);
  return {
    async due(now) {
      const zone = await ownerZoneOf(db.query);
      const [row] = await db.query<{ n: number }>(
        "select count(*)::int as n from ledger.job_runs where job = 'time_pass' and code = 'ok' and ended_at >= $1",
        [new Date(startOfDay(dayIn(now, zone), zone)).toISOString()],
      );
      return (row?.n ?? 0) === 0;
    },
    async jobs(now, compartments) {
      const zone = await ownerZoneOf(db.query);
      const today = dayIn(now, zone);
      const source: Source = {
        run: (text, values) => db.query(text, values),
        open: (table, column, row) =>
          open(row.compartments as string[], { table, id: row.id as string, column }, row.value_enc),
        within: [...compartments],
        clearance: async () => [...compartments],
        // A title link counts when a belief computed under the owner's clearance rests on it.
        supportOf: supportsUnder(db.query, keys, await ownerAudienceOf(db.query)),
        // What agents filed is credited, so the pass proposes none of it.
        anchorFp: (key) => fingerprint(keys, "anchor", key),
      };
      const jobs: TimeJob[] = [];
      for (let back = 1; back <= TIME_PASS_DAYS; back += 1) {
        const day = dayAfter(today, -back);
        const inputs = await gatherInputs(source, { view: "day", day }, now, zone);
        const labels = new Map(
          inputs.rows
            // The standing check's synthetic time is nobody's work, and its cards would take the day's room.
            .filter((row) => row.kind === "block" && !row.compartments.some(isCanaryCompartment))
            .map((row) => [labelKey(row.compartments), [...row.compartments]]),
        );
        for (const label of [...labels.values()].sort((a, b) => byText(labelKey(a), labelKey(b)))) {
          // One day's items that will not read cost that day alone; a database that is down ends it.
          try {
            const job = await jobOf(tx, day, label, inputs, zone);
            if (job !== null) jobs.push(job);
          } catch (error) {
            if (isCoded(error, "unavailable")) throw error;
            log.warn({ event: "time_pass_day_failed", code: "unreadable" });
          }
        }
      }
      return jobs;
    },
    calls: () => trackedCalls(db.query, keys),
    subjectOf: ({ day, label }) => {
      const [a, b] = [
        fingerprint(keys, "fact", `time pass ${day}`),
        fingerprint(keys, "fact", `time pass ${labelKey(label)}`),
      ].sort(byText) as [string, string];
      return factsSubject(a, b);
    },
    apply: (job, answer, now) =>
      db.transaction(async (query) => {
        const inner: Tx = { query, keys };
        const choices = checkedChoices(answer, new Set(job.groups.keys()), job.projects);
        const at = stamp(now);
        const applied: TimeApplied = { proposed: 0, stretches: 0, refused: choices.refused, cards: 0 };
        for (const { group, project } of choices.assigned) {
          const written = await writeProposal(query, job, job.groups.get(group) as TimeGroup, project, at);
          if (written === null) applied.refused += 1;
          else if (written > 0) {
            applied.proposed += 1;
            applied.stretches += written;
          }
        }
        const [today] = await query<{ n: number }>(
          "select count(*)::int as n from ledger.cards where kind = $1 and created_by = $2 and created_at > $3",
          [EFFORT_KIND, EXTRACT_AUTHOR, new Date(now.getTime() - DAY_MS).toISOString()],
        );
        const room = { left: TIME_EFFORT_CARDS_PER_DAY - (today?.n ?? 0) };
        for (const group of choices.efforts)
          applied.cards += await raiseEffort(inner, job, job.groups.get(group) as TimeGroup, room, now);
        return applied;
      }),
    async finish(started, now) {
      await db.query(
        "insert into ledger.job_runs (job, started_at, ended_at, code) values ('time_pass', $1, $2, 'ok')",
        [stamp(started), stamp(now)],
      );
    },
    close: () => db.close(),
  };
}
