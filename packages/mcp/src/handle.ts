// The MCP endpoint agents call: one JSON-RPC message in, one reply out, each tool call answered
// on a multiple of its deadline and logged by fixed codes only.

import type {
  DeployedCommit,
  PersonalLogger,
  PersonalToolError,
  RefusalWhy,
  SessionTaintCode,
  SessionTaintEntry,
  ToolName,
} from "@intelligence/contracts/personal";
import {
  agentGuideFor,
  BUDGETED_TOOLS,
  CLAIM_REFUSAL_FIELDS,
  CLAIM_REFUSAL_HINTS,
  ClaimRefusal,
  ClientView,
  faultOf,
  NOT_PERMITTED_OFFERED_HINT,
  PersonalTool,
  PersonalWorkTool,
  PersonalWriteTool,
  PROGRAM_TOOLS,
  REFUSAL_CODE_HINTS,
  REFUSAL_HINTS,
  SESSION_TAINT_HINTS,
  TOOL_NAMES,
  ToolRefusalCode,
} from "@intelligence/contracts/personal";
import { DEADLINE_MS, MAX_MULTIPLES } from "./deadlines.ts";
import { exampleFor } from "./examples.ts";
import type { Incoming, JsonRpcResponse, RpcError } from "./jsonrpc.ts";
import { failure, read, success } from "./jsonrpc.ts";
import { PROCESS_SESSIONS, readBy, SessionTaint, type TaintKey, verdictOn } from "./session-taint.ts";
import type { Called, Ports, Refused, Tool } from "./tools.ts";
import { isTool, offered, refusal } from "./tools.ts";

// The endpoint's methods, written by hand over one JSON-RPC message: ping, initialize,
// tools/list and tools/call. Nothing but each session's taint label is kept between messages: every
// request but ping asks the context provider who the client is, so a revoked client is refused on
// its next message.

// The one protocol revision served, whatever the client asks for. The agent guide is the
// initialize result's `instructions`, the lines of it that name only
// tools this client is offered.
//
// `serverInfo.version` is the commit the box was deployed at, or `unknown`, so an agent can tell
// what is deployed with no shell on the box. It is no secret and reads no row: it is the same word
// for every client whatever each may see, so it tells no caller anything about another's data.
const initialized = (tools: readonly Tool[], commit: DeployedCommit) => ({
  protocolVersion: "2025-06-18",
  capabilities: { tools: {} },
  serverInfo: { name: "personal-intelligence", version: commit },
  instructions: agentGuideFor(tools.map((tool) => tool.name)),
});

// `bug`: a call ended by an error nothing expects, logged by its class and answered `unavailable`.
type CallCode = "ok" | PersonalToolError | SessionTaintCode | RpcError | "bug";
// A tools/call's tool as logged: a tool served, else `unknown`, never the name sent.
type LoggedTool = ToolName | "unknown";

// The one log event of a request: who called, how it ended, how long it took to answer, for a
// tools/call which tool, and for a refusal why, as fixed codes. Never a method, an
// argument's value, a result or the token. For a tools/call the duration is the reply's, a
// multiple of its deadline, never the work's.
export function logCall(
  log: PersonalLogger,
  code: CallCode,
  durationMs: number,
  client?: string,
  tool?: LoggedTool,
  why?: RefusalWhy,
): void {
  log.info({
    event: "mcp_call",
    ...(client === undefined ? {} : { ids: { client } }),
    code,
    durationMs: Math.max(0, Math.round(durationMs)),
    ...(tool === undefined ? {} : { tool }),
    ...(why === undefined ? {} : { reason: why.reason }),
    ...(why?.field === undefined ? {} : { argument: why.field }),
  });
}

// A method not served, by the methods clients are known to send; any other is
// `other_method`. Never the method as sent.
const METHOD_CLASSES: Readonly<Record<string, string>> = {
  "prompts/list": "prompts_list",
  "prompts/get": "prompts_get",
  "resources/list": "resources_list",
  "resources/templates/list": "resource_templates_list",
  "resources/read": "resources_read",
  "completion/complete": "completion_complete",
  "logging/setLevel": "logging_set_level",
};
const methodClass = (method: string): string =>
  Object.hasOwn(METHOD_CLASSES, method) ? (METHOD_CLASSES[method] as string) : "other_method";

// A name that is no tool, by how near it is to one: `tool_spelling`, a tool's name
// in other case, with dashes or spaces; `tool_prefixed`, a tool's name after a namespace and a
// separator, as some clients send it; else `tool_unknown`. Never the name as sent.
function toolNameClass(name: string): string {
  const spelled = name.trim().toLowerCase().replace(/[-\s]/g, "_");
  if (isTool(spelled)) return "tool_spelling";
  if (
    TOOL_NAMES.some(
      (tool) =>
        spelled.length > tool.length &&
        spelled.endsWith(tool) &&
        /[_.:/]/.test(spelled.charAt(spelled.length - tool.length - 1)),
    )
  )
    return "tool_prefixed";
  return "tool_unknown";
}

// The clock the deadlines are kept by, and the wait. The
// defaults are a monotonic clock and a timer; a test hands fakes of both.
//
// `tally`, given by `pi http` alone, whose log no client reads: a call's work is run under it and one
// `tool_work` line says what the work really took. `pi mcp`
// gives none: its client's process reads its stderr, and that time is what the deadline hides.
type WorkTally = { statements: number; sqlMs: number; waitMs: number };
//
// `taint`: the sessions' labels this call's session is kept in (session-taint.ts); the process's own
// when none is given, and `false` for none at all, which only a test of what taint stops passes.
// `session`: the MCP session id the client sent, which with the token names the session.
export type HandleOptions = {
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  tally?: <T>(fn: () => Promise<T>) => Promise<{ value: T; tally: WorkTally }>;
  taint?: SessionTaint | false;
  session?: string;
};
const timer = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// A timer fires a little after its time: a wake within this of a multiple is on it.
const LATE_MS = 20;

// A message's answer, before it is logged and sent: how it ended, its reply, and for a refusal the
// details its reply's second text holds. REST reads them from here.
export type Answer = { code: CallCode; reply: JsonRpcResponse; details?: Record<string, unknown> };
// What a call has shown so far: a call cancelled at MAX_MULTIPLES is answered before its port
// returns, and is still logged with the client it found.
type Seen = { client?: string; why?: RefusalWhy };
// A call's session: the labels it is kept in and its key there, and the log a taint decision is
// logged to.
type Taint = { sessions: SessionTaint; key: TaintKey; log: PersonalLogger };
export type Request = Extract<Incoming, { kind: "request" }>;

// `work` is the work port: a work, run or propose tool's call reaches it, and no read method but
// `client`.
//
// A tools/call for a tool served, with a token, waits for a whole multiple of its deadline, so
// latency never reveals what a caller cannot see. It is answered exactly at its deadline after
// the line was handed in, whatever it found; past it, at the
// next whole multiple, logged as `reply_over_deadline` with the tool and the count
//. At MAX_MULTIPLES a call still working has its signal
// aborted and is answered `unavailable`. Everything else is answered at once: none of it reads a
// row under a compartment.
export async function handle(
  ports: Ports,
  log: PersonalLogger,
  token: string | undefined,
  message: string,
  options: HandleOptions = {},
): Promise<JsonRpcResponse | null> {
  return (await dispatch(ports, log, token, message, options))?.reply ?? null;
}

// `handle`, for a line of text or a request already built, as REST has one; null when the line wants
// no reply.
export async function dispatch(
  ports: Ports,
  log: PersonalLogger,
  token: string | undefined,
  message: string | Request,
  options: HandleOptions = {},
): Promise<Answer | null> {
  const clock = options.clock ?? (() => performance.now());
  const sleep = options.sleep ?? timer;
  const started = clock();
  const incoming = typeof message === "string" ? read(message) : message;
  if (incoming.kind === "ignored") return null;
  if (incoming.kind === "refused") {
    logCall(log, incoming.error, clock() - started);
    return { code: incoming.error, reply: failure(incoming.id, incoming.error) };
  }

  const sent = incoming.method === "tools/call" ? incoming.params.name : undefined;
  const name = typeof sent === "string" && isTool(sent) ? sent : undefined;
  const logged: LoggedTool | undefined = incoming.method === "tools/call" ? (name ?? "unknown") : undefined;
  const seen: Seen = {};
  const controller = new AbortController();
  const sessions = options.taint === false ? undefined : (options.taint ?? PROCESS_SESSIONS);
  const taint: Taint | undefined =
    sessions === undefined || !token ? undefined : { sessions, key: SessionTaint.keyOf(token, options.session), log };
  if (!token || name === undefined) {
    const answer = await respond(ports, token, incoming, controller.signal, seen, taint);
    logCall(log, answer.code, clock() - started, seen.client, logged, seen.why);
    return answer;
  }

  const deadline = DEADLINE_MS[name];
  let settled: Answer | undefined;
  let worked: { ms: number; tally: WorkTally } | undefined;
  const call = (): Promise<Answer> => respond(ports, token, incoming, controller.signal, seen, taint);
  if (options.tally === undefined)
    void call().then((answer) => {
      settled = answer;
    });
  else
    void options.tally(call).then(
      ({ value, tally }) => {
        settled = value;
        worked = { ms: clock() - started, tally };
      },
      () => {
        settled = { code: "bug", reply: failure(incoming.id, "unavailable") };
      },
    );
  // The reply waits for the first multiple of the deadline the work has finished by. A wake later
  // than its multiple, a timer held up by work on the event loop, is never answered off the
  // multiple: it waits for the next one the clock has not passed.
  let multiples = 0;
  let answer: Answer | undefined;
  while (answer === undefined) {
    multiples = Math.max(multiples + 1, Math.ceil((clock() - started - LATE_MS) / deadline));
    if (multiples > MAX_MULTIPLES) {
      // Still working at MAX_MULTIPLES: cancelled, and answered now, without waiting for
      // the port to roll back. Its later log lines are held as every line is.
      controller.abort();
      multiples = MAX_MULTIPLES;
      answer = { code: "unavailable", reply: failure(incoming.id, "unavailable") };
      break;
    }
    await sleep(Math.max(0, started + multiples * deadline - clock()));
    if (settled !== undefined && clock() - started <= multiples * deadline + LATE_MS) answer = settled;
  }
  if (multiples > 1) log.warn({ event: "reply_over_deadline", code: name, counts: { multiples }, tool: name });
  if (options.tally !== undefined) {
    // A call cancelled at MAX_MULTIPLES has no count yet: its work is at least that long.
    const counts = {
      work_ms: Math.round(worked?.ms ?? clock() - started),
      deadline_ms: deadline,
      multiples,
      ...(worked === undefined
        ? { cancelled: 1 }
        : {
            statements: worked.tally.statements,
            sql_ms: Math.round(worked.tally.sqlMs),
            wait_ms: Math.round(worked.tally.waitMs),
          }),
    };
    log.info({ event: "tool_work", code: answer.code, counts, tool: name });
  }
  logCall(log, answer.code, clock() - started, seen.client, logged, seen.why);
  return answer;
}

// A program's tools are not listed to an agent that works the board (one
// that holds a work tool), whose model would read their descriptions on every call. They stay
// callable by a client that holds them; a program sharing an agent's token, the memory adapter,
// lists them with tools/list's `programs: true`. A client holding no work tool (a reasoner, a
// device, a mirror) lists every tool it holds.
const worksTheBoard = (client: ClientView): boolean =>
  client.tools.some((tool) => PersonalWorkTool.safeParse(tool).success);
const listed = (client: ClientView, tools: readonly Tool[], programs: boolean): readonly Tool[] =>
  programs || !worksTheBoard(client) ? tools : tools.filter((tool) => !PROGRAM_TOOLS.includes(tool.name));

// Every invalid_request of a tool with examples (a claim refusal among them) carries one corrected
// example call (examples.ts), for the kind the call sent; a fixed text, after the code's or the
// tool's own hint.
const withExample = (name: unknown, args: unknown, hint: string | undefined): string | undefined => {
  const example = exampleFor(name, args);
  return example === undefined ? hint : hint === undefined ? example : `${hint} ${example}`;
};
// The fixed hint of a code refused as a tool result: the tool's own, else the code's. A program's
// tool is refused with the code and an invalid_request's arguments, and no hint. A tool the client
// is not offered, such as one a stale tool list names, is told the code's own hint (list the tools
// again), never the tool's.
export function hintFor(name: unknown, code: PersonalToolError, offered = true): string | undefined {
  const refused = ToolRefusalCode.safeParse(code);
  if (!refused.success || (typeof name === "string" && PROGRAM_TOOLS.includes(name))) return undefined;
  const tool = PersonalTool.safeParse(name);
  if (!offered || !tool.success) return REFUSAL_CODE_HINTS[refused.data];
  const own = REFUSAL_HINTS[tool.data]?.[refused.data];
  // An offered tool's not_permitted is its call refused: listing the tools again would not help.
  return own ?? (refused.data === "not_permitted" ? NOT_PERMITTED_OFFERED_HINT : REFUSAL_CODE_HINTS[refused.data]);
}

// The methods, for a request that has passed the envelope checks. It never throws: a fault
// anywhere in a call is answered `unavailable`. One expected (a store's or a driver's error, an
// abort) is logged `unavailable` by its SQLSTATE or class; any other is logged `bug` by its class,
// and the agent is answered the same, so a bug its call met says nothing more than an outage would.
async function respond(
  ports: Ports,
  token: string | undefined,
  incoming: Request,
  signal: AbortSignal,
  seen: Seen,
  taint: Taint | undefined,
): Promise<Answer> {
  const { id } = incoming;
  try {
    return await methods(ports, token, incoming, signal, seen, taint);
  } catch (error) {
    const fault = faultOf(error);
    if (fault.reason !== undefined) seen.why = { reason: fault.reason };
    return { code: fault.expected ? "unavailable" : "bug", reply: failure(id, "unavailable") };
  }
}

// A refusal the agent can read and act on: a tool result, its first text the code and nothing
// else. For invalid_request and not_found, a second text, JSON: the arguments the tool's schema
// refused with the rule each broke, and the tool's fixed hint (refusedArguments, REFUSAL_HINTS).
// Both come from the schema and fixed text alone, never from a value or a row.
// A refusal by the claim checks names its fixed code, `refusal`, and its fixed
// hint (CLAIM_REFUSAL_HINTS) in place of the tool's. Every code answered as a
// tool result has a hint, the tool's own (REFUSAL_HINTS) or else the code's
// (REFUSAL_CODE_HINTS), so a refusal always names its fix.
type Refusing = {
  // Whether the client is offered the tool; one it is not is told no more than the code.
  isOffered: boolean;
  refused?: Refused | undefined;
  claimRefusal?: ClaimRefusal | undefined;
  args?: unknown;
};
function refuse(
  { id, params }: Request,
  code: PersonalToolError,
  { isOffered, refused, claimRefusal, args }: Refusing,
  seen: Seen,
): Answer {
  const checked = claimRefusal === undefined ? undefined : ClaimRefusal.safeParse(claimRefusal);
  if (checked?.success === true) seen.why = { reason: checked.data };
  else if (!isOffered)
    seen.why = { reason: isTool(String(params.name)) ? "not_offered" : toolNameClass(String(params.name)) };
  // Why, as logged, for an invalid_request; one the schema let through, with no code of its own, is
  // the store's.
  else if (code === "invalid_request") seen.why = refused?.logged ?? { reason: "store" };
  const refusalAt =
    checked?.success === true && PersonalTool.safeParse(params.name).success
      ? CLAIM_REFUSAL_FIELDS[params.name as PersonalTool]?.[checked.data]
      : undefined;
  const field = refused?.field ?? refusalAt?.field;
  const reasons = refused?.reasons ?? [];
  const hint = withExample(
    !isOffered || code !== "invalid_request" ? undefined : params.name,
    args,
    checked?.success === true
      ? (refusalAt?.hint ?? CLAIM_REFUSAL_HINTS[checked.data])
      : hintFor(params.name, code, isOffered),
  );
  const details = {
    ...(checked?.success === true ? { refusal: checked.data } : {}),
    ...(field === undefined ? {} : { field }),
    ...(reasons.length === 0 ? {} : { arguments: reasons }),
    ...(hint === undefined ? {} : { hint }),
  };
  const more = Object.keys(details).length === 0 ? [] : [{ type: "text", text: JSON.stringify(details) }];
  return { code, reply: success(id, { isError: true, content: [{ type: "text", text: code }, ...more] }), details };
}

// A call refused for its session's label (session-taint.ts): a tool result, its first text the
// code and its second the code's fixed hint.
function refuseTainted({ id }: Request, code: SessionTaintCode, seen: Seen): Answer {
  seen.why = { reason: code };
  const details = { hint: SESSION_TAINT_HINTS[code] };
  return {
    code,
    reply: success(id, {
      isError: true,
      content: [
        { type: "text", text: code },
        { type: "text", text: JSON.stringify(details) },
      ],
    }),
    details,
  };
}

// A taint decision, counted in the store's ledger when the ports have one. A refusal is also the
// call's own mcp_call line. A count that fails is logged and changes nothing the caller is told.
async function countTaint(
  ports: Ports,
  taint: Taint,
  token: string,
  entry: SessionTaintEntry,
  options: { signal: AbortSignal },
): Promise<void> {
  if (ports.taintLedger === undefined) return;
  await ports.taintLedger.countSessionTaint(token, entry, options).catch(() => {
    taint.log.warn({ event: "session_taint_count_failed", code: entry.code, tool: entry.tool });
  });
}

// Every port call is handed the signal.
async function methods(
  ports: Ports,
  token: string | undefined,
  request: Request,
  signal: AbortSignal,
  seen: Seen,
  taint: Taint | undefined,
): Promise<Answer> {
  const { id, method, params } = request;
  const done = (code: CallCode, reply: JsonRpcResponse): Answer => ({ code, reply });
  const fail = (error: RpcError): Answer => done(error, failure(id, error));
  const options = { signal };

  if (method === "ping") return done("ok", success(id, {}));

  if (!token) return fail("unauthorized");
  // A fault here or in a tool's call is answered by `respond`.
  const found: unknown = await ports.provider.client(token, options);
  if (found === null) return fail("unauthorized");
  // The provider's answer is checked before anything is decided from it.
  const view = ClientView.safeParse(found);
  if (!view.success) return fail("unavailable");
  const client = view.data;
  seen.client = client.name;

  const tools = offered(client);
  if (method === "initialize") return done("ok", success(id, initialized(tools, ports.commit ?? "unknown")));
  if (method === "tools/list") {
    return done(
      "ok",
      success(id, {
        tools: listed(client, tools, params.programs === true).map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      }),
    );
  }
  if (method !== "tools/call") {
    seen.why = { reason: methodClass(method) };
    return fail("method_not_found");
  }

  const { name, arguments: args = {} } = params;
  if (typeof name !== "string") return fail("invalid_params");
  // A tool that is not the client's and a name that is no tool at all look the same. The first
  // is recorded by the provider; the second is not, since its call log takes tool names only.
  const tool = tools.find((candidate) => candidate.name === name);
  const isOffered = tool !== undefined;

  // A tool offered is first checked against its session's label. A refusal is recorded as a call
  // refused before any read, so it keeps its one call log row; only a failure to record it changes
  // the answer.
  // The token's mark is kept per client, not per bearer: an OAuth client's bearer changes every
  // hour, and a refresh must not start it clean.
  const taintKey = taint === undefined ? undefined : SessionTaint.forClient(taint.key, client.id);
  if (tool !== undefined && taint !== undefined && taintKey !== undefined) {
    const { sessions } = taint;
    const key = taintKey;
    const verdict = verdictOn(sessions.label(key), client, tool.name, args, sessions.tokenLabel(key));
    if (verdict !== null && "refuse" in verdict) {
      const recorded = await refusal(ports, token, tool.name, { ...options, why: { reason: verdict.refuse } });
      if (!recorded.ok && (recorded.code === "unauthorized" || recorded.code === "unavailable"))
        return fail(recorded.code);
      await countTaint(ports, taint, token, { tool: tool.name, code: verdict.refuse, enforced: true }, options);
      return refuseTainted(request, verdict.refuse, seen);
    }
    if (verdict !== null)
      await countTaint(ports, taint, token, { tool: tool.name, code: verdict.shadow, enforced: false }, options);
  }

  let outcome: Called;
  if (tool !== undefined) outcome = await tool.call(ports, token, args, options);
  else if (isTool(name)) outcome = await refusal(ports, token, name, options);
  else outcome = { ok: false, code: "not_permitted" };
  // What an answered call read joins its session's label.
  if (tool !== undefined && taint !== undefined && taintKey !== undefined)
    taint.sessions.add(taintKey, outcome.ok ? readBy(client, tool.name) : null);
  if (outcome.ok)
    return done(
      "ok",
      success(id, {
        content: [{ type: "text", text: JSON.stringify(outcome.value) }],
        structuredContent: outcome.value,
      }),
    );
  switch (outcome.code) {
    case "invalid_request":
      return refuse(
        request,
        outcome.code,
        { isOffered, refused: outcome.refused, claimRefusal: outcome.refusal, args },
        seen,
      );
    // about's not_found may carry its refusal, subject_unknown, and its hint.
    case "not_found":
    // plan_move's names its reason.
    case "not_permitted":
      return refuse(request, outcome.code, { isOffered, claimRefusal: outcome.refusal }, seen);
    // sync_mirror's own two: Lens wipes on the first and shows "update
    // Lens" on the second; no other tool answers either.
    case "stale_cursor":
    case "unsupported_template":
    // propose_task's and hand_off's role no active agent holds.
    case "unknown_role":
      return refuse(request, outcome.code, { isOffered }, seen);
    // The write tools' own answer (record's past its 200 a day), draft_message's, or a read past one of
    // the client's budgets, which names its window (the minute's or the day's) and that window's hint:
    // the agent's to act on, carrying no number; and a push past a device's bounds, which Lens retries
    // later. A budgeted work tool's is a read's; from any other work tool it is a failure.
    case "rate_limited":
      return PersonalWriteTool.safeParse(name).success ||
        name === "draft_message" ||
        name === "push_capture" ||
        (BUDGETED_TOOLS as readonly string[]).includes(name)
        ? refuse(request, outcome.code, { isOffered, claimRefusal: outcome.refusal }, seen)
        : fail("unavailable");
    case "unauthorized":
      return fail("unauthorized");
    case "unavailable":
      return fail("unavailable");
  }
}
