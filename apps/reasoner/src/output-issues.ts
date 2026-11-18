import { type PlannerStage, ReasoningOutput, STAGE_OUTPUTS, type WorkRef } from "@intelligence/contracts/personal";

// What the model is told of an answer that does not fit its stage's form, so a retry is told why
// the first answer was refused: each part of the answer the form refuses, by its path, and the
// rule it broke, in our own words. Built from the schema and the path alone, never from a value
// the model wrote; a key it made up is cut to 64 code points. Logged by the issue's code only.

export type OutputIssue = { path: string; rule: string; code: string };

const MAX_ISSUES = 10;
const MAX_NAME_CODE_POINTS = 64;

const shapeOf = (stage: PlannerStage | null) => (stage === null ? ReasoningOutput : STAGE_OUTPUTS[stage].schema);
const cut = (name: string): string => [...name].slice(0, MAX_NAME_CODE_POINTS).join("");
const size = (origin: unknown, bound: unknown): string =>
  origin === "string" ? `${String(bound)} characters` : origin === "array" ? `${String(bound)} items` : String(bound);

type Issue = NonNullable<ReturnType<typeof ReasoningOutput.safeParse>["error"]>["issues"][number];

// What a ref is, for a ref the form refused (a bare invalid_union tells the model nothing it can
// fix): the kinds a basis or an about takes, and the id each needs, never a document, a fact or a
// name. A fact with no message, such as one from an agent, is cited by its agent record.
// Each ref kind as this text names it: a kind added to WorkRef does not compile until it is told.
const REF_WORDS = {
  message: "a message (msg_)",
  event: "an event (evt_)",
  entity: "a person or organization (entity, ent_)",
  agent_record: "an agent record (agent_record, rec_)",
  goal: "a goal (gol_)",
  hypothesis: "a hypothesis (hyp_)",
  opportunity: "an opportunity (opp_)",
} as const satisfies Record<WorkRef["kind"], string>;
const BASIS_REF = `a ref {"kind", "id"}: ${REF_WORDS.message}, ${REF_WORDS.event}, ${REF_WORDS.entity} or ${REF_WORDS.agent_record}, each by the id a tool gave or a hdl_ handle; or ${REF_WORDS.goal}, ${REF_WORDS.hypothesis} or ${REF_WORDS.opportunity}. Never a document, a fact or a name: cite the message a fact came from, or its record when it has no message`;
const ABOUT_REF = `the owner {"kind": "owner"}, or a ref {"kind", "id"} to ${REF_WORDS.message}, ${REF_WORDS.event}, ${REF_WORDS.entity} or ${REF_WORDS.goal}`;
const refRule = (path: readonly PropertyKey[]): string | null => {
  const named = path.filter((part): part is string => typeof part === "string");
  const last = named.at(-1);
  return last === "basis" ? BASIS_REF : last === "about" ? ABOUT_REF : null;
};

function ruleOf(issue: Issue): string {
  // A discriminated union refuses a ref at its `kind`: the ref is the path without it.
  if (issue.code === "invalid_union" || (issue.code === "invalid_value" && issue.path.at(-1) === "kind")) {
    const ref = refRule(issue.path.at(-1) === "kind" ? issue.path.slice(0, -1) : issue.path);
    if (ref !== null) return `must be ${ref}`;
  }
  switch (issue.code) {
    case "too_big":
      return `must be at most ${size(issue.origin, issue.maximum)}`;
    case "too_small":
      return `must be at least ${size(issue.origin, issue.minimum)}`;
    case "invalid_type":
      return `must be ${issue.expected === "int" ? "an integer" : `a ${issue.expected}`}`;
    case "invalid_value":
      return `must be one of: ${issue.values.map(String).join(", ")}`;
    case "unrecognized_keys":
      return `takes no key ${issue.keys.map(cut).join(", ")}`;
    case "custom":
      return issue.message;
    default:
      return `refused (${issue.code})`;
  }
}

export function outputIssues(stage: PlannerStage | null, text: string | null): OutputIssue[] {
  let value: unknown;
  try {
    value = JSON.parse(text ?? "");
  } catch {
    return [{ path: "answer", rule: "must be one JSON object and nothing else", code: "invalid_json" }];
  }
  const parsed = shapeOf(stage).safeParse(value);
  if (parsed.success) return [];
  return parsed.error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path:
      issue.path.length === 0
        ? "answer"
        : issue.path.map((part) => (typeof part === "number" ? String(part) : cut(String(part)))).join("."),
    rule: ruleOf(issue),
    code: issue.code,
  }));
}

export const outputIssuesText = (stage: PlannerStage | null, issues: readonly OutputIssue[]): string =>
  `None of your last answer was used: it does not fit the form of ${stage === null ? "a planner" : `the ${stage}`} answer. Answer again, the whole answer, with ${
    issues.length === 0
      ? "the form your instructions give"
      : `these fixed: ${issues.map((one) => `${one.path}: ${one.rule}`).join("; ")}`
  }.`;
