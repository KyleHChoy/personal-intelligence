// The agent tools' handlers: each checks its arguments against the tool's schema, then makes
// the one port call that tool is allowed.

import type {
  CallOptions,
  ClientView,
  DeployedCommit,
  PersonalReads,
  PersonalWork,
  PersonalWrites,
  ReadOutcome,
  RefusalOptions,
  RefusalWhy,
  RefusedArgument,
  SessionTaintLedger,
  ToolName,
  ToolSchema,
  ToolValue,
  ToolWire,
} from "@intelligence/contracts/personal";
import {
  agentCallOf,
  answerOf,
  compactResult,
  idsInProse,
  isCompactReadTool,
  methodOf,
  onWorkPort,
  PersonalReadTool,
  PROSE_UNCHECKED_TOOLS,
  proseFieldsWithIds,
  REPORT_CHECK_HINTS,
  refusedArguments,
  shapedAs,
  TOOL_NAMES,
  TOOL_WIRE,
  toolView,
  WORK_TOOL_WIRE,
  WRITE_TOOL_WIRE,
} from "@intelligence/contracts/personal";

import { callForm } from "./call-forms.ts";
import { examplesLine } from "./examples.ts";
import { DESCRIPTIONS, NAMES_A_TOOL } from "./tool-descriptions.ts";

// The read, write, work, run and propose tools: the arguments each takes and the one call it makes,
// and how a call that is refused before that call is recorded. What each is for is
// tool-descriptions.ts; each tool's row is the contracts' tool-wire.ts.

// What the agent API is handed: the reads and the writes.
export type Provider = PersonalReads & PersonalWrites;
// Both ports a call may reach: the provider, and the work port. `commit`: the commit the process
// was deployed at, which `initialize` answers as the server's version; `unknown` when not given.
// `taintLedger`: where each session taint decision is counted (session-taint.ts); without it, each
// is logged only.
export type Ports = {
  provider: Provider;
  work: PersonalWork;
  commit?: DeployedCommit;
  taintLedger?: SessionTaintLedger;
};

// What an invalid call was refused for, from the schema alone (refusedArguments): each argument with
// the rule it broke, what a client is told with an invalid_request. `logged`: the first of them as
// the log keeps it, `schema_` and its issue's code, or for an argument that takes ids
// `schema_id_form_` and the form of what it sent (refusedArguments' idForm), with the argument's
// top-level name only when it is a key of the tool's own schema and fits the log's field, never a
// name the call sent. `field`: where an id in prose sits.
export type Refused = { reasons?: RefusedArgument[]; logged?: RefusalWhy; field?: string };
// A port's answer, with what was refused when the call never reached a port.
export type Called = ReadOutcome<unknown> & { refused?: Refused };

export type Tool = {
  name: ToolName;
  description: string;
  inputSchema: unknown;
  // The arguments parsed, one call made, and its value checked before it is sent. Arguments
  // that do not parse are recorded as refused, and nothing is called. `options` goes to the port
  // call as it is.
  call(ports: Ports, token: string, args: unknown, options: CallOptions): Promise<Called>;
};
const LOGGED_REASON = /^schema_[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const LOGGED_ARGUMENT = /^[a-z][A-Za-z0-9_]{0,63}$/;

// One of the tools served, whether or not a client is offered it.
export const isTool = (name: string): name is ToolName => (TOOL_NAMES as readonly string[]).includes(name);

// A call refused here, before any read: the provider records it in its call log, and the work
// port for a work, run or propose tool (refusedWork). It is told
// the tool and no code: the code it decides from the client's registration is the one recorded
// and the one answered. If the refusal could not be recorded, the answer is that failure. A
// provider that answers anything but a failure is not believed, nor one that answers
// rate_limited: a refusal writes no agent record, so it cannot be over the quota.
export async function refusal(
  ports: Ports,
  token: string,
  name: ToolName,
  options: RefusalOptions,
): Promise<ReadOutcome<never>> {
  const outcome = onWorkPort(name)
    ? await ports.work.refusedWork(token, name as never, options)
    : await ports.provider.refused(token, name, options);
  return outcome.ok || outcome.code === "rate_limited" ? { ok: false, code: "unavailable" } : outcome;
}

// Whether the owner reads a call's prose: not a read's, and not one PROSE_UNCHECKED_TOOLS lists, and
// not a handoff note, for the caller's own next session.
const proseChecked = (name: ToolName, args: unknown): boolean =>
  PersonalReadTool.safeParse(name).success === false &&
  !PROSE_UNCHECKED_TOOLS.includes(name) &&
  !(name === "record" && typeof args === "object" && args !== null && (args as { kind?: unknown }).kind === "handoff");

// `published`, when given, is the schema tools/list sends in place of the one that parses: a tool
// that still takes deprecated keys leaves them out of what a model reads.
function tool<Args extends ToolSchema, Result extends ToolSchema>(
  name: ToolName,
  args: Args,
  result: Result,
  run: (
    ports: Ports,
    token: string,
    args: ToolValue<Args>,
    options: CallOptions,
  ) => Promise<ReadOutcome<ToolValue<Result>>>,
  published: ToolSchema = args,
): Tool {
  // A refusal is told in the published schema's words: its keys, never a deprecated one.
  const shaped = shapedAs(args, published);
  const refusedBy = (value: unknown): Refused => {
    const all = refusedArguments(name, shaped, callForm(name, value));
    const reasons = all.map((one) => one.argument);
    const [first] = all;
    if (first === undefined) return { reasons };
    const top = first.argument.name.split(".")[0] ?? "";
    // A wrong id's form, by its prefix, never the value: what the log needs to say why an id was refused.
    const reason = first.idForm === undefined ? `schema_${first.issue}` : `schema_id_form_${first.idForm}`;
    const own =
      first.issue !== "unrecognized_keys" && Object.keys(shaped.shape ?? {}).includes(top) && LOGGED_ARGUMENT.test(top);
    return {
      reasons,
      logged: { reason: LOGGED_REASON.test(reason) ? reason : "schema", ...(own ? { field: top } : {}) },
    };
  };
  return {
    name,
    description: `${DESCRIPTIONS[name]}${examplesLine(name)}`,
    inputSchema: published.toJSONSchema({ io: "input", reused: "ref" }),
    async call(ports, token, value, options) {
      const form = callForm(name, value);
      const parsed = args.safeParse(form);
      if (!parsed.success) {
        const refused = refusedBy(value);
        return { ...(await refusal(ports, token, name, { ...options, why: refused.logged })), refused };
      }
      // An id in prose a person reads is refused, recorded as any refusal here is, with the code
      // that says to write names.
      if (proseChecked(name, parsed.data) && idsInProse(parsed.data)) {
        const refused = await refusal(ports, token, name, { ...options, why: { reason: "ids_in_prose" } });
        return !refused.ok && refused.code === "invalid_request"
          ? { ...refused, refusal: "ids_in_prose", refused: { field: proseFieldsWithIds(form).join(", ") } }
          : refused;
      }
      const outcome = await run(ports, token, parsed.data as ToolValue<Args>, options);
      if (!outcome.ok) return outcome;
      // A value that is not the tool's strict result, such as evidence text not wrapped as
      // untrusted, is never sent. A read result an agent reads is sent in its wire form, made
      // short by code after the check (compactResult).
      const checked = result.safeParse(outcome.value);
      if (!checked.success) return { ok: false, code: "unavailable" };
      return { ok: true, value: isCompactReadTool(name) ? compactResult(name, checked.data) : checked.data };
    },
  };
}

// A tool that only forwards: one call of the method its name gives, on the port its family reaches.
// Called as a member, since the reader is a class.
function forwarded(name: ToolName): Tool {
  const { args, result, published }: ToolWire = TOOL_WIRE[name];
  const method = methodOf(name);
  type Serve = (token: string, args: unknown, options: CallOptions) => Promise<ReadOutcome<unknown>>;
  return tool(
    name,
    args,
    result,
    (ports, token, values, options) => {
      const port = onWorkPort(name) ? ports.work : ports.provider;
      return (port[method as keyof typeof port] as unknown as Serve).call(port, token, values, options);
    },
    published,
  );
}

// The tools that do more than forward.
const OWN_TOOLS: Partial<Record<ToolName, Tool>> = {
  // A goal of the owner's is propose_goal's; every other call reaches the store as a statement call, its
  // kind a hint and its fields never trusted.
  propose_about_you: tool(
    "propose_about_you",
    WRITE_TOOL_WIRE.propose_about_you.args,
    WRITE_TOOL_WIRE.propose_about_you.result,
    async (ports, token, args, options) => {
      if (args.kind === "goal") {
        const refused = await refusal(ports, token, "propose_about_you", {
          ...options,
          why: { reason: "goal_proposed_elsewhere" },
        });
        return !refused.ok && refused.code === "invalid_request"
          ? { ...refused, refusal: "goal_proposed_elsewhere" }
          : refused;
      }
      return ports.provider.proposeAboutYou(token, agentCallOf(args), options);
    },
    WRITE_TOOL_WIRE.propose_about_you.published,
  ),
  // A deprecated `facts` is dropped here; the store keeps the owner's words alone.
  answer_owner_question: tool(
    "answer_owner_question",
    WRITE_TOOL_WIRE.answer_owner_question.args,
    WRITE_TOOL_WIRE.answer_owner_question.result,
    ({ provider }, token, args, options) =>
      provider.answerOwnerQuestion(token, { ...args, answer: answerOf(args) }, options),
    WRITE_TOOL_WIRE.answer_owner_question.published,
  ),
  // A refused report carries each code's fixed hint.
  report_move: tool(
    "report_move",
    WORK_TOOL_WIRE.report_move.args,
    WORK_TOOL_WIRE.report_move.result,
    async ({ work }, token, args, options) => {
      const outcome = await work.reportMove(token, args, options);
      if (!outcome.ok || !("refused" in outcome.value)) return outcome;
      return {
        ok: true,
        value: {
          ...outcome.value,
          hints: Object.fromEntries(outcome.value.refused.map((code) => [code, REPORT_CHECK_HINTS[code]])),
        },
      };
    },
  ),
};

const TOOLS = Object.fromEntries(TOOL_NAMES.map((name) => [name, OWN_TOOLS[name] ?? forwarded(name)])) as Record<
  ToolName,
  Tool
>;

const viewHeld = (client: ClientView, name: ToolName): boolean => {
  const view = toolView(name);
  return view === null || client.views.includes(view);
};

// The tools a client is offered: those in its registration whose view it holds.
export const offered = (client: ClientView): Tool[] => {
  const names = TOOL_NAMES.filter((name) => client.tools.includes(name) && viewHeld(client, name));
  const lacked = NAMES_A_TOOL.filter((one) => !names.includes(one.tool));
  return names.map((name) => ({
    ...TOOLS[name],
    description: lacked.reduce((said, one) => said.replace(one.text, ""), TOOLS[name].description),
  }));
};
