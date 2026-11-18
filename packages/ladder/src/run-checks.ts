import {
  type About,
  type IdeasOutput,
  INTERNAL_STAGES,
  ideaAbout,
  type LessonsOutput,
  type PlannerStage,
  type ReasoningOutput,
  type RunCheckCode,
  type RunOutput,
  STAGE_PLAN,
  type UntrustedString,
} from "@intelligence/contracts/personal";

// The checks code makes of a run's output before finish_run: the model proposes, code checks. Pure:
// a refusal is an action's index and a code, and nothing a model wrote. The word tests are
// deliberately coarse; each is named for what it catches.

// The codes are the contracts' (RUN_CHECK_CODES), since a refusal is recorded as a run step.
export type RunRefusal = { action: number; code: RunCheckCode };

// Per run: hypotheses, and proposals that follow from one hypothesis. The output's own cap is five
// actions (ReasoningOutput).
const MAX_HYPOTHESES = 10;
const MAX_PER_HYPOTHESIS = 10;
// The share of a summary's words found in a goal's statement at which, naming no target, it
// restates the goal.
const RESTATE_SHARE = 0.6;

// The refs that are facts from a source: what a hypothesis or a proposal must cite. An agent record
// is one: the owner's own answers came in as records. It is never an about.
const FACT_REFS: ReadonlySet<string> = new Set(["message", "event", "entity", "agent_record"]);

// A first word that is work leaving the system: never the work of a kind whose stages are all
// internal.
const EXTERNAL_VERBS: ReadonlySet<string> = new Set([
  "send",
  "email",
  "message",
  "text",
  "call",
  "contact",
  "reach",
  "reply",
  "invite",
  "schedule",
  "share",
  "post",
  "publish",
  "tweet",
  "submit",
  "apply",
  "pay",
  "buy",
  "purchase",
  "order",
  "book",
  "transfer",
  "sign",
]);

// Words of three letters or more that say nothing of what the work is about.
const STOP: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "with",
  "who",
  "whom",
  "whose",
  "that",
  "this",
  "these",
  "those",
  "from",
  "into",
  "onto",
  "about",
  "could",
  "would",
  "should",
  "will",
  "can",
  "may",
  "might",
  "must",
  "have",
  "has",
  "had",
  "are",
  "was",
  "were",
  "been",
  "being",
  "his",
  "her",
  "hers",
  "him",
  "their",
  "theirs",
  "our",
  "ours",
  "your",
  "yours",
  "you",
  "they",
  "them",
  "its",
  "out",
  "all",
  "any",
  "some",
  "more",
  "most",
  "other",
  "such",
  "than",
  "then",
  "there",
  "here",
  "what",
  "which",
  "when",
  "where",
  "how",
  "why",
  "not",
  "only",
  "also",
  "just",
  "very",
  "own",
  "same",
  "each",
  "both",
  "few",
  "per",
  "via",
  "does",
  "did",
  "done",
]);

const tokens = (text: string): string[] => text.match(/[\p{L}\p{N}]+/gu) ?? [];
const content = (text: string): Set<string> =>
  new Set(
    tokens(text)
      .map((one) => one.toLowerCase())
      .filter((one) => one.length >= 3 && !STOP.has(one)),
  );

// The capitalized words of a summary that are not a sentence's first, lower-cased: its names.
function namesIn(summary: string): Set<string> {
  return new Set(
    summary
      .split(/[.!?:;]\s+|\n/)
      .flatMap((sentence) =>
        tokens(sentence)
          .slice(1)
          .filter((word) => /^\p{Lu}/u.test(word)),
      )
      .map((word) => word.toLowerCase())
      .filter((word) => !STOP.has(word)),
  );
}

// High overlap with a goal's statement and no target: neither about a message, an event or a
// person, nor naming one the goal does not. The overlap is of the words that are not names: work
// on the people a goal itself names ("Prepare a one-page ask for Dana Ortiz", for a goal to get
// Dana Ortiz to advise) is not the goal again for sharing their names.
function restates(summary: string, about: About, goals: readonly ReadonlySet<string>[]): boolean {
  if (FACT_REFS.has(about.kind)) return false;
  const names = namesIn(summary);
  const words = [...content(summary)].filter((word) => !names.has(word));
  return goals.some((goal) => {
    if ([...names].some((name) => !goal.has(name))) return false;
    if (words.length === 0) return true;
    return words.filter((word) => goal.has(word)).length / words.length >= RESTATE_SHARE;
  });
}

const aboutKey = (about: About): string => (about.kind === "owner" ? "owner" : `${about.kind} ${about.id}`);

// `request` is the run's request, or any object with its goals. A translate run's proposals all
// rest on its one idea: it takes no investigate or remind, needs no hypothesis index, and holds at
// most MAX_PER_HYPOTHESIS proposals.
export function checkRunOutput(
  output: ReasoningOutput,
  request: { goals: readonly { statement: UntrustedString }[] },
  stage: PlannerStage | null = null,
): RunRefusal[] {
  const translate = stage === "translate";
  const refusals: RunRefusal[] = [];
  const goals = request.goals.map((goal) => content(goal.statement.untrusted));
  const { actions } = output;
  // The investigate actions a later proposal names: each opens no investigate work of its own.
  const named = new Set(
    actions.flatMap((action, index) =>
      action.do === "propose" &&
      action.hypothesis !== undefined &&
      action.hypothesis < index &&
      actions[action.hypothesis]?.do === "investigate"
        ? [action.hypothesis]
        : [],
    ),
  );
  const cases = new Set<string>();
  const perHypothesis = new Map<number, number>();
  let hypotheses = 0;

  actions.forEach((action, index) => {
    const refuse = (code: RunCheckCode): void => void refusals.push({ action: index, code });
    // A case is one kind of row, of one kind, about one thing: a second one in one output would be
    // merged into the first, and its summary dropped.
    const onCase = (key: string): void => {
      if (cases.has(key)) refuse("same_case");
      cases.add(key);
    };
    if (action.do === "ignore") return;
    if (translate && action.do !== "propose") {
      refuse("wrong_stage");
      return;
    }
    if (action.do === "remind") {
      onCase(`intention remind ${aboutKey(action.about)}`);
      return;
    }
    const cites = action.basis.some((ref) => FACT_REFS.has(ref.kind));

    if (action.do === "investigate") {
      hypotheses += 1;
      if (hypotheses > MAX_HYPOTHESES) refuse("too_many_hypotheses");
      if (!cites) refuse("no_citation");
      if (restates(action.summary, action.about, goals)) refuse("restates_goal");
      onCase(`hypothesis ${action.kind} ${aboutKey(action.about)}`);
      // An opportunity's case includes the hypothesis it rests on.
      if (action.about.kind !== "owner" && !named.has(index))
        onCase(`opportunity investigate ${aboutKey(action.about)} on ${index}`);
      return;
    }

    let linked = translate;
    if (translate) {
      const count = (perHypothesis.get(-1) ?? 0) + 1;
      perHypothesis.set(-1, count);
      if (count > MAX_PER_HYPOTHESIS) refuse("too_many_opportunities");
    }
    // A question for the owner tests a hypothesis of this output, and names it; in a translate run
    // it tests the run's idea.
    if (action.kind === "owner_question" && action.hypothesis === undefined && !translate) refuse("unknown_hypothesis");
    if (action.hypothesis !== undefined) {
      const target = action.hypothesis < index ? actions[action.hypothesis] : undefined;
      if (target?.do !== "investigate") refuse("unknown_hypothesis");
      else if (target.about.kind === "owner") refuse("owner_hypothesis");
      else {
        linked = true;
        const count = (perHypothesis.get(action.hypothesis) ?? 0) + 1;
        perHypothesis.set(action.hypothesis, count);
        if (count > MAX_PER_HYPOTHESIS) refuse("too_many_opportunities");
      }
    }
    if (!cites && !linked && !action.basis.some((ref) => ref.kind === "hypothesis")) refuse("no_citation");
    const internal = STAGE_PLAN[action.kind].every((stage) => INTERNAL_STAGES.includes(stage));
    if (internal && EXTERNAL_VERBS.has(tokens(action.summary)[0]?.toLowerCase() ?? "")) refuse("external_action");
    if (restates(action.summary, action.about, goals)) refuse("restates_goal");
    onCase(
      `opportunity ${action.kind} ${aboutKey(action.about)} on ${action.hypothesis ?? (translate ? "idea" : "none")}`,
    );
  });
  return refusals;
}

// An ideas run's output: each idea cites a message, an event, a person or an agent record, is about
// a message, an event, a person or a goal, and is no goal again.
export function checkIdeas(
  output: IdeasOutput,
  request: { goals: readonly { statement: UntrustedString }[] },
): RunRefusal[] {
  const goals = request.goals.map((goal) => content(goal.statement.untrusted));
  const refusals: RunRefusal[] = [];
  output.ideas.forEach((idea, index) => {
    const about = ideaAbout(idea.basis);
    if (about === null || !idea.basis.some((ref) => FACT_REFS.has(ref.kind)))
      refusals.push({ action: index, code: "no_citation" });
    else if (restates(idea.idea, about, goals)) refusals.push({ action: index, code: "restates_goal" });
  });
  return refusals;
}

// A lessons run's output: each lesson cites a case it learned from or an action of its actions
// block; a decision it cites is one that block showed.
export function checkLessons(
  output: LessonsOutput,
  request: { actions?: readonly { decision: string }[] | undefined } = {},
): RunRefusal[] {
  const shown = new Set((request.actions ?? []).map((one) => one.decision));
  return output.lessons.flatMap((lesson, index) =>
    lesson.basis.some((ref) => ref.kind === "hypothesis" || ref.kind === "opportunity" || ref.kind === "decision") &&
    lesson.basis.every((ref) => ref.kind !== "decision" || shown.has(ref.id))
      ? []
      : [{ action: index, code: "no_citation" as const }],
  );
}

// An output of the shape its stage answers with, checked by its stage's checks; null for an
// output of another stage's shape, which the run refuses as bad_output. An ignore alone is every
// stage's answer that there is nothing to do.
export function checkStageOutput(
  stage: PlannerStage | null,
  output: RunOutput,
  request: {
    goals: readonly { statement: UntrustedString }[];
    actions?: readonly { decision: string }[] | undefined;
  },
): RunRefusal[] | null {
  if ("ideas" in output) return stage === "ideas" ? checkIdeas(output, request) : null;
  if ("lessons" in output) return stage === "lessons" ? checkLessons(output, request) : null;
  if (output.actions.every((action) => action.do === "ignore")) return [];
  return stage === "ideas" || stage === "lessons" ? null : checkRunOutput(output, request, stage);
}

// What the model is told of a refusal: the indexes and codes, in code's words.
// What each refusal asks for, fixed text the model can act on: an ideas run that cited only agent
// records about the owner, told just "no_citation", failed twice.
// Fixed per code, so nothing of the output or a source is ever echoed back.
export const REFUSAL_REASONS: Readonly<Record<RunRefusal["code"], string>> = Object.freeze({
  restates_goal: "it only restates one of the owner's goals; say what is new: a person, an opening, a step",
  no_citation:
    "its basis must start with the message, event or person it is about, or the goal it serves, and cite at least one message, event, person or agent record it rests on; an agent record supports an idea but is never what it is about, and an idea about the owner alone is not taken",
  unknown_hypothesis: "it names a hypothesis index that is not an earlier action of this answer",
  owner_hypothesis: "work never rests on a hypothesis about the owner alone",
  too_many_hypotheses: "the answer holds more hypotheses than the limit; keep the strongest",
  too_many_opportunities: "one hypothesis has more pieces of work than the limit; keep the strongest",
  external_action: "an internal stage cannot send, pay or post; propose the work and let the owner act",
  same_case: "two actions are the same case; keep one",
  wrong_stage: "this stage does not take that kind of action",
});

export const refusalText = (refusals: readonly RunRefusal[]): string =>
  `output refused: ${refusals.map((one) => `action ${one.action} ${one.code} (${REFUSAL_REASONS[one.code]})`).join("; ")}. Fix those actions and answer again.`;
