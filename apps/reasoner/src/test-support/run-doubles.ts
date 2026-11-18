import {
  EntityView,
  type PersonalLogEvent,
  type PersonalLogger,
  PersonalReadTool,
  type PersonalToolError,
  RunRequest,
  SelfView,
  TurnReply,
  TurnRequest,
} from "@intelligence/contracts/personal";
import type { AgentApi } from "../ports.ts";

// Synthetic values and fakes for the reasoner's tests. Nothing here is real data.

export const RUN_ID = "run_01JABCDEFGHJKMNPQRSTVWXYZ0";
export const MESSAGE_ID = "msg_01JABCDEFGHJKMNPQRSTVWXYZ1";
export const MODEL = "vendor/reasoner-model";

export const runRequest = (limits: Partial<RunRequest["limits"]> = {}, id = RUN_ID): RunRequest =>
  RunRequest.parse({
    id,
    attempt: 1,
    source: "daily_sweep",
    anchors: [{ kind: "message", id: MESSAGE_ID }],
    goals: [],
    open: [],
    closed: [],
    intentions: [],
    point: { id: "run_outcome", version: 13, promptId: "personal_run", promptVersion: "4" },
    limits: {
      maxTurns: 6,
      maxToolCalls: 10,
      maxOutputTokens: 2000,
      maxInputCodePoints: 200_000,
      ceilingMicroUsdPerToken: 20,
      ...limits,
    },
  });

export const IGNORE = { actions: [{ do: "ignore", reason: "nothing_to_do" }] };

// A reply with no tool call: its text is the output.
export const answer = (
  output: unknown,
  usage: Partial<Pick<TurnReply, "inputTokens" | "outputTokens" | "costMicroUsd">> = {},
): TurnReply => ({
  text: typeof output === "string" ? output : JSON.stringify(output),
  toolCalls: [],
  inputTokens: 100,
  outputTokens: 20,
  costMicroUsd: 50,
  modelId: MODEL,
  ...usage,
});

// A reply that asks for tool calls.
export const calls = (...toolCalls: { name: string; arguments?: unknown }[]): TurnReply => ({
  text: null,
  toolCalls: toolCalls.map((call, index) => ({
    id: `call_${index}`,
    name: call.name,
    arguments: call.arguments ?? {},
  })),
  inputTokens: 100,
  outputTokens: 20,
  costMicroUsd: 50,
  modelId: MODEL,
});

// The reasoner's model, as the core's fakeTurnModel is (the reasoner may list no dev
// dependency, so it keeps its own copy): each turn is checked and recorded, then answered by the
// next reply in order; an Error is thrown in its turn; past the last reply every turn throws.
export function fakeTurnModel(replies: readonly (TurnReply | Error)[]): {
  turn(request: TurnRequest): Promise<TurnReply>;
  requests: TurnRequest[];
} {
  const queue = [...replies];
  const requests: TurnRequest[] = [];
  return {
    requests,
    async turn(request) {
      requests.push(structuredClone(TurnRequest.parse(request)));
      const next = queue.shift();
      if (next === undefined) throw new Error("unavailable");
      if (next instanceof Error) throw next;
      return TurnReply.parse(next);
    },
  };
}

type Answer = { ok: true; value: unknown } | { ok: false; code: PersonalToolError };
type Handler = (args: Record<string, unknown>) => Answer | Promise<Answer>;

// The agent API, scripted by tool name. Every call is recorded in order, with its arguments.
export function fakeAgentApi(
  handlers: Record<string, Handler> = {},
  extraTools: string[] = ["record", "next_run", "append_step", "finish_run", "propose_opportunity"],
) {
  const log: { name: string; args: Record<string, unknown> }[] = [];
  let closed = 0;
  const defaults: Record<string, Handler> = {
    append_step: () => ({ ok: true, value: { go: true } }),
    finish_run: (args) => ({
      ok: true,
      value: { recorded: args.outcome === "finished" ? 1 : 0, outcome: args.outcome },
    }),
    next_run: () => ({ ok: true, value: { run: runRequest() } }),
  };
  const api: AgentApi = {
    async listTools() {
      return [...PersonalReadTool.options, ...extraTools].map((name) => ({
        name,
        description: `the ${name} tool`,
        inputSchema: { type: "object" },
      }));
    },
    async call(name, args) {
      log.push({ name, args: structuredClone(args) as Record<string, unknown> });
      const handler = handlers[name] ?? defaults[name] ?? (() => ({ ok: true, value: { tool: name } }));
      return handler(args as Record<string, unknown>);
    },
    async close() {
      closed += 1;
    },
  };
  return {
    api,
    log,
    closed: () => closed,
    steps: () =>
      log.filter((call) => call.name === "append_step").map((call) => call.args.step as Record<string, unknown>),
    finishes: () => log.filter((call) => call.name === "finish_run").map((call) => call.args),
  };
}

// A clock that moves 7 milliseconds each time it is read, so a model call takes 7.
export const ticking = (): (() => number) => {
  let now = 0;
  return () => (now += 7);
};

export function memoryLogger(): PersonalLogger & { events: PersonalLogEvent[] } {
  const events: PersonalLogEvent[] = [];
  const write = (event: PersonalLogEvent) => {
    events.push(event);
  };
  return { events, info: write, warn: write, error: write };
}

// A synthetic person card of the size a live profile reaches with the agents' compartments, as
// get_entity serves a project's compiled facts: `agent` beliefs built from agents' findings the
// owner confirmed, each citing three findings with no message, and `mail` beliefs from the owner's
// own mail, each citing three facts with their messages, and twenty facts in no belief. Every name
// and address is made up.
export function bigEntity(counts: { agent: number; mail: number } = { agent: 70, mail: 60 }): EntityView {
  const owner = {
    id: `ent_${ulid(1)}`,
    kind: "owner",
    name: { untrusted: "Sam Example" },
    address: { untrusted: "sam@example.com" },
  };
  let serial = 10;
  const cite = (agent: boolean) => {
    serial += 1;
    return {
      id: hex(serial),
      subject: owner,
      statedBy: agent ? null : owner,
      basis: "explicit_self",
      statementKind: "stated_fact",
      at: at(serial),
      message: agent ? null : `msg_${ulid(serial)}`,
      document: null,
      passage: null,
      page: null,
      capture: null,
      segment: null,
      thirdParty: false,
      agentReported: agent,
      provenance: agent ? "agent_reported" : "source",
      status: "active",
      type: "preference",
      fields: { what: { untrusted: profileWords(serial) }, polarity: "prefers" },
    };
  };
  const belief = (agent: boolean, n: number) => ({
    fact: hex(100_000 + n),
    state: hex(200_000 + n),
    kind: "preference",
    type: "preference",
    status: "active",
    disputed: false,
    provenance: agent ? "corroborated" : "source",
    confirmedAt: at(n),
    reviewAfter: null,
    subject: owner,
    values: { polarity: "prefers" },
    cites: [cite(agent), cite(agent), cite(agent)],
  });
  const beliefs = [
    ...Array.from({ length: counts.agent }, (_, n) => belief(true, n)),
    ...Array.from({ length: counts.mail }, (_, n) => belief(false, counts.agent + n)),
  ];
  return EntityView.parse({
    id: `ent_${ulid(501)}`,
    kind: "person",
    names: [{ untrusted: "Person 1" }],
    addresses: [],
    organization: null,
    people: [],
    mail: { inbound: 1, outbound: 1, firstAt: null, lastAt: null },
    lastMeeting: null,
    nextMeeting: null,
    details: [],
    shared: false,
    facts: { beliefs, claims: Array.from({ length: 20 }, () => cite(false)), more: false },
  });
}

const ulid = (n: number): string =>
  n
    .toString(32)
    .toUpperCase()
    .replace(/I/g, "J")
    .replace(/L/g, "K")
    .replace(/O/g, "P")
    .replace(/U/g, "V")
    .padStart(26, "0");
const hex = (n: number): string => n.toString(16).padStart(64, "0");
const at = (n: number): string => new Date(Date.UTC(2026, 8, 1) + n * 3_600_000).toISOString();
const profileWords = (n: number): string =>
  `Wants to build a small research practice around hardware supply chains and keep Fridays clear for writing, note ${n}; prefers short calls, avoids long dinners, and is weighing two roles over the next quarter.`;

// get_self's worst case for the reasoner: `lines` goal lines of `length` code points over six life
// domains, half of them in career, 20 contacts, and `meetings` meetings of the owner and four
// people. Every name and address is made up.
const SELF_PAGE_DOMAINS = ["career", "health", "money", "family", "travel", "home"] as const;
export function bigSelfPage(
  options: { lines: number; length: number; meetings: number } = { lines: 66, length: 1_000, meetings: 30 },
): SelfView {
  const person = (n: number) => ({
    id: `ent_${ulid(500 + n)}`,
    kind: "person",
    name: { untrusted: `Person ${n}` },
    address: { untrusted: `person${n}@example.org` },
  });
  const owner = {
    id: `ent_${ulid(1)}`,
    kind: "owner",
    name: { untrusted: "Sam Example" },
    address: { untrusted: "sam@example.com" },
  };
  const domainOf = (n: number) => (n % 2 === 0 ? "career" : SELF_PAGE_DOMAINS[1 + (n % 5)]);
  const line = (n: number) => ({
    fact: hex(300_000 + n),
    kind: "goal",
    domain: domainOf(n),
    line: { untrusted: `Goal: ${profileWords(n).repeat(Math.ceil(options.length / 150))}`.slice(0, options.length) },
    tier: "owner",
    status: "active",
    since: at(n),
    at: at(1_000 - n),
    cites: 3,
  });
  const lines = Array.from({ length: options.lines }, (_, n) => line(n));
  const sections = SELF_PAGE_DOMAINS.flatMap((domain) => {
    const own = lines.filter((one) => one.domain === domain);
    return own.length === 0
      ? []
      : [
          {
            domain,
            lines: own,
            people: [person(1), person(2)].map((who) => ({ who, claims: 2 })),
            activeAt: own[0]?.at,
            more: false,
          },
        ];
  });
  return SelfView.parse({
    addresses: [{ untrusted: "sam@example.com" }],
    timeZone: null,
    upcoming: Array.from({ length: options.meetings }, (_, n) => ({
      id: `evt_${ulid(900 + n)}`,
      title: { untrusted: `Planning call ${n}` },
      startsAt: at(n),
      endsAt: at(n + 1),
      allDay: false,
      cancelled: false,
      participants: [owner, ...[0, 1, 2, 3].map((i) => person(n + i))],
    })),
    contacts: Array.from({ length: 20 }, (_, n) => ({ ...person(n), emails30d: n, emails90d: 2 * n, meetings90d: 1 })),
    sections,
    goals: [],
    changes: [],
  });
}
