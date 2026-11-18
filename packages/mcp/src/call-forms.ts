// What a call meant, when it sent a plain form its tool's strict schema would refuse: another tool's
// name for an id field, a ref as a bare id, a report's fields beside the report. An agent harness that
// loads a tool's schema on demand makes such a first call before it has read the schema. Only the
// shape changes: the result is parsed by the tool's schema and every rule after it applies as before,
// so no id is taken on trust and no rule that guards anything is passed. A form that is not plain,
// such as two ids for one field, is left for the schema to refuse.

import type { IdPrefix, ToolArgKey, ToolName } from "@intelligence/contracts/personal";
import { MoveReport, PROPOSE_PERSON_FIELDS, StoredAboutYouKind } from "@intelligence/contracts/personal";

type Args = Record<string, unknown>;

const isObject = (value: unknown): value is Args =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Another name for a field, by tool. A tool or a field it no longer has fails to compile.
const RENAMED = {
  claim_opportunity: { opportunity: "id", opportunity_id: "id" },
  release_opportunity: { opportunity: "id", opportunity_id: "id" },
  hand_off: { opportunity: "id", opportunity_id: "id" },
  plan_move: { id: "opportunity", opportunity_id: "opportunity" },
  set_intention: { id: "opportunity", opportunity_id: "opportunity" },
  answer_owner_question: { id: "opportunity", opportunity_id: "opportunity" },
  report_move: { id: "move", move_id: "move" },
  record_test: { id: "hypothesis", hypothesis_id: "hypothesis" },
  close_commitment: { fact: "commitment", id: "commitment" },
  read_item: { id: "message", message_id: "message" },
  read_message: { message: "id", message_id: "id" },
  get_evidence_span: { id: "fact", fact_id: "fact" },
  read_meeting: { id: "meeting", capture: "meeting", meeting_id: "meeting" },
  find_facts: { fact: "belief" },
  fetch_template: { id: "document", document_id: "document" },
  get_document: { document: "id", document_id: "id" },
  get_entity: { entity: "id", entity_id: "id" },
  get_timeline: { entity: "id", entity_id: "id" },
  find_paths: { entity: "target", id: "target", entity_id: "target" },
} as const satisfies { readonly [T in ToolName]?: Readonly<Record<string, ToolArgKey<T>>> };
const renamesOf = (tool: string): Readonly<Record<string, string>> | undefined =>
  (RENAMED as Readonly<Record<string, Readonly<Record<string, string>>>>)[tool];

function renamed(tool: string, args: Args): Args {
  const names = renamesOf(tool);
  if (names === undefined) return args;
  const out: Args = { ...args };
  for (const [from, to] of Object.entries(names)) {
    if (out[from] === undefined || out[to] !== undefined) continue;
    out[to] = out[from];
    delete out[from];
  }
  return out;
}

// A ref's kind, by its id's prefix. A handle says nothing of its kind, so it is left as it came.
const KIND_OF_PREFIX: { readonly [P in IdPrefix]?: string } = {
  msg: "message",
  evt: "event",
  ent: "entity",
  gol: "goal",
  hyp: "hypothesis",
  opp: "opportunity",
  rec: "agent_record",
};
const kindOf = (id: string): string | undefined => {
  const match = /^([a-z]{3})_[0-9A-Z]{26}$/.exec(id);
  return match === null ? undefined : KIND_OF_PREFIX[match[1] as IdPrefix];
};

// A bare id, or a ref with the wrong word for its kind (person, record, finding), as the ref its
// id's prefix says it is. The store still checks the caller can see it.
function ref(value: unknown): unknown {
  const bare = isObject(value) && Object.keys(value).every((key) => key === "id" || key === "kind");
  const id = typeof value === "string" ? value : bare ? (value as Args).id : undefined;
  const kind = typeof id === "string" ? kindOf(id) : undefined;
  return kind === undefined ? value : { kind, id };
}
const refs = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(ref)
    : typeof value === "string" && kindOf(value) !== undefined
      ? [ref(value)]
      : value;
const about = (value: unknown): unknown => (value === "owner" ? { kind: "owner" } : ref(value));

// An id taken as a plain string, a cite being one: a ref's id.
const ids = (value: unknown): unknown =>
  Array.isArray(value) ? value.map((one) => (isObject(one) && typeof one.id === "string" ? one.id : one)) : value;

const withField = (args: Args, name: string, change: (value: unknown) => unknown): Args =>
  args[name] === undefined ? args : { ...args, [name]: change(args[name]) };
const REFS_ABOUT = (args: Args): Args => withField(withField(args, "about", about), "basis", refs);

// Fields of an inner object sent beside it. Nothing is chosen between: with the object sent too, the
// call is left as it came.
function hoisted(args: Args, inner: string, names: readonly string[]): Args {
  const beside = names.filter((name) => args[name] !== undefined);
  if (beside.length === 0 || args[inner] !== undefined) return args;
  const out: Args = { ...args };
  const held: Args = {};
  for (const name of beside) {
    held[name] = out[name];
    delete out[name];
  }
  return { ...out, [inner]: held };
}

const REPORT_FIELDS = Object.keys(MoveReport.shape);
// The other words for done. The failed and blocked outcomes mean different things to the work, so a
// word that might be either is the agent's to choose.
const DONE_WORDS = new Set(["completed", "complete", "success", "succeeded", "finished"]);

function reportForm(args: Args): Args {
  const held = hoisted(args, "report", REPORT_FIELDS);
  const worded = typeof held.outcome === "string" && DONE_WORDS.has(held.outcome) ? { ...held, outcome: "done" } : held;
  const basis = withField(worded, "basis", refs);
  if (!isObject(basis.report)) return basis;
  return {
    ...basis,
    report: withField(withField(basis.report, "sources", refs), "candidates", refs),
  };
}

const PERSON_FIELDS = Object.keys(PROPOSE_PERSON_FIELDS.person.shape);
const RELATIONSHIP_FIELDS = Object.keys(PROPOSE_PERSON_FIELDS.relationship.shape);
// A link's own `kind` is told apart below.
const LINK_FIELDS = Object.keys(PROPOSE_PERSON_FIELDS.link.shape).filter((name) => name !== "kind");
const PROPOSAL_KINDS = ["person", "relationship", "link"];

// A person, relationship or link with its fields at the top level, its kind what they are. A link's
// own `kind`, the connection, is told from the proposal's by its value.
function personForm(args: Args): Args {
  if (args.fields !== undefined) return args;
  const has = (names: readonly string[]) => names.some((name) => args[name] !== undefined);
  if (has(LINK_FIELDS)) {
    const { kind, ...rest } = args;
    const connection = typeof kind === "string" && !PROPOSAL_KINDS.includes(kind) ? { kind } : {};
    const held = hoisted(rest, "fields", LINK_FIELDS);
    return { ...held, kind: "link", fields: { ...(held.fields as Args), ...connection } };
  }
  const [kind, names] = has(RELATIONSHIP_FIELDS) ? ["relationship", RELATIONSHIP_FIELDS] : ["person", PERSON_FIELDS];
  return has(names) ? { kind, ...hoisted(args, "fields", names) } : args;
}

// An older call's fields, and a kind that is no kind, say nothing a statement does not: the system
// decides the kind. A client-scoped preference alone still takes them.
function aboutYouForm(args: Args): Args {
  const cited = withField(args, "cites", ids);
  if (cited.statement === undefined || cited.scope === "this_client") return cited;
  const { fields: _fields, kind, ...rest } = cited;
  return StoredAboutYouKind.safeParse(kind).success ? { ...rest, kind } : rest;
}

function answerForm(args: Args): Args {
  const held = hoisted(args, "answer", ["quote", "about"]);
  return typeof held.answer === "string" ? { ...held, answer: { quote: held.answer } } : held;
}

const FORMS: { readonly [T in ToolName]?: (args: Args) => Args } = {
  propose_opportunity: REFS_ABOUT,
  propose_task: REFS_ABOUT,
  propose_hypothesis: REFS_ABOUT,
  propose_goal: REFS_ABOUT,
  propose_goal_target: REFS_ABOUT,
  record_test: REFS_ABOUT,
  report_move: reportForm,
  propose_person: (args) => withField(personForm(args), "cites", ids),
  propose_about_you: aboutYouForm,
  record: (args) => withField(args, "cites", ids),
  answer_owner_question: answerForm,
  set_intention: (args) => ({ kind: "check_back", ...args }),
  close_commitment: (args) => withField(args, "evidence", ids),
};

// A work tool's field that names work is the one another name for an opportunity's id goes to: an id
// sent as a ref, in quotes or backticks, or with its ULID in lower case means the id it plainly is. Its
// form is still checked by the schema.
const WORK_ID_PREFIXES = ["opp", "hdl"] as const satisfies readonly IdPrefix[];
const PLAIN_ID = new RegExp(`^[\\s\`'"]*(${WORK_ID_PREFIXES.join("|")})_([0-9A-Za-z]{26})[\\s\`'".,]*$`);
function plainId(value: unknown): unknown {
  const inner = isObject(value) && Object.keys(value).every((key) => key === "id" || key === "kind") ? value.id : value;
  if (typeof inner !== "string") return value;
  const match = PLAIN_ID.exec(inner);
  return match === null ? value : `${match[1]}_${match[2]?.toUpperCase()}`;
}

export function callForm(tool: string, args: unknown): unknown {
  if (!isObject(args)) return args;
  const renamedArgs = renamed(tool, args);
  const field = renamesOf(tool)?.opportunity_id;
  const named =
    field === undefined || renamedArgs[field] === undefined
      ? renamedArgs
      : { ...renamedArgs, [field]: plainId(renamedArgs[field]) };
  return (FORMS as Readonly<Record<string, ((args: Args) => Args) | undefined>>)[tool]?.(named) ?? named;
}
