import type { Sealed } from "../../core/seal.ts";
// The durable-work card kinds: an opportunity's go, an owner question, an idea, a lesson, an
// outcome and a reminder. Each reads the ledger row it is about and writes that row's status
// events; queueTranslate queues the translate run an idea's pursue starts.

import {
  CARD_OPTIONS,
  type CardId,
  type CardLine,
  currentDefinition,
  type DeclineReason,
  INTERNAL_STAGES,
  LIVE_HYPOTHESIS_STATES,
  nextStageOf,
  OPEN_STATUSES,
  type OpportunityId,
  type OpportunityKind,
  type OpportunityStatus,
  type RulingId,
  STAGE_PLAN,
  STAGE_PROMPT_IDS,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { type CardKindRow, RELAYED_CODE, type StoredCard } from "../../cards/card-kind-row.ts";
import { basisLine, codeLine, headLines, part, refLine, unreadableLine, writerOf } from "../../cards/card-line.ts";
import { type Query, stamp } from "../../core/db.ts";
import { newId } from "../../core/ids.ts";
import type { Keys } from "../../core/keys.ts";
import { authorWord, caseWord, outcomeCase } from "../../core/locks.ts";
import { latestOf } from "../../core/queue.ts";
import { plannerOf } from "../../core/run-plan.ts";
import { open, type SealedColumn, sealUnder } from "../../core/seal.ts";
import { latestEvent, moveStatus } from "../../core/statements.ts";
import { raiseOutcomeCard } from "../../work/dispatch-cards.ts";
import { authorOf } from "../../work/dispatch-read.ts";
import { opportunityDetailLines } from "./card-kinds-goals.ts";
import { outcomeLines } from "./card-kinds-outcome.ts";

// The card's own columns, as code lines.
export const cardLines = (card: StoredCard): CardLine[] => [
  ...headLines(card),
  ...(card.target === null ? [] : [refLine("target", card.target)]),
  ...card.refs.map((ref) => refLine("ref", ref)),
];

// --------------------------------------------------------------------------------------------- The
// durable-work kinds
// ---------------------------------------------------------------------------------------------

const leavesSystem = (kind: OpportunityKind): boolean =>
  STAGE_PLAN[kind].some((stage) => !INTERNAL_STAGES.includes(stage));

// A status event: no body, the row's own label, by the owner; with their
// decline reason as its code on a no, or RELAYED_CODE on an answer an agent relayed.
const event = (
  query: Query,
  rowKind: string,
  id: string,
  name: string,
  compartments: string[],
  now: Date,
  body: unknown = null,
  reason: DeclineReason | typeof RELAYED_CODE | null = null,
): Promise<unknown> =>
  query(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, body_enc, code) values ($1, $2, $3, $4, 'owner', ledger.label($5), $6, $7)",
    [rowKind, id, name, stamp(now), compartments, body, reason],
  );

// The owner's note on their answer, for the status event the answer writes: sealed under the row's
// whole label (as stored, sorted) with the admin's keys and bound to `<row id>/<event>`, as a move
// report is bound to `<move id>/reported`. The reasoner reads it there, under its clearance, for
// the closed cases of its run request; the decision row holds it too. Null with no note.
const noted =
  (keys: Keys, id: string, compartments: string[], note: string | undefined) =>
  (name: string): unknown =>
    note === undefined
      ? null
      : sealUnder(keys, compartments, { table: "ledger.record_events", id: `${id}/${name}`, column: "body_enc" }, note);

type WorkRow = {
  kind: string;
  about_kind: string;
  about_id: string | null;
  created_by: string;
  compartments: string[];
  body_enc: Sealed;
};

// The row a card is about, by its table. Never a body that is not asked for.
const TABLE = {
  opportunity: "ledger.opportunities",
  hypothesis: "ledger.hypotheses",
  intention: "ledger.intentions",
} as const;
const BODY = {
  opportunity: "ledger.opportunities.body_enc",
  hypothesis: "ledger.hypotheses.body_enc",
  intention: "ledger.intentions.body_enc",
} as const satisfies Record<keyof typeof TABLE, SealedColumn>;
type WorkKind = keyof typeof TABLE;

async function rowOf(query: Query, kind: WorkKind, id: string): Promise<WorkRow | undefined> {
  // An intention is about what its case is about, or else its opportunity.
  const about =
    kind === "intention"
      ? `coalesce(k.about_kind, case when t.opportunity_id is null then 'owner' else 'opportunity' end) as about_kind, coalesce(k.about_id, t.opportunity_id) as about_id
         from ledger.intentions t left join ledger.cases k on k.id = t.case_id`
      : `t.about_kind, t.about_id from ${TABLE[kind]} t`;
  return (
    await query<WorkRow>(`select t.kind, t.created_by, t.compartments, t.body_enc, ${about} where t.id = $1`, [id])
  )[0];
}

// The row's kind, what it is about and its refs as code lines; its summary marked with its writer.
type BasisRef = { ref_kind: string; ref_id: string };
const basisOf = (query: Query, kind: WorkKind, id: string): Promise<BasisRef[]> =>
  query<BasisRef>("select ref_kind, ref_id from ledger.basis where row_kind = $1 and row_id = $2 order by id", [
    kind,
    id,
  ]);

async function rowLines(
  query: Query,
  kind: WorkKind,
  id: string,
  keys: Keys,
): Promise<{ row: WorkRow | undefined; lines: CardLine[]; refs: BasisRef[] }> {
  const row = await rowOf(query, kind, id);
  if (row === undefined) return { row, lines: [], refs: [] };
  const refs = await basisOf(query, kind, id);
  const lines = [
    codeLine("work", [part.code(kind), part.code(row.kind)]),
    row.about_id === null
      ? codeLine("about", [part.code(row.about_kind)])
      : codeLine("about", [part.id(row.about_kind, row.about_id)], [{ kind: row.about_kind, id: row.about_id }]),
    ...refs.map((ref) => basisLine(ref)),
  ];
  if (row.body_enc !== null) {
    const summary = open(keys, { ...row, id }, BODY[kind], "withheld");
    lines.push(summary === null ? unreadableLine("summary") : { text: summary, from: writerOf(row.created_by) });
  }
  return { row, lines, refs };
}

const targetId = (card: StoredCard, kind: string): string | null =>
  card.target?.kind === kind ? card.target.id : null;

// The words of what a row cites, from their sources, so the owner can judge what a run proposed:
// a message's subject and sender, an event's title, a person's first name on file. Each ref is a
// code line, and its words are `source` lines: text people wrote, never code's. A ref already
// shown (`seen`) is not shown again; one whose words the key file cannot open says so.
async function citedLines(query: Query, refs: readonly BasisRef[], keys: Keys, seen: Set<string>): Promise<CardLine[]> {
  const lines: CardLine[] = [];
  // A cited row's words, or that they cannot be opened; nothing for a value it does not hold.
  const words = (value: Sealed | null, text: string | null): void => {
    if (value === null) return;
    lines.push(text === null ? unreadableLine("cited") : { text, from: "source" });
  };
  for (const ref of refs) {
    const key = `${ref.ref_kind} ${ref.ref_id}`;
    if (seen.has(key) || !["message", "event", "entity"].includes(ref.ref_kind)) continue;
    seen.add(key);
    lines.push(codeLine("cited", [part.id(ref.ref_kind, ref.ref_id)], [{ kind: ref.ref_kind, id: ref.ref_id }]));
    if (ref.ref_kind === "message") {
      const [row] = await query<{
        id: string;
        compartments: string[];
        subject_enc: Sealed;
        sender_name_enc: Sealed;
        sender_enc: Sealed;
      }>("select id, compartments, subject_enc, sender_name_enc, sender_enc from knowledge.messages where id = $1", [
        ref.ref_id,
      ]);
      if (row === undefined) continue;
      words(row.subject_enc, open(keys, row, "knowledge.messages.subject_enc", "withheld"));
      if (row.sender_name_enc !== null)
        words(row.sender_name_enc, open(keys, row, "knowledge.messages.sender_name_enc", "withheld"));
      else words(row.sender_enc, open(keys, row, "knowledge.messages.sender_enc", "withheld"));
    } else if (ref.ref_kind === "event") {
      const [row] = await query<{ id: string; compartments: string[]; title_enc: Sealed | null }>(
        "select event_id as id, compartments, title_enc from knowledge.event_details where event_id = $1",
        [ref.ref_id],
      );
      if (row !== undefined) words(row.title_enc, open(keys, row, "knowledge.event_details.title_enc", "withheld"));
    } else {
      const [row] = await query<{ id: string; compartments: string[]; value_enc: Sealed | null }>(
        "select id, compartments, value_enc from knowledge.aliases where entity_id = $1 order by id limit 1",
        [ref.ref_id],
      );
      if (row !== undefined) words(row.value_enc, open(keys, row, "knowledge.aliases.value_enc", "withheld"));
    }
  }
  return lines;
}

// The opportunity and its intentions, every row closeWork may change: an intention's
// opportunity and a move's opportunity never change.
async function workIds(query: Query, opportunity: string | null): Promise<string[]> {
  if (opportunity === null) return [];
  const intentions = await query<{ id: string }>("select id from ledger.intentions where opportunity_id = $1", [
    opportunity,
  ]);
  return [opportunity, ...intentions.map((one) => one.id)];
}

// Every intention of the opportunity that is still set is cancelled,
// and its lease dropped.
async function closeWork(query: Query, opportunity: string, now: Date): Promise<void> {
  await query(
    `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments)
     select 'intention', i.id, 'cancelled', $2, 'owner', i.compartments from ledger.intentions i
     where i.opportunity_id = $1
       and (${latestEvent("intention", "i.id")}) = 'set'
     order by i.id`,
    [opportunity, stamp(now)],
  );
  await query("delete from queue.leases where resource_kind = 'opportunity' and resource_id = $1", [opportunity]);
}

// One decision row, by the owner at rung 4, under the ruling, with the opportunity's label.
async function decision(
  query: Query,
  row: { opportunity: string; compartments: string[] },
  made: {
    decision: "go" | "no_go" | "later";
    ruling: RulingId;
    card: CardId | null;
    intent?: string | null;
    checkBackAt?: Date | null;
  },
): Promise<void> {
  const call =
    made.card === null
      ? null
      : ((
          await query<{ id: string }>(
            "select id from ledger.decision_point_calls where subject_kind = 'opportunity' and subject_id = $1 and card_id = $2 order by id desc limit 1",
            [row.opportunity, made.card],
          )
        )[0]?.id ?? null);
  await query(
    `insert into ledger.opportunity_decisions (request_id, created_by, compartments, opportunity_id, decision, decided_by, rung, reason, intent_id, call_id,
       ruling_id, check_back_at)
     values ($1, 'owner', ledger.label($2), $3, $4, 'owner', 4, 'owner_answer', $5, $6, $7, $8)`,
    [
      made.ruling,
      row.compartments,
      row.opportunity,
      made.decision,
      made.intent ?? null,
      call,
      made.ruling,
      made.checkBackAt === undefined || made.checkBackAt === null ? null : stamp(made.checkBackAt),
    ],
  );
}

// The opportunity's next stage: the first of its plan with no move done.
async function nextStage(query: Query, opportunity: string, kind: OpportunityKind): Promise<string | null> {
  const done = await query<{ stage: string }>(
    `select m.stage from ledger.moves m where m.opportunity_id = $1
       and (${moveStatus()}) = 'done'`,
    [opportunity],
  );
  return nextStageOf(kind, new Set(done.map((one) => one.stage)));
}

// An intent that lets the owner's default agent work the kind before any other, then the earliest
// confirmed of the unrevoked intents that list the kind, then the lowest id, as rung 0 takes it; and
// whether it lets an active agent. A task's go is under the owner's task intent, which lists no
// client: any active agent may take it. The owner's go never makes an intent wider: with none that lets the
// default agent, the agents it does let are told and the default is not.
export async function intentFor(
  query: Query,
  kind: OpportunityKind,
  tier: string,
): Promise<{ id: string; clients: number } | undefined> {
  return (
    await query<{ id: string; clients: number }>(
      `select i.id,
         (select count(*)::int from policy.clients c
          where (i.for_tasks or c.id = any (i.client_ids) or i.role = any (c.roles)) and c.status = 'active' and c.kind = 'agent') as clients
       from policy.intents i where i.revoked_at is null and $1 = any (i.opportunity_kinds) and i.for_tasks = ($2 = 'task')
       order by (select exists (
                   select 1 from policy.work_settings s
                   join policy.clients d on d.status = 'active' and d.kind = 'agent'
                     and (s.ping_order[1] = 'client:' || d.name or substr(s.ping_order[1], 6) = any (d.roles) and s.ping_order[1] like 'role:%')
                   where d.id = any (i.client_ids) or i.role = any (d.roles))) desc,
                i.confirmed_at, i.id collate "C" limit 1`,
      [kind, tier],
    )
  )[0];
}

export const opportunityDecision: CardKindRow = {
  options: CARD_OPTIONS.opportunity_decision,
  // Its work, and what raising the outcome card of work handed to the owner takes (raiseOutcomeCard's
  // locks): the card's author's word and its case.
  lockIds: async (query, card) => {
    const id = targetId(card, "opportunity");
    if (id === null) return [];
    const [row] = await query<{ created_by: string }>("select created_by from ledger.opportunities where id = $1", [
      id,
    ]);
    return [
      ...(await workIds(query, id)),
      ...(row === undefined ? [] : [authorWord(authorOf(row.created_by)), caseWord(outcomeCase(id))]),
    ];
  },
  render: cardLines,
  // The opportunity, the words of what it cites, and the hypothesis it follows from with the words
  // of what that cites: what the owner judges it by.
  detail: async (query, card, keys) => {
    const id = targetId(card, "opportunity");
    if (id === null) return [];
    const { row, lines, refs } = await rowLines(query, "opportunity", id, keys);
    if (row === undefined) return lines;
    lines.push(...(await opportunityDetailLines(query, keys, id)));
    const seen = new Set<string>();
    lines.push(...(await citedLines(query, refs, keys, seen)));
    const [link] = await query<{ hypothesis_id: string | null }>(
      "select hypothesis_id from ledger.opportunities where id = $1",
      [id],
    );
    if (link?.hypothesis_id) {
      const follows = await rowLines(query, "hypothesis", link.hypothesis_id, keys);
      lines.push(codeLine("follows_from", [part.id("hypothesis", link.hypothesis_id)]), ...follows.lines);
      lines.push(...(await citedLines(query, follows.refs, keys, seen)));
    }
    if (leavesSystem(row.kind as OpportunityKind)) lines.push(codeLine("handed"));
    return lines;
  },
  effect: async ({ query, card, answer, ruling, now, keys, note, reason }) => {
    const id = targetId(card, "opportunity");
    if (id === null) return;
    const row = await rowOf(query, "opportunity", id);
    const target = row === undefined ? null : { opportunity: id, compartments: row.compartments };
    const state = await latestOf(query, "opportunity", id);
    // A flag code withdrew leaves its card waiting, and the gap can come back. The owner's no on that
    // card stays a no: the decision is written, with no status, as nothing leaves `withdrawn`.
    if (target !== null && state === "withdrawn" && answer === "no_go") {
      await decision(query, target, { decision: "no_go", ruling, card: card.id });
      return;
    }
    // A card on other work that moved on (a veto, an expiry) records the answer and nothing more.
    if (row === undefined || target === null || !["proposed", "later"].includes(state ?? "")) return;
    const kind = row.kind as OpportunityKind;
    const body = noted(keys, id, row.compartments, note);
    if (answer === "go") {
      const [tier] = await query<{ tier: string }>("select tier from ledger.opportunities where id = $1", [id]);
      const intent = await intentFor(query, kind, tier?.tier ?? "opportunity");
      const stage = await nextStage(query, id, kind);
      const handed =
        intent === undefined || intent.clients === 0 || stage === null || !INTERNAL_STAGES.some((one) => one === stage);
      await decision(query, target, { decision: "go", ruling, card: card.id, intent: intent?.id ?? null });
      const status = handed ? "handed_to_owner" : "go";
      await event(query, "opportunity", id, status, row.compartments, now, body(status));
      // Work handed to the owner carries its outcome card (Done or Drop) at once, not at the tick's next
      // pass, so the page offers both on its row as soon as it is the owner's. The tick still raises one
      // for work handed before this.
      if (handed) await raiseOutcomeCard(query, { kind: "opportunity", id: id as OpportunityId }, now);
    } else if (answer === "later") {
      await decision(query, target, {
        decision: "later",
        ruling,
        card: card.id,
        checkBackAt: new Date(now.getTime() + 7 * DAY_MS),
      });
      await event(query, "opportunity", id, "later", row.compartments, now, body("later"));
    } else if (answer === "no_go") {
      await decision(query, target, { decision: "no_go", ruling, card: card.id });
      await event(query, "opportunity", id, "no_go", row.compartments, now, body("no_go"), reason ?? null);
      await closeWork(query, id, now);
    }
  },
};

// Its detail is a planner card's: the question, and the words of what it was drawn from, so the owner
// sees why it is asked.
export const ownerQuestion: CardKindRow = {
  options: CARD_OPTIONS.owner_question,
  render: cardLines,
  detail: (query, card, keys) => plannerDetail(query, card, keys),
  // The hypothesis's status, and nothing else: no opportunity and no move follows. The owner's
  // reject carries their reason as its code; a relayed confirm or skip carries RELAYED_CODE, so
  // nothing reads it as a confirm of their own.
  effect: async ({ query, card, answer, now, keys, note, reason, relayed }) => {
    const id = targetId(card, "hypothesis");
    if (id === null) return;
    const status = { confirm: "confirmed", reject: "rejected", skip: "open" }[answer];
    const row = await rowOf(query, "hypothesis", id);
    if (
      status === undefined ||
      row === undefined ||
      !LIVE_HYPOTHESIS_STATES.includes((await latestOf(query, "hypothesis", id)) ?? "")
    )
      return;
    await event(
      query,
      "hypothesis",
      id,
      status,
      row.compartments,
      now,
      noted(keys, id, row.compartments, note)(status),
      status === "rejected" ? (reason ?? null) : relayed === true ? RELAYED_CODE : null,
    );
  },
};

// An idea's card: `pursue` queues one translate run for it,
// anchored on it, under its label; `not_now` and `no` record the answer. The owner's note goes on
// the status event, where the planner's next runs read it. Under `research_only`
// a pursue on a card raised before the switch is recorded, and queues no translate run: the answer from the owner
// still teaches the lessons run, and `pi work run --idea` translates it once ideas are back on.
const IDEA_STATUS: Readonly<Record<string, string>> = { pursue: "pursued", not_now: "not_now", no: "rejected" };
const LESSON_STATUS: Readonly<Record<string, string>> = { confirm: "confirmed", reject: "rejected" };
const statusFor = (table: Readonly<Record<string, string>>, answer: string): string | undefined =>
  Object.hasOwn(table, answer) ? table[answer] : undefined;

// The key is `idea:<id>` for the owner's pursue; `pi work run --idea` passes its own.
// Null when a run of that key is already queued.
export async function queueTranslate(
  query: Query,
  idea: string,
  compartments: string[],
  now: Date,
  key = `idea:${idea}`,
): Promise<string | null> {
  const point = currentDefinition("run_outcome");
  const prompt = point.prompts?.find((one) => one.id === STAGE_PROMPT_IDS.translate);
  if (prompt === undefined) throw new Error("run_outcome names no translate prompt");
  const id = newId("run");
  const queued = await query<{ id: string }>(
    `insert into ledger.runs (id, request_id, created_at, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
     values ($1, $1, $2, 'owner', ledger.label($3), 'idea_pursued', $4, $5, $6, $7, $8) on conflict on constraint runs_wake_key do nothing returning id`,
    [id, stamp(now), compartments, key, point.id, point.version, prompt.id, prompt.version],
  );
  if (queued.length === 0) return null;
  await query(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('run', $1, 'queued', $2, 'owner', ledger.label($3))",
    [id, stamp(now), compartments],
  );
  const [basis] = await query<{ ok: boolean }>(
    "select ledger.add_basis('run', $1, $2, array['hypothesis'], array[$3], null) as ok",
    [id, compartments, idea],
  );
  if (basis?.ok !== true) throw new Error("the idea did not resolve");
  return id;
}

// A planner card's lines: the hypothesis, its summary marked as the model's, and the words of what
// it cites.
const plannerDetail = async (query: Query, card: StoredCard, keys: Keys): Promise<CardLine[]> => {
  const id = targetId(card, "hypothesis");
  if (id === null) return [];
  const { lines, refs } = await rowLines(query, "hypothesis", id, keys);
  return [...lines, ...(await citedLines(query, refs, keys, new Set()))];
};

// The status an answer writes on an idea or a lesson still open or asked, with the owner's note
// and, on an idea's no, their decline reason; on a relayed answer but a no, RELAYED_CODE.
async function plannerAnswer(
  query: Query,
  card: StoredCard,
  status: string | undefined,
  now: Date,
  keys: Keys,
  note: string | undefined,
  reason?: DeclineReason,
  relayed = false,
): Promise<string | null> {
  const id = targetId(card, "hypothesis");
  if (id === null || status === undefined) return null;
  const row = await rowOf(query, "hypothesis", id);
  if (row === undefined || !["open", "asked"].includes((await latestOf(query, "hypothesis", id)) ?? "")) return null;
  await event(
    query,
    "hypothesis",
    id,
    status,
    row.compartments,
    now,
    noted(keys, id, row.compartments, note)(status),
    relayed && status !== "rejected" ? RELAYED_CODE : (reason ?? null),
  );
  return id;
}

export const idea: CardKindRow = {
  options: CARD_OPTIONS.idea,
  render: cardLines,
  detail: (query, card, keys) => plannerDetail(query, card, keys),
  effect: async ({ query, card, answer, now, keys, note, reason, relayed }) => {
    const status = statusFor(IDEA_STATUS, answer);
    const id = await plannerAnswer(query, card, status, now, keys, note, reason, relayed === true);
    if (id === null || answer !== "pursue") return;
    if ((await plannerOf(query)) === "research_only") return;
    const row = await rowOf(query, "hypothesis", id);
    if (row !== undefined) await queueTranslate(query, id, row.compartments, now);
  },
};

// The lesson a lessons run proposed this one to replace: a column
// written once, so it is read before the locks.
const supersededBy = async (query: Query, card: StoredCard): Promise<string | null> => {
  const id = targetId(card, "hypothesis");
  if (id === null) return null;
  return (
    (
      await query<{ supersedes: string | null }>(
        "select supersedes from ledger.hypotheses where id = $1 and kind = 'lesson'",
        [id],
      )
    )[0]?.supersedes ?? null
  );
};

// A planning lesson's card: only a confirmed lesson reaches a run. The owner's confirm of
// one that supersedes a lesson in force writes their `retired` on that one.
export const lesson: CardKindRow = {
  options: CARD_OPTIONS.lesson,
  lockIds: async (query, card) => {
    const old = await supersededBy(query, card);
    return old === null ? [] : [old];
  },
  render: cardLines,
  detail: (query, card, keys) => plannerDetail(query, card, keys),
  effect: async ({ query, card, answer, now, keys, note, relayed }) => {
    const id = await plannerAnswer(
      query,
      card,
      statusFor(LESSON_STATUS, answer),
      now,
      keys,
      note,
      undefined,
      relayed === true,
    );
    if (id === null || answer !== "confirm") return;
    const old = await supersededBy(query, card);
    if (old === null) return;
    const row = await rowOf(query, "hypothesis", old);
    if (row === undefined || row.kind !== "lesson" || (await latestOf(query, "hypothesis", old)) !== "confirmed")
      return;
    await event(
      query,
      "hypothesis",
      old,
      "retired",
      row.compartments,
      now,
      null,
      relayed === true ? RELAYED_CODE : null,
    );
  },
};

export const outcome: CardKindRow = {
  options: CARD_OPTIONS.outcome,
  // A move's outcome names the move's opportunity too.
  lockIds: async (query, card) => {
    const move = targetId(card, "move");
    const opportunity =
      move === null
        ? targetId(card, "opportunity")
        : ((await query<{ id: string }>("select opportunity_id as id from ledger.moves where id = $1", [move]))[0]
            ?.id ?? null);
    return workIds(query, opportunity);
  },
  // What was asked and by whom, what was found, and its sources by name
  // (card-kinds-outcome.ts), after the card's own columns.
  render: async (card, _open, read) => [...cardLines(card), ...(await outcomeLines(read, card))],
  // On a handed opportunity the answer ends it; on anything else it is recorded and changes
  // no status. The owner's dismiss there is their no_go, with their decline reason as its code; admin-queue
  // refuses a reason on a move's outcome.
  effect: async ({ query, card, answer, ruling, now, keys, note, reason }) => {
    const id = targetId(card, "opportunity");
    if (id === null) return;
    const row = await rowOf(query, "opportunity", id);
    if (row === undefined || (await latestOf(query, "opportunity", id)) !== "handed_to_owner") return;
    const body = noted(keys, id, row.compartments, note);
    if (answer === "acknowledge") {
      await event(query, "opportunity", id, "done", row.compartments, now, body("done"));
    } else {
      await decision(
        query,
        { opportunity: id, compartments: row.compartments },
        { decision: "no_go", ruling, card: card.id },
      );
      await event(query, "opportunity", id, "no_go", row.compartments, now, body("no_go"), reason ?? null);
    }
    await closeWork(query, id, now);
  },
};

export const reminder: CardKindRow = {
  options: CARD_OPTIONS.reminder,
  // The intention's opportunity, whose status the snooze reads, locked so a close beside it
  // leaves one outcome. An intention's opportunity never changes.
  lockIds: async (query, card) => {
    const id = targetId(card, "intention");
    if (id === null) return [];
    const [row] = await query<{ opportunity_id: string | null }>(
      "select opportunity_id from ledger.intentions where id = $1",
      [id],
    );
    return row?.opportunity_id === null || row?.opportunity_id === undefined ? [] : [row.opportunity_id];
  },
  render: cardLines,
  detail: async (query, card, keys) => {
    const id = targetId(card, "intention");
    return id === null ? [] : (await rowLines(query, "intention", id, keys)).lines;
  },
  effect: async ({ query, card, answer, now, keys }) => {
    const id = targetId(card, "intention");
    if (id === null) return;
    const [row] = await query<{
      created_by: string;
      run_id: string | null;
      session_id: string | null;
      case_id: string | null;
      opportunity_id: string | null;
      client_id: string | null;
      chain_depth: number;
      compartments: string[];
      body_enc: Sealed;
    }>(
      "select created_by, run_id, session_id, case_id, opportunity_id, client_id, chain_depth, compartments, body_enc from ledger.intentions where id = $1",
      [id],
    );
    if (row === undefined) return;
    const state = await latestOf(query, "intention", id);
    if (state === "set")
      await event(query, "intention", id, answer === "done" ? "fired" : "cancelled", row.compartments, now);
    if (answer !== "snooze") return;
    // Work that has closed since the card was raised takes no new reminder: the answer is
    // recorded, and nothing more, as every other kind does when the work has moved on.
    if (
      row.opportunity_id !== null &&
      !OPEN_STATUSES.includes(((await latestOf(query, "opportunity", row.opportunity_id)) ?? "") as OpportunityStatus)
    )
      return;
    // A new reminder one day ahead, with the same summary sealed under its own id. It keeps what
    // the summary rests on, so a deletion taints it as it taints the first: the summary's author,
    // its run, its session and its basis. When the basis no longer resolves whole, the new reminder
    // carries no summary.
    const next = newId("itn");
    const refs = await query<{ ref_kind: string; ref_id: string }>(
      "select ref_kind, ref_id from ledger.basis where row_kind = 'intention' and row_id = $1 and tainted_at is null order by id",
      [id],
    );
    const based =
      refs.length === 0 ||
      (
        await query<{ ok: boolean }>("select ledger.add_basis('intention', $1, $2, $3, $4, null) as ok", [
          next,
          row.compartments,
          refs.map((ref) => ref.ref_kind),
          refs.map((ref) => ref.ref_id),
        ])
      )[0]?.ok === true;
    const text =
      !based || row.body_enc === null ? null : open(keys, { ...row, id }, "ledger.intentions.body_enc", "withheld");
    const body =
      text === null
        ? null
        : sealUnder(keys, row.compartments, { table: "ledger.intentions", id: next, column: "body_enc" }, text);
    await query(
      `insert into ledger.intentions (id, request_id, created_by, run_id, session_id, compartments, body_enc, opportunity_id, case_id, kind, due_at, client_id, chain_depth)
       values ($1, $1, $2, $3, $4, ledger.label($5), $6, $7, $8, 'remind', $9, $10, $11)`,
      [
        next,
        row.created_by,
        row.run_id,
        row.session_id,
        row.compartments,
        body,
        row.opportunity_id,
        row.case_id,
        stamp(new Date(now.getTime() + DAY_MS)),
        row.client_id,
        row.chain_depth + 1,
      ],
    );
    await event(query, "intention", next, "set", row.compartments, now);
  },
};
