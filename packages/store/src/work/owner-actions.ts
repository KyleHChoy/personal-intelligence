import { DeclineReason, type OwnerAction, type RulingId, type UntrustedString } from "@intelligence/contracts/personal";
import { stamp } from "../core/db.ts";
import type { WorkCall } from "../core/work-refs.ts";

// The owner-actions block of a lessons run, built by code. Each line: the verb in plain words; what
// the decision acted on, in words, and that thing's text by the fixed rule for its kind where the
// reasoner can read it; the owner's decline reason and note, their words, untrusted as evidence is
// (invariant 1); the time. The decision's id is the line's only id.

// The verb of each `plan` kind (OWNER_ACTION_LEARNING), in the words the lessons prompt uses.
const VERBS: Readonly<Record<string, string>> = Object.freeze({
  goal_set: "set a goal",
  goal_status: "changed a goal's status",
  goal_reword: "reworded a goal",
  goal_rank: "ranked a goal",
  goal_target: "targeted a goal",
  task_add: "gave an agent a task",
  task_withdraw: "withdrew a task",
  task_cancel: "cancelled a task",
  work_free: "freed work an agent held",
  task_tier: "turned agents' tasks on or off",
  default_task_role: "set the role for tasks with none",
  question_role: "set the role your questions go through",
  title_role: "set the role that reads titles in work time",
  defect_role: "set the role the system's defects go to",
  ping_settings: "set who your agents' pings go to",
  gap_route: "routed a gap to a role",
  owner_answer: "answered a question",
  commitment_close: "closed a commitment",
  commitment_reopen: "reopened a commitment",
  answer: "answered a card",
  note_add: "wrote a note about a person",
  project_add: "added a project",
  project_anchor: "anchored a project",
  project_unanchor: "unanchored a project",
  project_close: "closed a project",
  time_ruling: "ruled on a stretch of time",
  time_unruling: "lifted a time ruling",
  time_veto: "vetoed a proposed time ruling",
  harm: "marked harm",
  harm_lift: "lifted a harm mark",
  result_eval: "judged a finished task's result",
  auto_settings: "set a card kind's automatic answers",
});

const GOAL = new Set(["goal_set", "goal_status", "goal_reword", "goal_rank", "goal_target"]);
const TASK = new Set(["task_add", "task_withdraw", "task_cancel", "work_free"]);
const PROJECT = new Set(["project_add", "project_anchor", "project_unanchor", "project_close"]);
const article = (word: string): string => `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;

// What a decision acted on, in words, never its id. A list is only ever "a list" (the tick's role
// cannot read lists), and a kind with no rule is its own name in words.
function objectOf(kind: string, cardKind: string | null, objectKind: string | null, targetKind: string | null): string {
  if (GOAL.has(kind)) return "a goal";
  if (TASK.has(kind)) return objectKind === null ? "a task" : `${article(objectKind)} task`;
  if (PROJECT.has(kind)) return "a project";
  if (kind.startsWith("list_")) return "a list";
  if (kind.startsWith("commitment_")) return "a commitment";
  switch (kind) {
    case "answer":
      return cardKind === null ? "a card" : `${article(cardKind)} card`;
    case "owner_answer":
      return "a question for the person";
    case "note_add":
      return "a person";
    case "task_tier":
      return "the task tier";
    case "default_task_role":
      return "the default task role";
    case "question_role":
      return "the question role";
    case "title_role":
      return "the title role";
    case "defect_role":
      return "the defect role";
    case "ping_settings":
      return "who pings go to";
    case "result_eval":
      return "a research result";
    case "auto_settings":
      return "automatic answers";
    case "gap_route":
      return "a gap route";
    case "harm":
    case "harm_lift":
      return targetKind === "send" ? "a send" : "a piece of work";
    default:
      return kind.replaceAll("_", " ");
  }
}

// The fixed rule for each kind's text: a goal's statement, the one the owner gave when they set or
// reworded it; a task's note; a question's summary; a card's content line; a project's name; harm on
// work, the work's description. A commitment's text is not one the reasoner can be sure to read, a
// note's text is the owner's words already kept as a claim and never shown, and a list, a tier, a
// role or a route has none.
function textOf(kind: string, body: UntrustedString | null, object: UntrustedString | null): UntrustedString | null {
  if (kind === "goal_set" || kind === "goal_reword") return body ?? object;
  if (
    GOAL.has(kind) ||
    PROJECT.has(kind) ||
    kind === "answer" ||
    kind === "owner_answer" ||
    kind === "harm" ||
    kind === "harm_lift"
  )
    return object;
  if (TASK.has(kind)) return object === null ? null : taskNote(object);
  return null;
}

// The owner's own task (owner-tasks.ts, ownerTaskBrief): their note, after the line that marks it;
// an agent's task, its whole summary. What the brief says it is about, by id, is left out. A brief
// is stored, so the mark it was written with before the line was reworded is read too.
const NOTE_MARKS = ["The owner's note, in their own words:\n", "The owner's note, in his own words:\n"];
function taskNote(body: UntrustedString): UntrustedString {
  for (const mark of NOTE_MARKS) {
    const at = body.untrusted.indexOf(mark);
    if (at >= 0) return { untrusted: body.untrusted.slice(at + mark.length) };
  }
  return body;
}

// What code knows of one decision, its texts opened: the input of one line.
export type ActionFacts = {
  id: RulingId;
  kind: string;
  answer: string | null;
  cardKind: string | null;
  objectKind: string | null;
  // What the decision names as its target, by kind: never its id.
  targetKind: string | null;
  at: string;
  // The decision's sealed body: the owner's note on a card, or the statement they gave a goal.
  body: UntrustedString | null;
  // The text of what it acted on, by its kind's table.
  object: UntrustedString | null;
  reason: string | null;
};

const ANSWER_WORD = /^[a-z][a-z0-9_]{0,31}$/;

// One line, from what code knows. Pure.
export function actionLine(facts: ActionFacts): OwnerAction {
  const text = textOf(facts.kind, facts.body, facts.object);
  const reason = DeclineReason.safeParse(facts.reason);
  const note = facts.kind === "answer" ? facts.body : null;
  const his = { ...(reason.success ? { reason: reason.data } : {}), ...(note === null ? {} : { note }) };
  return {
    decision: facts.id,
    at: facts.at as OwnerAction["at"],
    did: VERBS[facts.kind] ?? facts.kind.replaceAll("_", " "),
    ...(facts.answer !== null && ANSWER_WORD.test(facts.answer) ? { answer: facts.answer } : {}),
    object: objectOf(facts.kind, facts.cardKind, facts.objectKind, facts.targetKind),
    ...(text === null ? {} : { text }),
    ...(Object.keys(his).length === 0 ? {} : { his }),
  };
}

type ActionRow = {
  decision_id: string;
  decision_kind: string;
  answer: string | null;
  card_kind: string | null;
  decided_at: Date;
  compartments: string[];
  body_enc: unknown;
  target_kind: string | null;
  object_table: string | null;
  object_id: string | null;
  object_column: string | null;
  object_kind: string | null;
  object_compartments: string[] | null;
  object_enc: unknown;
  reason: string | null;
};

// Opens a sealed text under its label with the call's keys (work-cases.ts, untrustedOf), or throws.
export type Opener = (
  compartments: string[] | null,
  at: { table: string; id: string; column: string },
  envelope: unknown,
) => UntrustedString | null;

// The block of a run whose row names decisions, under the reasoner's token: every decision and
// the object of each, in one statement (ledger.run_owner_actions), newest first. A text that will
// not open is left out, so one bad row never stops a run.
export async function ownerActions(call: WorkCall, run: string, open: Opener): Promise<OwnerAction[]> {
  const quietlyOpened = (
    compartments: string[] | null,
    at: { table: string; id: string; column: string },
    envelope: unknown,
  ): UntrustedString | null => {
    try {
      return open(compartments, at, envelope);
    } catch {
      return null;
    }
  };
  const rows = await call.ctx.run<ActionRow>("select * from ledger.run_owner_actions($1)", [run]);
  return rows
    .map((row) =>
      actionLine({
        id: row.decision_id as RulingId,
        kind: row.decision_kind,
        answer: row.answer,
        cardKind: row.card_kind,
        objectKind: row.object_kind,
        targetKind: row.target_kind,
        at: stamp(row.decided_at),
        body: quietlyOpened(
          row.compartments,
          { table: "knowledge.owner_decisions", id: row.decision_id, column: "body_enc" },
          row.body_enc,
        ),
        object:
          row.object_table === null || row.object_id === null || row.object_column === null
            ? null
            : quietlyOpened(
                row.object_compartments,
                { table: row.object_table, id: row.object_id, column: row.object_column },
                row.object_enc,
              ),
        reason: row.reason,
      }),
    )
    .sort((a, b) => (a.at === b.at ? (a.decision < b.decision ? 1 : -1) : a.at < b.at ? 1 : -1));
}
