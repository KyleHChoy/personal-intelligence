import {
  ClaimRecord,
  doneRequires,
  doneSays,
  type EntityId,
  type FactId,
  type GoalId,
  type HypothesisId,
  type OpportunityView,
  type RateCounts,
  rejectedLine,
  type UntrustedString,
  type WorkBrief,
} from "@intelligence/contracts/personal";
import { byText } from "../core/db.ts";
import type { SealedRow } from "../core/seal.ts";
import { servedJson } from "../core/served.ts";
import { NAMES_SHOWN, PEOPLE_OR_ORGS, RELEASE_IN_FORCE } from "../core/visibility.ts";
import { heldAmong } from "../core/work-held.ts";
import { progressOf } from "../core/work-progress.ts";
import { goalIds, type WorkCall } from "../core/work-refs.ts";
import { statedFactsOf } from "../read/read-compiled.ts";
import { servedOrNull, Unavailable } from "../read/read-ctx.ts";
import { computedGoals } from "../read/read-goal-beliefs.ts";
import { cardBrief } from "./card-attempt-report.ts";
import { relayBrief } from "./card-relay.ts";
import { dreamFindingBrief } from "./dream-settle.ts";
import { handoverBrief } from "./handover.ts";
import { samePersonBrief } from "./same-person-report.ts";
import { type Anchor, citedEvidence, closedCasesFor, confirmedLessons } from "./work-cases.ts";

// The brief an agent is given with an opportunity it holds: built by code from
// rows the caller's token returns, every text untrusted. The sections are capped for sanity only;
// each brief logs its counts.

const MAX_PREFERENCES = 100;
const MAX_CASES = 20;

const HYPOTHESES =
  "select id, kind, compartments, body_enc from ledger.hypotheses where id = any($1) and tainted_at is null";
// The caller's roles and every role an active agent holds; also the claiming client's roles a
// brief's lessons are fitted to, which ClientView does not carry. Work's list reads it too.
export const CURRENT_ROLES = "select mine, all_roles from policy.current_roles()";

type Hypothesis = NonNullable<WorkBrief["hypothesis"]>;

// An idea's body as finishRun seals it: the idea, then `why:`, `test:` and `confidence:` lines.
const IDEA = /^([\s\S]*?)\nwhy: ([\s\S]*)\ntest: ([\s\S]*)\nconfidence: [^\n]*$/;

function hypothesisOf(id: string, kind: Hypothesis["kind"], text: UntrustedString | null): Hypothesis {
  const parts = kind === "idea" && text !== null ? IDEA.exec(text.untrusted) : null;
  if (parts === null) return { id: id as HypothesisId, kind, summary: text };
  return {
    id: id as HypothesisId,
    kind,
    summary: { untrusted: parts[1] ?? "" },
    why: { untrusted: parts[2] ?? "" },
    test: { untrusted: parts[3] ?? "" },
  };
}

// The owner's active preferences and constraints, as get_self compiles them, each with the words of
// its latest cite that has them. Only for a client with the self view. Returns the evidence shown.
async function preferencesOf(call: WorkCall): Promise<{ preferences: WorkBrief["preferences"]; shown: string[] }> {
  if (!call.client.views.includes("self")) return { preferences: [], shown: [] };
  const compiled = await statedFactsOf(call.ctx, "fresh");
  const preferences: WorkBrief["preferences"] = [];
  const shown: string[] = [];
  for (const belief of compiled.facts.beliefs) {
    if (
      (belief.kind !== "preference" && belief.kind !== "constraint") ||
      belief.status !== "active" ||
      preferences.length >= MAX_PREFERENCES
    )
      continue;
    const cite = belief.cites.find((one) => "fields" in one && "what" in one.fields && one.fields.what !== undefined);
    const what = cite !== undefined && "fields" in cite && "what" in cite.fields ? cite.fields.what : undefined;
    if (cite === undefined || !("message" in cite) || what === undefined) continue;
    preferences.push({
      kind: belief.kind,
      what,
      ...(belief.kind === "preference" ? { polarity: belief.values.polarity } : {}),
    });
    const evidence = cite.message === null ? undefined : compiled.evidenceOf.get(cite.message);
    if (evidence !== undefined) shown.push(evidence);
  }
  return { preferences, shown };
}

// An intro_path task's introducers and goals, from the basis ledger.raise_gap_flag wrote under the
// task's label: every person it names but the one the task is about, and every goal. Ids only, read
// by code.
function introPathOf(view: OpportunityView): NonNullable<WorkBrief["introPath"]> {
  const about = view.about.kind === "owner" ? null : view.about.id;
  const ids = (kind: "entity" | "goal") =>
    [...new Set(view.basis.flatMap((ref) => (ref.kind === kind && ref.id !== about ? [ref.id] : [])))].slice(0, 20);
  return {
    introducers: ids("entity") as NonNullable<WorkBrief["introPath"]>["introducers"],
    goals: ids("goal") as NonNullable<WorkBrief["introPath"]>["goals"],
  };
}

// The edges that reach an explore task's node, as the caller's token shows them: each relation claim in force that names it (or, for a named
// organization, names it by its name rows, but for a contact's claim, which is no edge), of no held message, its release in force, naming no
// one the token does not show; newest first, at most 20.
const EDGE_TYPES = ["relationship", "affiliation", "role", "intro_offer", "connection"];
const MAX_EDGES = 20;
const EDGES = `
  select c.id, c.compartments, c.content_enc, c.evidence_id
  from knowledge.claims c
  left join knowledge.messages m on m.evidence_id = c.evidence_id
  where c.type = any($2::text[]) and (c.valid_to is null or c.valid_to > $3) and (m.id is null or not m.held)
    and (c.id in (select n.claim_id from knowledge.claim_entities n where n.entity_id = $1)
      or (c.id in (select x.claim_id from knowledge.claim_org_names x
                   join knowledge.org_names o on o.name_fp = x.name_fp and o.compartments @> x.compartments and o.compartments <@ x.compartments
                   where o.entity_id = $1)
          and c.evidence_id not in (select k.evidence_id from knowledge.contacts k)))
    and ${RELEASE_IN_FORCE}
    and ${NAMES_SHOWN}
  order by c.valid_from desc, c.id, m.id
  limit $4`;
// The field naming a claim's other side, by its type.
const OTHER: Readonly<Record<string, string>> = {
  relationship: "counterparty",
  affiliation: "organization",
  role: "organization",
  intro_offer: "person",
  connection: "other",
};

// An explore task's missing list (its gap's), its edges (who said each, the fact, the other side,
// each a person or organization the token shows, else null) and the goals it serves (its basis).
// Ids and code words only. Returns the evidence its edges cite.
async function exploreOf(
  call: WorkCall,
  view: OpportunityView,
  now: Date,
): Promise<{ explore: NonNullable<WorkBrief["explore"]>; shown: string[] }> {
  const node: string | null = view.about.kind === "owner" ? null : view.about.id;
  const rows =
    node === null
      ? []
      : await call.ctx.run<SealedRow<"knowledge.claims.content_enc"> & { evidence_id: string }>(EDGES, [
          node,
          EDGE_TYPES,
          now.toISOString(),
          MAX_EDGES,
        ]);
  const read = rows.map((row) => {
    const parsed = ClaimRecord.safeParse(servedJson(call.ctx, row, "knowledge.claims.content_enc"));
    if (!parsed.success) throw new Unavailable();
    const { subject, type, fields } = parsed.data.claim.content;
    const other = fields[OTHER[type] ?? ""];
    const side = (subject as string) === node ? (typeof other === "string" ? other : null) : subject;
    return { fact: row.id as FactId, by: parsed.data.claim.assertedBy ?? null, with: side };
  });
  const named = [...new Set(read.flatMap((one) => [one.by, one.with]).filter((id): id is string => id !== null))];
  const visible = new Set((await call.ctx.run<{ id: string }>(PEOPLE_OR_ORGS, [named])).map((row) => row.id));
  const shownAs = (id: string | null): EntityId | null => (id !== null && visible.has(id) ? (id as EntityId) : null);
  const goals = [...new Set(view.basis.flatMap((ref) => (ref.kind === "goal" ? [ref.id] : [])))].slice(
    0,
    20,
  ) as NonNullable<WorkBrief["explore"]>["goals"];
  return {
    explore: {
      missing: view.gap?.lacks ?? ["identity"],
      edges: read.map((one) => ({ fact: one.fact, by: shownAs(one.by), with: shownAs(one.with) })),
      goals,
    },
    shown: rows.map((row) => row.evidence_id),
  };
}

// One brief for each view, and the evidence they show: what their cases, hypotheses and lessons
// cite, and the preferences' messages; the goal ids they return; and the lesson ids they served,
// for the read log. Each view's lessons are those for its kind and the client's roles.
export async function briefsOf(
  call: WorkCall,
  views: readonly OpportunityView[],
  now: Date,
): Promise<{ briefs: Map<string, WorkBrief>; shown: string[]; bound: string[]; goals: string[]; lessons: string[] }> {
  const briefs = new Map<string, WorkBrief>();
  if (views.length === 0) return { briefs, shown: [], bound: [], goals: [], lessons: [] };
  const { ctx } = call;
  const roles = (await ctx.run<{ mine: string[] }>(CURRENT_ROLES, []))[0]?.mine ?? [];
  const lessonsOf = await confirmedLessons(call, { kinds: [...new Set(views.map((view) => view.kind))], roles });
  const lessons = [...new Map([...lessonsOf.values()].flat().map((one) => [one.id, one] as const)).values()];
  const { preferences, shown } = await preferencesOf(call);
  // The kinds the owner mostly rejects from this agent, by its own counts within its clearance alone
  // (none while they have switched learning off for it; none of a kind they keep under a grant): a
  // line code writes, never the rejected words.
  const rejected = rejectedLine(
    (
      await ctx.run<RateCounts & { granted: boolean }>(
        "select kind, granted, answers, confirmed from policy.my_confirm_rates($1)",
        [now.toISOString()],
      )
    ).filter((row) => !row.granted),
  );
  const goals = await briefGoals(call, views, now);
  const hypotheses = await briefHypotheses(call, views);
  const cited: (readonly [string, string])[] = [
    ...lessons.map((one) => ["hypothesis", one.id] as const),
    ...[...hypotheses.keys()].map((id) => ["hypothesis", id] as const),
  ];
  // The owner's decline reason on the caller's own work only: a reason such as already_handled
  // says more about the owner's own activity than a bare no.
  const closed = await closedCasesFor(call, views.map(anchorsOf), now, { author: `client:${call.client.id}` });
  const explored: string[] = [];
  const bound: string[] = [];
  // The latest progress on each, by whoever held it: where a claim picks the work up.
  const progress = await progressOf(
    ctx,
    views.map((view) => view.id),
  );
  // The caller's own check-back on each (A8): on work that came back at its date, why it waited.
  const held = await heldAmong(
    ctx,
    views.map((view) => view.id),
  );
  for (const [index, view] of views.entries()) {
    const reported = progress.get(view.id);
    const checkBack = held.get(view.id)?.checkBack ?? null;
    const explore = view.gap?.trigger === "explore" ? await exploreOf(call, view, now) : null;
    const samePerson = view.gap?.trigger === "same_person" ? await samePersonBrief(call.ctx, view.id) : null;
    const card = view.gap?.trigger === "card_question" ? await cardBrief(call.ctx, view.id) : null;
    const relay = view.gap?.trigger === "card_relay" ? await relayBrief(call.ctx, view.id) : null;
    const handover = view.gap?.trigger === "owner_queue" ? await handoverBrief(call.ctx, view.id) : null;
    const dreamFinding = view.gap?.trigger === "dream_finding" ? await dreamFindingBrief(call.ctx, view.id) : null;
    if (explore !== null) explored.push(...explore.shown);
    if (samePerson !== null) {
      explored.push(...samePerson.shown);
      bound.push(...samePerson.bound);
    }
    const kept = relevantCases(closed[index] ?? { cases: [], rows: [] }, view.id);
    cited.push(...kept.map(([row]) => [row.row_kind, row.id] as const));
    const brief: WorkBrief = {
      kind: view.kind,
      summary: view.summary,
      goal: view.goal === null ? null : (goals.get(view.goal) ?? null),
      hypothesis: view.hypothesis === null ? null : (hypotheses.get(view.hypothesis) ?? null),
      lessons: lessonsOf.get(view.kind) ?? [],
      preferences,
      cases: kept.map(([, one]) => one),
      done: doneRequires(view.kind, view.stage, view.tier),
      // And in words, an explore task's fill with them.
      doneSays: doneSays(
        doneRequires(view.kind, view.stage, view.tier),
        explore === null ? undefined : explore.explore.missing,
      ),
      ...(rejected === null ? {} : { rejected }),
      ...(reported === undefined ? {} : { progress: reported }),
      ...(checkBack === null ? {} : { checkBack }),
      ...(view.gap?.trigger === "intro_path" ? { introPath: introPathOf(view) } : {}),
      ...(explore === null ? {} : { explore: explore.explore }),
      ...(samePerson === null ? {} : { samePerson: samePerson.pairs }),
      ...(card === null ? {} : { card }),
      ...(relay === null ? {} : { relay }),
      ...(handover === null ? {} : { handover }),
      ...(dreamFinding === null ? {} : { dreamFinding }),
    };
    briefs.set(view.id, brief);
    ctx.log.info({
      event: "work_brief",
      counts: { lessons: brief.lessons.length, preferences: preferences.length, cases: brief.cases.length },
    });
  }
  const returned = goalIds(
    [...briefs.values()].flatMap((brief) => [
      brief.goal === null ? null : { kind: "goal", id: brief.goal.id },
      ...brief.cases.map((one) => one.about),
    ]),
  );
  const served = [
    ...new Set([...briefs.values()].flatMap((brief) => brief.lessons.map((one) => one.id as string))),
  ].sort(byText);
  return {
    briefs,
    shown: [...new Set([...shown, ...explored, ...(await citedEvidence(call, cited))])].sort(byText),
    bound: [...new Set(bound)].sort(byText),
    goals: returned,
    lessons: served,
  };
}

// The goals the views name, as the caller's clearance computes them, each with its statement and
// whether it is stale.
async function briefGoals(call: WorkCall, views: readonly OpportunityView[], now: Date) {
  const goalRows = [...new Set(views.flatMap((view) => (view.goal === null ? [] : [view.goal])))];
  const wanted = new Set<string>(goalRows);
  return new Map(
    goalRows.length === 0
      ? []
      : (await computedGoals(call.ctx, call.client.compartments, now.toISOString())).flatMap((goal) =>
          goal.goal !== null && wanted.has(goal.goal)
            ? [
                [
                  goal.goal as string,
                  {
                    id: goal.goal as GoalId,
                    statement: { untrusted: goal.statement },
                    ...(goal.stale ? { stale: true as const } : {}),
                  },
                ] as const,
              ]
            : [],
        ),
  );
}

// The hypotheses the views name, each opened under the caller's keys and served as untrusted.
async function briefHypotheses(call: WorkCall, views: readonly OpportunityView[]) {
  const hypothesisIds = [...new Set(views.flatMap((view) => (view.hypothesis === null ? [] : [view.hypothesis])))];
  return new Map(
    (
      await call.ctx.run<{ id: string; kind: Hypothesis["kind"]; compartments: string[]; body_enc: unknown }>(
        HYPOTHESES,
        [hypothesisIds],
      )
    ).map(
      (row) =>
        [
          row.id,
          hypothesisOf(
            row.id,
            row.kind,
            servedOrNull(
              call.ctx.keys,
              row.compartments,
              { table: "ledger.hypotheses", id: row.id, column: "body_enc" },
              row.body_enc,
            ),
          ),
        ] as const,
    ),
  );
}

// The cases a run anchored on each opportunity would find relevant, read for every view at once:
// those answered by the owner or carrying their note, but the opportunity itself.
const anchorsOf = (view: OpportunityView): Anchor[] => [
  { ref_kind: "opportunity", ref_id: view.id, evidence_id: null },
  ...(view.goal === null ? [] : [{ ref_kind: "goal", ref_id: view.goal, evidence_id: null }]),
  ...(view.hypothesis === null ? [] : [{ ref_kind: "hypothesis", ref_id: view.hypothesis, evidence_id: null }]),
  ...view.basis.map((ref) => ({ ref_kind: ref.kind, ref_id: ref.id, evidence_id: null })),
];

// Of one view's closed cases, at most MAX_CASES relevant ones other than the view's own
// opportunity that the owner decided or noted, each with its row.
function relevantCases<
  Row extends { relevant: boolean; id: string },
  Case extends { decision?: unknown; note?: unknown },
>(found: { rows: readonly Row[]; cases: readonly Case[] }, own: string): (readonly [Row, Case])[] {
  return found.rows
    .flatMap((row, at) => {
      const one = found.cases[at];
      return one !== undefined &&
        row.relevant &&
        row.id !== own &&
        ((one.decision ?? null) !== null || (one.note ?? null) !== null)
        ? [[row, one] as const]
        : [];
    })
    .slice(0, MAX_CASES);
}
