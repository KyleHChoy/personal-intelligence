// Shared fixtures for the handle-*.test.ts files: one valid value of each read's result, a fake
// context provider and logger, the request builders, and the error table.
import type { PersonalReads, PersonalWrites } from "@intelligence/contracts/personal";
import {
  AboutView,
  BeliefList,
  ChangesView,
  ClientView,
  CommitmentList,
  type CompactReadTool,
  ContextView,
  compactResult,
  EntityView,
  EvidenceSpan,
  FactList,
  GoalList,
  MemoryProjection,
  MessageList,
  MessageView,
  methodOf,
  OpenItems,
  PathList,
  PeopleList,
  type PersonalTool,
  type PersonalToolError,
  READ_TOOL_WIRE,
  RecordFind,
  RecordRead,
  RecordReads,
  SearchResult,
  SelfView,
  ThreadView,
  TimelineView,
  toolView,
  WRITE_TOOL_WIRE,
} from "@intelligence/contracts/personal";
import {
  type Call,
  call,
  fakeLog,
  handleAtOnce as handle,
  NO_WORK,
  toolResult as rawResult,
  recorded,
  request,
  rpcError,
  TOKEN,
  toolError,
  ulid,
} from "./fakes.ts";

export { type Call, call, fakeLog, rawResult, request, rpcError, TOKEN, ulid };

// Hand-written fixtures: reserved domains only, and ids that are valid but mean nothing.
export const PERSON = `ent_${ulid(1)}`;
export const ORGANIZATION = `ent_${ulid(2)}`;
export const MESSAGE_ID = `msg_${ulid(1)}`;

export const who = {
  id: PERSON,
  kind: "person",
  name: { untrusted: "Ada Example" },
  address: { untrusted: "ada@example.com" },
};
export const meeting = {
  id: `evt_${ulid(1)}`,
  title: { untrusted: "Planning" },
  startsAt: "2026-01-05T10:00:00Z",
  endsAt: "2026-01-05T11:00:00Z",
  allDay: false,
  cancelled: false,
  participants: [who],
};

export const SELF = SelfView.parse({
  addresses: [{ untrusted: "owner@example.com" }],
  timeZone: "Etc/UTC",
  upcoming: [meeting],
  contacts: [{ ...who, emails30d: 3, emails90d: 5, meetings90d: 1 }],
  changes: [],
});
export const SEARCH = SearchResult.parse({ results: [{ ...who, lastInteractionAt: "2026-01-02T09:00:00Z" }] });
export const ENTITY = EntityView.parse({
  id: PERSON,
  kind: "person",
  names: [{ untrusted: "Ada Example" }],
  addresses: [{ untrusted: "ada@example.com" }],
  organization: { id: ORGANIZATION, kind: "organization", name: { untrusted: "Example Org" }, address: null },
  people: [],
  mail: { inbound: 2, outbound: 3, firstAt: "2025-12-01T09:00:00Z", lastAt: "2026-01-02T09:00:00Z" },
  lastMeeting: null,
  nextMeeting: meeting,
  details: [],
  shared: false,
  facts: { beliefs: [], claims: [], more: false },
});
export const TIMELINE = TimelineView.parse({
  entries: [
    {
      kind: "email",
      id: MESSAGE_ID,
      at: "2026-01-02T09:00:00Z",
      direction: "inbound",
      subject: { untrusted: "Hello" },
      thread: { untrusted: "thread-1" },
    },
    { kind: "meeting", at: "2026-01-05T10:00:00Z", meeting },
  ],
});
// An invoice: bulk mail, with one attachment and a link to its thread.
export const LINK = "https://mail.google.com/mail/u/0/#all/18c2f0a1b2c3d4e5";
export const attachment = {
  name: { untrusted: "invoice-4417.pdf" },
  type: { untrusted: "application/pdf" },
  size: 2048,
};
export const summary = {
  id: MESSAGE_ID,
  at: "2026-01-02T09:00:00Z",
  direction: "inbound",
  bulk: true,
  category: "updates",
  subject: { untrusted: "Invoice 4417" },
  sender: { address: { untrusted: "billing@example.com" }, name: { untrusted: "Example Billing" } },
  chars: 12,
  attachments: 1,
};
export const MESSAGES = MessageList.parse({ messages: [summary], more: false });
export const MESSAGE = MessageView.parse({
  ...summary,
  thread: { untrusted: "thread-1" },
  text: { untrusted: "Total: 12.00" },
  offset: 0,
  more: false,
  unreadable: false,
  attachmentList: [attachment],
  link: LINK,
});

// Two facts from that message: the receipt, and a commitment its sender made to the owner.
export const FACT_ID = "a".repeat(64);
export const owner = { id: `ent_${ulid(3)}`, kind: "owner", name: null, address: { untrusted: "owner@example.com" } };
export const receipt = {
  id: FACT_ID,
  type: "transaction.receipt",
  subject: who,
  statedBy: who,
  basis: "explicit_self",
  statementKind: "stated_fact",
  at: "2026-01-02T09:00:00Z",
  message: MESSAGE_ID,
  document: null,
  passage: null,
  page: null,
  capture: null,
  segment: null,
  thirdParty: false,
  agentReported: false,
  provenance: "source",
  fields: {
    merchant: { untrusted: "Example Billing" },
    amount: 12,
    currency: "USD",
    date: "2026-01-02",
    order_ref: { untrusted: "4417" },
  },
};
export const commitment = {
  ...receipt,
  id: "b".repeat(64),
  type: "commitment",
  statementKind: "decision",
  status: "active",
  fields: { counterparty: owner, what: { untrusted: "Send the signed copy" }, due: "2026-01-09" },
};
export const CHANGES = ChangesView.parse({
  changes: [{ change: "cleared", key: `sig_${"a".repeat(32)}`, at: "2026-11-05T00:00:00.000Z" }],
  cursor: null,
  more: false,
});
export const OPEN_ITEMS = OpenItems.parse({
  items: [
    {
      what: { untrusted: "Order the firebricks" },
      due: "2026-11-05",
      source: { kind: "next_step", id: "1".repeat(64), record: `rec_${"1".repeat(26)}` },
      whoActs: { id: `ent_${"1".repeat(26)}`, kind: "owner", name: null, address: null },
      project: null,
      overdue: false,
      lateDays: null,
    },
  ],
  more: false,
});
export const FACTS = FactList.parse({ facts: [commitment, receipt], more: false });
// One commitment the owner is owed, its words from the message they came from.
export const COMMITMENTS = CommitmentList.parse({
  commitments: [
    {
      belief: {
        fact: "c".repeat(64),
        state: "d".repeat(64),
        kind: "commitment",
        type: "commitment",
        status: "active",
        disputed: false,
        provenance: "source",
        confirmedAt: "2026-01-02T09:00:00Z",
        reviewAfter: "2026-07-01T09:00:00Z",
      },
      direction: "owed_to_owner",
      counterparty: who,
      due: "2026-01-09",
      what: { untrusted: "Send the signed copy" },
      message: MESSAGE_ID,
      capture: null,
      segment: null,
    },
  ],
  more: false,
});
// One belief a person stated of themselves, citing the commitment fact above.
// One goal the owner set.
export const GOALS = GoalList.parse({
  goals: [
    {
      id: `gol_${ulid(1)}`,
      statement: { untrusted: "Ship the review." },
      status: "active",
      setAt: "2026-01-05T10:00:00Z",
    },
  ],
  more: false,
});
// One section of one line, and that goal.
export const CONTEXT = ContextView.parse({
  domains: ["career"],
  sections: [
    {
      domain: "career",
      lines: [
        {
          fact: "d".repeat(64),
          kind: "goal",
          domain: "career",
          line: { untrusted: "Goal: Ship the review" },
          tier: "owner",
          status: "active",
          since: "2026-01-05T10:00:00Z",
          at: "2026-01-05T10:00:00Z",
          cites: 1,
        },
      ],
      people: [],
      activeAt: "2026-01-05T10:00:00Z",
      more: false,
    },
  ],
  people: [],
  commitments: [],
  goals: GOALS.goals,
  evidence: [],
  more: false,
});

export const BELIEFS = BeliefList.parse({
  beliefs: [
    {
      fact: "e".repeat(64),
      state: "f".repeat(64),
      kind: "commitment",
      type: "commitment",
      status: "active",
      disputed: false,
      provenance: "source",
      confirmedAt: "2026-01-02T09:00:00Z",
      reviewAfter: "2026-07-01T09:00:00Z",
      subject: who,
      values: { counterparty: owner, due: "2026-01-09" },
      cites: [commitment],
    },
  ],
  more: false,
});
// One entry and its stamp, typed values only.
export const MEMORY = MemoryProjection.parse({
  template: "active_memory@1",
  asOf: "2026-01-02T09:00:00Z",
  entries: [
    {
      kind: "commitment",
      section: "commitments",
      stamp: { projection: `mpr_${"1".repeat(40)}`, fact: "c".repeat(64), state: "d".repeat(64) },
      status: "active",
      direction: "owed_to_owner",
      counterparty: PERSON,
      due: "2026-01-09",
    },
  ],
  corrections: [],
  remove: [],
  truncated: false,
  inStep: false,
  hash: "e".repeat(64),
});

// The passage the receipt cites, and the invoice's thread.
export const SPAN = EvidenceSpan.parse({
  fact: FACT_ID,
  source: { kind: "message", id: MESSAGE_ID },
  passage: { untrusted: "Total: 12.00" },
  chars: 12,
  cut: false,
});
export const THREAD = ThreadView.parse({
  thread: { untrusted: "thread-1" },
  messages: [{ summary, text: { untrusted: "Total: 12.00" }, offset: 0, cut: false }],
  next: null,
});

// One note of the caller's own, shown to one other client twice.
export const RECORD_READS = RecordReads.parse({
  records: [
    {
      record: `rec_${ulid(4)}`,
      kind: "note",
      recordedAt: "2026-01-02T09:00:00Z",
      supersededBy: null,
      erased: false,
      readers: [{ client: "other-agent", firstAt: "2026-01-02T10:00:00Z", lastAt: "2026-01-03T10:00:00Z", count: 2 }],
    },
  ],
  more: false,
});

// One person of the caller's audience, by tier.
const RECORD_ID = `rec_${"1".repeat(26)}`;
export const RECORD_READ = RecordRead.parse({
  id: RECORD_ID,
  kind: "finding",
  client: "claude-code",
  at: "2026-09-01T00:00:00.000Z",
  body: { untrusted: "The kiln takes grade 23 firebrick." },
  chars: 33,
  cut: false,
  removed: false,
});
export const RECORD_FIND = RecordFind.parse({ records: [RECORD_READ], more: false });
export const PEOPLE_LIST = PeopleList.parse({
  people: [
    {
      id: `ent_${ulid(5)}`,
      name: { untrusted: "Ada" },
      address: { untrusted: "ada@example.com" },
      warmth: {
        tier: "close",
        tierSource: "inferred",
        dormant: false,
        warmth: 2.5,
        active: 2.5,
        depth: 3,
        firstTwoWayAt: "2026-01-02T09:00:00Z",
        lastTwoWayAt: "2026-01-03T09:00:00Z",
        replyRate: null,
        replyHours: null,
        theyStart: null,
        channels: ["email"],
        stale: false,
        rebuilding: false,
      },
    },
  ],
  next: null,
  rebuilding: false,
});

// One person, one belief with its one cited claim.
export const ABOUT = AboutView.parse({
  subject: { id: PERSON, kind: "person", name: { untrusted: "Ada Example" } },
  candidates: [],
  beliefs: [
    {
      kind: "role",
      factKey: "c".repeat(64),
      value: {},
      status: "active",
      tier: "source",
      provenance: "source",
      disputed: false,
      settledBy: null,
      independentSources: 1,
      canonical: FACT_ID,
      support: [
        { fact: FACT_ID, speaker: PERSON, at: "2026-01-02T09:00:00Z", span: { start: 0, end: 4 }, tier: "source" },
      ],
      supportCount: 1,
      relations: [],
      asOf: "2026-01-03T09:00:00Z",
    },
  ],
  claims: [],
  claimCount: 0,
  commitments: [],
  toOwner: null,
  connections: [],
  links: [],
  knownVia: null,
  mail: { inbound: 1, outbound: 0, firstAt: "2026-01-02T09:00:00Z", lastAt: "2026-01-02T09:00:00Z" },
  lastMeeting: null,
  nextMeeting: null,
  warmth: null,
  asOf: "2026-01-03T09:00:00Z",
  next: null,
});

// A fake context provider. It records every method reached for, so a test can show which reads ran.
export function fakeReads(over: Partial<PersonalReads & PersonalWrites> = {}): {
  reads: PersonalReads & PersonalWrites;
  calls: Call[];
} {
  const calls: Call[] = [];
  const base = {
    // Every method answers unavailable, but those of the table of calls.
    ...Object.fromEntries(
      [...Object.keys(READ_TOOL_WIRE), ...Object.keys(WRITE_TOOL_WIRE), "file_research"].map((name) => [
        methodOf(name),
        async () => ({ ok: false, code: "unavailable" }),
      ]),
    ),
    ...Object.fromEntries(TOOL_CALLS.map(({ method, value }) => [method, async () => ({ ok: true, value })])),
    client: async () => CLIENT,
    // As the store's reader does: the code comes from the client's registration, never from
    // the caller. A tool or view the client lacks is not_permitted, and otherwise invalid_request.
    refused: async (token: string, tool: PersonalTool) => {
      const client = await base.client(token);
      const view = toolView(tool);
      const held = client?.tools.includes(tool) && (view === null || client.views.includes(view));
      return { ok: false, code: held ? "invalid_request" : "not_permitted" };
    },
    ...over,
  } as PersonalReads & PersonalWrites;
  const reads = new Proxy(base, {
    get(target, key) {
      const method = Reflect.get(target, key) as ((...args: unknown[]) => unknown) | undefined;
      return (...args: unknown[]) => {
        calls.push({ method: String(key), args: recorded(args) });
        return method?.(...args);
      };
    },
  });
  return { reads, calls };
}

// A read tool's value is sent in its wire form (compactResult); sync_memory's as it is.
export const toolResult = (tool: CompactReadTool, id: unknown, value: unknown) =>
  rawResult(id, compactResult(tool, value));
export const sentOf = (name: string, value: unknown) =>
  name === "sync_memory" ? rawResult(1, value) : toolResult(name as CompactReadTool, 1, value);

// One route to Ada, through Grace, whom the owner wrote to and heard from.
export const PATHS = PathList.parse({
  paths: [
    {
      score: 1 / 3,
      hops: [
        {
          from: { id: `ent_${ulid(9)}`, kind: "owner", name: null, address: { untrusted: "owner@example.com" } },
          to: { ...who, id: `ent_${ulid(3)}`, name: { untrusted: "Grace Example" } },
          via: "own_tie",
          facts: [],
        },
        {
          from: { ...who, id: `ent_${ulid(3)}`, name: { untrusted: "Grace Example" } },
          to: who,
          via: "relationship",
          facts: ["e".repeat(64)],
        },
      ],
    },
  ],
  cut: false,
});

// One valid call of each tool, with what the fake answers.
export const TOOL_CALLS = [
  { name: "get_self", method: "getSelf", args: {}, value: SELF },
  { name: "search", method: "search", args: { query: "ada" }, value: SEARCH },
  { name: "get_entity", method: "getEntity", args: { id: PERSON }, value: ENTITY },
  { name: "get_timeline", method: "getTimeline", args: { id: PERSON }, value: TIMELINE },
  { name: "find_messages", method: "findMessages", args: { sender: "example.com" }, value: MESSAGES },
  { name: "read_message", method: "readMessage", args: { id: MESSAGE_ID }, value: MESSAGE },
  { name: "find_facts", method: "findFacts", args: { type: "transaction" }, value: FACTS },
  { name: "get_commitments", method: "getCommitments", args: { direction: "owed_to_owner" }, value: COMMITMENTS },
  { name: "sync_memory", method: "syncMemory", args: { have: [], canDelete: true }, value: MEMORY },
  { name: "get_evidence_span", method: "getEvidenceSpan", args: { fact: FACT_ID }, value: SPAN },
  { name: "read_item", method: "readItem", args: { message: MESSAGE_ID }, value: THREAD },
  { name: "find_paths", method: "findPaths", args: { target: PERSON }, value: PATHS },
  { name: "get_beliefs", method: "getBeliefs", args: { kind: "commitment", state: "any" }, value: BELIEFS },
  { name: "list_goals", method: "listGoals", args: { status: "any" }, value: GOALS },
  { name: "context", method: "context", args: { task: "prepare the review" }, value: CONTEXT },
  { name: "record_reads", method: "recordReads", args: {}, value: RECORD_READS },
  { name: "list_people", method: "listPeople", args: { tiers: ["close"] }, value: PEOPLE_LIST },
  { name: "about", method: "about", args: { subject: { id: PERSON } }, value: ABOUT },
  { name: "read_record", method: "readRecord", args: { record: RECORD_ID }, value: RECORD_READ },
  { name: "find_records", method: "findRecords", args: { text: "kiln" }, value: RECORD_FIND },
  { name: "get_open_items", method: "getOpenItems", args: {}, value: OPEN_ITEMS },
  { name: "get_changes", method: "getChanges", args: {}, value: CHANGES },
] as const;

// A client registered for every tool in the table of calls.
export const CLIENT = ClientView.parse({
  id: `cli_${ulid(1)}`,
  name: "test-client",
  compartments: ["own"],
  views: ["self", "people", "work"],
  tools: TOOL_CALLS.map((tool) => tool.name),
});

// How each code a read can answer is sent: the error table.
export const SENT: Record<PersonalToolError, unknown> = {
  unauthorized: rpcError(1, -32001, "unauthorized"),
  unavailable: rpcError(1, -32603, "unavailable"),
  not_permitted: toolError(1, "not_permitted"),
  invalid_request: toolError(1, "invalid_request"),
  not_found: toolError(1, "not_found"),
  // A read past one of the client's budgets answers it too (quota.test.ts).
  rate_limited: toolError(1, "rate_limited"),
  // sync_mirror's two, refused as tool results.
  stale_cursor: toolError(1, "stale_cursor"),
  unsupported_template: toolError(1, "unsupported_template"),
  // propose_task's and hand_off's role no active agent holds.
  unknown_role: toolError(1, "unknown_role"),
};

// One request per method, and one per tool.
export const NOT_CALLS = [
  request("initialize", { protocolVersion: "2025-06-18" }),
  request("tools/list"),
  request("resources/list"),
];
export const EVERY_REQUEST = [...NOT_CALLS, ...TOOL_CALLS.map((tool) => call(tool.name, tool.args))];

// The tools' helpers.
export const READ_METHODS: readonly string[] = TOOL_CALLS.map((tool) => tool.method);
// What the endpoint asked of the provider besides who the client is.
export const beyondClient = (calls: Call[]): Call[] => calls.filter((made) => made.method !== "client");
// The token and the tool's name: no code, and no argument of the call.
export const refusedCall = (name: string): Call => ({ method: "refused", args: [TOKEN, name] });
export const clientWith = (over: { tools?: string[]; views?: string[] }): Partial<PersonalReads & PersonalWrites> => ({
  client: async () => ClientView.parse({ ...CLIENT, ...over }),
});
export const listed = async (
  reads: PersonalReads & PersonalWrites,
  params?: unknown,
): Promise<{ name: string; description: string; inputSchema: Record<string, unknown> }[]> => {
  const reply = await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, request("tools/list", params));
  return (reply as { result: { tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] } })
    .result.tools;
};
