import {
  AboutView,
  AgentRecordAck,
  AgentRecordArgs,
  AnswerOwnerQuestionAck,
  AnswerOwnerQuestionArgs,
  BeliefList,
  ClientRegistration,
  ClientView,
  CloseCommitmentAck,
  CloseCommitmentArgs,
  CommitmentList,
  ContextPack,
  ContextView,
  DECISION_DETAILS,
  DocumentList,
  DocumentView,
  DraftMessageArgs,
  DraftMessageResult,
  EntityId,
  EntityView,
  EvidenceSpan,
  FactList,
  FINGERPRINT_PATHS,
  GoalList,
  HANDLE_KINDS,
  Handle,
  IdMode,
  ImportMemoryAck,
  LedgerRef,
  MemoryEntry,
  MemoryProjection,
  MessageList,
  MessageView,
  MirrorPage,
  NotBuiltResult,
  OwnerDecisionKind,
  PathList,
  PeopleList,
  PersonalRef,
  PersonalRunTool,
  PersonalTool,
  PersonalToolArgs,
  PersonalWorkArgs,
  PersonalWorkResults,
  PersonalWorkTool,
  ProposeAboutYouAck,
  ProposeAboutYouArgs,
  ProposePersonAck,
  ProposePersonArgs,
  PushCaptureAck,
  RecordFind,
  RecordRead,
  RecordReads,
  ReopenCommitmentAck,
  ReopenCommitmentArgs,
  ResearchAnswer,
  ResearchArgs,
  SearchResult,
  SelfView,
  SuggestionList,
  TemplateView,
  ThreadView,
  TimelineView,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { OpenItems } from "./open-items.ts";
import { ChangesView } from "./signals.ts";

// One-time handles, the id mode and the owner's address declaration. Made-up values only.

type Parser = { safeParse(value: unknown): { success: boolean } };
const accepts = (schema: Parser, value: unknown): boolean => schema.safeParse(value).success;

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const HANDLE = "hdl_9ZYXWVTSRQPNMKJHGFEDCBA876";
const at = "2026-03-04T10:00:00Z";
// A warmth line, which names no stored row.
const warmth = {
  tier: "close",
  tierSource: "inferred",
  dormant: false,
  warmth: 2.5,
  active: 2.5,
  depth: 3,
  firstTwoWayAt: at,
  lastTwoWayAt: at,
  replyRate: 0.75,
  replyHours: 6,
  theyStart: 0.5,
  channels: ["email"],
  stale: false,
  rebuilding: false,
} as const;
const hex = (char: string): string => char.repeat(64);
const [ent, msg, evt, rec, gol, hyp, tst, opp, mov, itn, run, drf, doc, wrq, prp, rsq, pag] = [
  "ent",
  "msg",
  "evt",
  "rec",
  "gol",
  "hyp",
  "tst",
  "opp",
  "mov",
  "itn",
  "run",
  "drf",
  "doc",
  "wrq",
  "prp",
  "rsq",
  "pag",
].map((prefix) => `${prefix}_${ULID}`) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

// A walk over a plain value: every string outside an UntrustedString, with its path.
type Path = (string | number)[];
const isUntrusted = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  typeof (value as { untrusted?: unknown }).untrusted === "string";
function strings(value: unknown, path: Path = []): [Path, string][] {
  if (typeof value === "string") return [[path, value]];
  if (typeof value !== "object" || value === null || isUntrusted(value)) return [];
  return Object.entries(value).flatMap(([key, one]) =>
    strings(one, [...path, Array.isArray(value) ? Number(key) : key]),
  );
}
const general = (path: Path): string => path.map((step) => (typeof step === "number" ? "*" : step)).join(".");
function replaced(value: unknown, path: Path, by: string): unknown {
  if (path.length === 0) return by;
  const [step, ...rest] = path as [string | number, ...Path];
  if (Array.isArray(value)) return value.map((one, i) => (i === step ? replaced(one, rest, by) : one));
  return {
    ...(value as Record<string, unknown>),
    [step]: replaced((value as Record<string, unknown>)[step], rest, by),
  };
}

const ROW_ID = /^[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}$/;
const HEX64 = /^[0-9a-f]{64}$/;
// Another kind's id, and a handle of the wrong form: neither is the field's id nor a handle.
const otherKind = (id: string): string => (id.startsWith("ent_") ? `msg_${id.slice(4)}` : `ent_${id.slice(4)}`);
const badHandle = `hdl_${ULID.toLowerCase()}`;

// Arguments: every field that names a stored row filled.
const refs = [
  { kind: "message", id: msg },
  { kind: "event", id: evt },
  { kind: "entity", id: ent },
];
const [amg, imp] = [`amg_${ULID}`, `imp_${ULID}`];
const basis = [...refs, { kind: "goal", id: gol }, { kind: "hypothesis", id: hyp }, { kind: "opportunity", id: opp }];
const requestId = "req-0001";
const step = {
  kind: "model_call",
  promptId: "personal_run",
  promptVersion: "1",
  modelId: "model-a",
  costMicroUsd: 120,
};
const output = {
  actions: [
    { do: "remind", about: { kind: "message", id: msg }, dueAt: at, summary: "Reply.", basis },
    { do: "investigate", kind: "open_loop", about: { kind: "event", id: evt }, summary: "Check.", basis },
    { do: "propose", kind: "follow_up", about: { kind: "goal", id: gol }, summary: "Follow up.", basis },
  ],
};
const ARGS: [string, Parser, unknown][] = [
  ["get_entity", PersonalToolArgs.get_entity, { id: ent }],
  ["get_timeline", PersonalToolArgs.get_timeline, { id: ent, from: at, limit: 10 }],
  ["find_messages", PersonalToolArgs.find_messages, { entity: ent, category: "primary" }],
  ["read_message", PersonalToolArgs.read_message, { id: msg, offset: 0 }],
  ["find_facts", PersonalToolArgs.find_facts, { type: "commitment", entity: ent }],
  ["build_context_pack", PersonalToolArgs.build_context_pack, { purpose: "meeting_prep", event: evt }],
  ["get_commitments", PersonalToolArgs.get_commitments, { with: ent, state: "open" }],
  ["record", AgentRecordArgs, { kind: "note", body: "A note.", cites: [msg, evt], requestId }],
  ["claim_opportunity", PersonalWorkArgs.claim_opportunity, { id: opp, requestId }],
  ["release_opportunity", PersonalWorkArgs.release_opportunity, { id: opp, requestId }],
  [
    "propose_hypothesis",
    PersonalWorkArgs.propose_hypothesis,
    { kind: "open_loop", about: { kind: "entity", id: ent }, summary: "Open.", basis, requestId },
  ],
  ["record_test", PersonalWorkArgs.record_test, { hypothesis: hyp, result: "supports", basis, requestId }],
  [
    "propose_opportunity",
    PersonalWorkArgs.propose_opportunity,
    {
      kind: "follow_up",
      about: { kind: "goal", id: gol },
      summary: "Follow up.",
      basis,
      hypothesis: hyp,
      dueAt: at,
      requestId,
    },
  ],
  ["plan_move", PersonalWorkArgs.plan_move, { opportunity: opp, stage: "draft", requestId }],
  ["report_move", PersonalWorkArgs.report_move, { move: mov, outcome: "done", summary: "Done.", basis, requestId }],
  ["set_intention", PersonalWorkArgs.set_intention, { opportunity: opp, kind: "check_back", dueAt: at, requestId }],
  [
    "propose_task",
    PersonalWorkArgs.propose_task,
    {
      kind: "investigate",
      about: { kind: "entity", id: ent },
      summary: "Look.",
      basis,
      hypothesis: hyp,
      dueAt: at,
      requestId,
    },
  ],
  ["hand_off", PersonalWorkArgs.hand_off, { id: opp, role: "research", reason: "other_role", requestId }],
  [
    "post_agent_message",
    PersonalWorkArgs.post_agent_message,
    { replyTo: amg, kind: "answer", body: "Fixed.", requestId },
  ],
  ["read_agent_inbox", PersonalWorkArgs.read_agent_inbox, { scope: "thread", thread: amg }],
  ["list_improvements", PersonalWorkArgs.list_improvements, { improvement: imp }],
  [
    "update_improvement",
    PersonalWorkArgs.update_improvement,
    { improvement: imp, status: "duplicate", duplicateOf: `imp_${"1".repeat(26)}`, requestId },
  ],
  ["append_step", PersonalWorkArgs.append_step, { run, ordinal: 0, step }],
  ["finish_run", PersonalWorkArgs.finish_run, { run, outcome: "finished", output, requestId }],
  ["draft_message", DraftMessageArgs, { opportunity: opp, replyTo: msg, body: "Thanks.", basis: refs, requestId }],
  ["find_documents", PersonalToolArgs.find_documents, { entity: ent, kind: "doc" }],
  ["get_document", PersonalToolArgs.get_document, { id: doc, offset: 0 }],
  ["fetch_template", PersonalToolArgs.fetch_template, { document: doc, offset: 0 }],
  // The evidence and path reads and the research tool.
  ["read_item", PersonalToolArgs.read_item, { message: msg, from: 0 }],
  ["find_paths", PersonalToolArgs.find_paths, { target: ent, maxHops: 2 }],
  ["get_beliefs", PersonalToolArgs.get_beliefs, { kind: "commitment", entity: ent, state: "any" }],
  ["context", PersonalToolArgs.context, { task: "prepare for the review", entity: ent, event: evt }],
  ["record_reads", PersonalToolArgs.record_reads, { record: rec }],
  ["about", PersonalToolArgs.about, { subject: { id: ent }, areas: ["work"] }],
  [
    "propose_about_you",
    ProposeAboutYouArgs,
    {
      kind: "goal",
      fields: { domain: "career", objective: "Ship the review." },
      scope: "all",
      cites: [msg, evt],
      requestId,
    },
  ],
  [
    "propose_person",
    ProposePersonArgs,
    {
      kind: "relationship",
      fields: { person: ent, relation: "friend", closeness: "inner" },
      basis: "He said so.",
      cites: [msg, evt],
      requestId,
    },
  ],
  [
    "propose_person",
    ProposePersonArgs,
    {
      kind: "link",
      fields: { from: ent, kind: "introduced", to: "ent_11111111111111111111111111", inferred: false },
      basis: "The intro mail.",
      requestId,
    },
  ],
  [
    "answer_owner_question",
    AnswerOwnerQuestionArgs,
    { opportunity: opp, answer: { quote: "I want to ship the review." }, requestId },
  ],
  ["close_commitment", CloseCommitmentArgs, { commitment: "a".repeat(64), ending: "done", evidence: [msg], requestId }],
  ["reopen_commitment", ReopenCommitmentArgs, { close: rec }],
  [
    "request_research",
    ResearchArgs,
    {
      kind: "search",
      requestId,
      template: "organization_profile",
      identifiers: [{ kind: "organization_name", value: "Example Org" }],
      about: ent,
    },
  ],
  ["request_research", ResearchArgs, { kind: "link", requestId, message: msg, url: "https://example.com/about" }],
];

// Results: every field that holds a row id, a claim id or a fingerprint filled, and every member
// of every union present.
const who = {
  id: ent,
  kind: "person",
  name: { untrusted: "Alex Example" },
  address: { untrusted: "alex@example.com" },
};
const meeting = {
  id: evt,
  title: { untrusted: "Review" },
  startsAt: at,
  endsAt: at,
  allDay: false,
  cancelled: false,
  participants: [who],
  response: "accepted",
};
const contact = { ...who, emails30d: 1, emails90d: 2, meetings90d: 1 };
const docSummary = {
  id: doc,
  title: { untrusted: "Plan" },
  kind: "doc",
  modifiedAt: at,
  mine: true,
  owner: null,
  reference: false,
  chars: 120,
  sections: 0,
  unreadable: null,
};
const sender = { address: { untrusted: "alex@example.com" }, name: { untrusted: "Alex Example" } };
const summary = {
  id: msg,
  at,
  direction: "inbound",
  bulk: false,
  category: "primary",
  subject: { untrusted: "Notes" },
  sender,
  chars: 120,
  attachments: 0,
};
const opened = {
  ...summary,
  thread: { untrusted: "thread-1" },
  text: { untrusted: "Hello" },
  offset: 0,
  more: false,
  unreadable: false,
  attachmentList: [],
  link: "https://mail.google.com/mail/u/0/#all/18c0ffee30",
};
const fact = {
  subject: who,
  statedBy: who,
  basis: "third_party",
  statementKind: "stated_fact",
  at,
  message: msg,
  document: null,
  passage: null,
  page: null,
  capture: null,
  segment: null,
  thirdParty: true,
  agentReported: false,
  provenance: "source",
  status: "active",
};
const facts = [
  {
    ...fact,
    id: hex("1"),
    type: "transaction.receipt",
    fields: { merchant: { untrusted: "Shop" }, amount: 12, currency: "USD", date: "2026-03-04" },
  },
  {
    ...fact,
    id: hex("2"),
    type: "commitment",
    fields: { counterparty: who, what: { untrusted: "Send the deck." }, due: "2026-03-20" },
  },
  {
    ...fact,
    id: hex("3"),
    type: "plan",
    fields: { counterparty: who, what: { untrusted: "Lunch." }, when: "2026-03-21" },
  },
  {
    ...fact,
    id: hex("4"),
    message: null,
    document: doc,
    passage: { start: 0, end: 5 },
    type: "plan",
    fields: { counterparty: who, what: { untrusted: "Review." }, when: "2026-03-22" },
  },
  {
    ...fact,
    id: hex("7"),
    message: null,
    page: { id: pag, url: { untrusted: "https://example.com/about" }, fetchedAt: at },
    type: "plan",
    fields: { counterparty: who, what: { untrusted: "Visit." }, when: "2026-03-23" },
  },
];
const belief = {
  fact: hex("a"),
  state: hex("b"),
  group: hex("9"),
  kind: "commitment",
  type: "commitment",
  status: "active",
  disputed: false,
  provenance: "source",
  confirmedAt: at,
  reviewAfter: null,
};
const heldCite = { held: true, fact: hex("8"), type: "commitment", at };
const line = {
  fact: hex("d"),
  kind: "goal",
  domain: "career",
  line: { untrusted: "Goal: Ship the review" },
  tier: "owner",
  status: "active",
  since: at,
  at,
  cites: 1,
};
const compiledBelief = {
  ...belief,
  subject: who,
  values: { counterparty: who, due: "2026-03-20" },
  cites: [facts[1], heldCite],
};
const commitment = {
  belief,
  direction: "owed_to_owner",
  counterparty: who,
  due: "2026-03-20",
  what: { untrusted: "Send the deck." },
  message: msg,
  capture: null,
  segment: null,
};
const record = {
  id: rec,
  kind: "handoff",
  client: "claude-code",
  at,
  body: { untrusted: "Left off here." },
  chars: 14,
  cut: false,
  removed: false,
};
const item = { required: false, provenance: "source", asOf: at };
const next = {
  moves: [
    {
      kind: "due_soon",
      what: { untrusted: "Order the firebricks" },
      why: "Due tomorrow.",
      at: "2026-11-05",
      source: { kind: "plan", id: "a".repeat(64) },
    },
    {
      kind: "reply",
      what: { untrusted: "Re: firebricks" },
      why: "A task looked.",
      at,
      source: { kind: "message", id: msg },
      task: opp,
    },
  ],
  more: false,
};
const openItems = {
  items: [
    {
      what: { untrusted: "Order the firebricks" },
      due: "2026-11-05",
      source: { kind: "next_step", id: "a".repeat(64), record: rec },
      whoActs: { id: ent, kind: "owner", name: null, address: null },
      project: null,
      overdue: false,
      lateDays: null,
    },
  ],
  more: false,
};
const pack = {
  purpose: "meeting_prep",
  template: "meeting_prep@1",
  asOf: at,
  items: [
    { ...item, id: "address:0", section: "owner", kind: "address", value: { untrusted: "owner@example.com" } },
    { ...item, id: evt, section: "event", kind: "meeting", meeting, cut: false },
    { ...item, id: ent, section: "contacts", kind: "contact", contact },
    {
      ...item,
      id: ent,
      section: "attendees",
      kind: "attendee",
      attendee: { who, inbound: 1, outbound: 1, lastAt: at, lastMeetingAt: at },
    },
    { ...item, id: msg, section: "recent_messages", kind: "message", message: summary },
    { ...item, id: rec, section: "handoff", kind: "record", record },
    { ...item, id: belief.fact, section: "commitments", kind: "commitment", commitment },
    { ...item, id: "a".repeat(64), section: "open_items", kind: "open_item", openItem: openItems.items[0] },
    {
      ...item,
      id: rec,
      section: "preferences",
      kind: "preference",
      what: { untrusted: "Short replies." },
      polarity: "likes",
      confirmedAt: at,
    },
    // One of the owner's stated beliefs, its id the belief's fact.
    { ...item, id: belief.fact, section: "owner", kind: "belief", belief: compiledBelief },
    // A person's brief: their lead's next step names a commitment's fact.
    {
      ...item,
      id: ent,
      section: "person",
      kind: "entity",
      entity: {
        id: ent,
        kind: "person",
        lead: {
          tier: null,
          tie: null,
          openCommitments: 1,
          lastContact: null,
          lastThread: null,
          lastMeeting: null,
          role: null,
          organization: null,
          nextStep: { kind: "owed_by_owner", fact: hex("e") },
        },
        names: [],
        addresses: [],
        organization: null,
        people: [],
        mail: { inbound: 0, outbound: 0, firstAt: null, lastAt: null },
        lastMeeting: null,
        nextMeeting: null,
        details: [],
        shared: false,
      },
    },
    {
      ...item,
      id: "second_degree:0",
      section: "second_degree",
      kind: "second_degree",
      line: {
        through: who,
        person: who,
        tie: "intro_offer",
        offer: "offered",
        fact: hex("4"),
        at,
        goal: { id: gol, statement: { untrusted: "Meet her." } },
      },
    },
  ],
  truncated: false,
  hash: hex("c"),
};
const stamp = { projection: `mpr_${"d".repeat(40)}`, fact: hex("e"), state: hex("f") };
const projection = {
  template: "commitments@1",
  asOf: at,
  entries: [
    {
      kind: "commitment",
      section: "commitments",
      stamp,
      status: "active",
      direction: "owed_by_owner",
      counterparty: ent,
      due: null,
    },
  ],
  corrections: [],
  remove: [],
  truncated: false,
  inStep: true,
  hash: hex("0"),
};
const view = {
  id: opp,
  kind: "follow_up",
  status: "go",
  about: { kind: "entity", id: ent },
  summary: { untrusted: "Reply to Alex." },
  basis,
  hypothesis: hyp,
  goal: gol,
  stage: "draft",
  dueAt: at,
  leaseUntil: at,
  tier: "opportunity",
  role: null,
};
const request = {
  id: run,
  attempt: 1,
  source: "daily_sweep",
  anchors: basis,
  goals: [{ id: gol, statement: { untrusted: "Ship the review." } }],
  open: [view],
  closed: [
    { rowKind: "opportunity", kind: "follow_up", about: { kind: "message", id: msg }, closedAt: at, by: "owner" },
  ],
  intentions: [{ id: itn, kind: "check_back", dueAt: at, opportunity: opp }],
  point: { id: "run_outcome", version: 1, promptId: "personal_run", promptVersion: "1" },
  limits: {
    maxTurns: 8,
    maxToolCalls: 20,
    maxOutputTokens: 2000,
    maxInputCodePoints: 200_000,
    ceilingMicroUsdPerToken: 100,
  },
};
const suggestion = { what: "follow_up", status: "open", at, results: [{ kind: "opportunity", id: opp }] };
const RESULTS: Record<PersonalTool, [Parser, unknown]> = {
  get_self: [
    SelfView,
    {
      openItems,
      next,
      addresses: [{ untrusted: "owner@example.com" }],
      timeZone: "Europe/London",
      upcoming: [meeting],
      contacts: [contact],
      changes: [{ kind: "goal", status: "closed", at: "2026-09-30", what: { untrusted: "Ship the thing" } }],
      sections: [{ domain: "career", lines: [line], people: [{ who, claims: 1 }], activeAt: at, more: false }],
      housekeeping: {
        lines: [{ ...line, tier: "system_notice", notice: { from: null, subject: null, sentAt: at } }],
        more: false,
      },
      goals: [],
      applications: [{ state: "stated", what: { untrusted: "Situation: applied" }, at, fact: hex("1") }],
    },
  ],
  // A match mode's claims beside a names search's people.
  search: [
    SearchResult,
    { results: [{ ...who, lastInteractionAt: at }], matches: [{ fact: facts[1], score: 1 }], more: false },
  ],
  get_entity: [
    EntityView,
    {
      openItems,
      id: ent,
      kind: "person",
      lead: {
        tier: null,
        tie: null,
        openCommitments: 1,
        lastContact: null,
        lastThread: null,
        lastMeeting: null,
        role: null,
        organization: null,
        nextStep: { kind: "owed_by_owner", fact: hex("f") },
      },
      mentionedBy: [{ by: who, relation: "colleague", fact: hex("8"), at }],
      names: [],
      addresses: [],
      organization: { ...who, kind: "organization" },
      people: [who],
      mail: { inbound: 1, outbound: 0, firstAt: at, lastAt: at },
      lastMeeting: meeting,
      nextMeeting: meeting,
      details: [],
      shared: false,
      facts: { beliefs: [compiledBelief], claims: [facts[0]], more: false },
      // The card's lines.
      lines: [line],
      // The card's parts, which carry no fingerprint.
      current: {
        role: { title: { untrusted: "Head of Finance" }, organization: null, organizationName: null, since: at },
        affiliation: {
          relation: "employee",
          organization: { ...who, kind: "organization" },
          organizationName: null,
          since: at,
        },
      },
      warmth,
      knownVia: {
        firstThread: { at, message: msg },
        meetings: { count: 1, firstAt: at, first: evt },
        sharedMailDomain: { ...who, kind: "organization" },
        coRecipients: [{ who, messages: 2, lastAt: at, message: msg }],
      },
    },
  ],
  get_timeline: [
    TimelineView,
    {
      entries: [
        { kind: "email", id: msg, at, direction: "inbound", subject: null, thread: { untrusted: msg } },
        { kind: "meeting", at, meeting },
        // A fact about or naming the entity.
        { kind: "fact", at, fact: facts[2] },
      ],
    },
  ],
  find_messages: [MessageList, { messages: [summary], more: false }],
  read_message: [MessageView, opened],
  find_facts: [FactList, { facts, more: false }],
  build_context_pack: [ContextPack, pack],
  get_commitments: [CommitmentList, { commitments: [commitment], more: false }],
  sync_memory: [MemoryProjection, projection],
  record: [AgentRecordAck, { recordId: rec }],
  list_opportunities: [PersonalWorkResults.list_opportunities, { opportunities: [view] }],
  claim_opportunity: [PersonalWorkResults.claim_opportunity, { opportunity: view, leaseUntil: at }],
  release_opportunity: [PersonalWorkResults.release_opportunity, { released: true }],
  propose_hypothesis: [PersonalWorkResults.propose_hypothesis, { hypothesis: hyp }],
  record_test: [PersonalWorkResults.record_test, { test: tst, counts: true }],
  record_spend: [PersonalWorkResults.record_spend, { go: true }],
  start_outcome_test: [PersonalWorkResults.start_outcome_test, { go: false, code: "not_due" }],
  record_held_out_question: [PersonalWorkResults.record_held_out_question, { id: `hoq_${"1".repeat(26)}` }],
  record_outcome_task: [PersonalWorkResults.record_outcome_task, { recorded: true }],
  propose_opportunity: [PersonalWorkResults.propose_opportunity, { opportunity: opp }],
  plan_move: [PersonalWorkResults.plan_move, { move: mov }],
  report_move: [PersonalWorkResults.report_move, { move: mov, opportunity: "done" }],
  set_intention: [PersonalWorkResults.set_intention, { intention: itn }],
  propose_task: [PersonalWorkResults.propose_task, { opportunity: opp, status: "go" }],
  propose_goal: [PersonalWorkResults.propose_goal, { status: "proposed" }],
  propose_goal_target: [PersonalWorkResults.propose_goal_target, { status: "capped" }],
  hand_off: [PersonalWorkResults.hand_off, { handedOff: true }],
  write_back: [PersonalWorkResults.write_back, { state: "handled" }],
  report_wrong_merge: [PersonalWorkResults.report_wrong_merge, { report: `wmr_${"0".repeat(26)}`, state: "filed" }],
  report_wrong_relation: [
    PersonalWorkResults.report_wrong_relation,
    { report: `rrp_${"0".repeat(26)}`, state: "filed" },
  ],
  // A message of a thread, and an improvement with its history.
  post_agent_message: [PersonalWorkResults.post_agent_message, { message: amg, thread: amg }],
  read_agent_inbox: [
    PersonalWorkResults.read_agent_inbox,
    {
      messages: [
        {
          id: amg,
          thread: amg,
          replyTo: null,
          from: "claude-code",
          to: { role: "research" },
          kind: "question",
          subject: { untrusted: "Slow search" },
          body: { untrusted: "Is search slow for you?" },
          sentAt: at,
          mine: false,
          read: false,
        },
      ],
      more: false,
    },
  ],
  submit_improvement: [PersonalWorkResults.submit_improvement, { improvement: imp, merged: true }],
  list_improvements: [
    PersonalWorkResults.list_improvements,
    {
      improvements: [
        {
          id: imp,
          kind: "bug",
          area: "mcp",
          severity: "high",
          status: "duplicate",
          title: { untrusted: "Search times out" },
          detail: { untrusted: "Every search over a year times out." },
          evidence: null,
          by: "claude-code",
          reportedAt: at,
          updatedAt: at,
          reports: 2,
          duplicateOf: imp,
          assigneeRole: "builder",
          cause: null,
          causeState: null,
          heldBy: null,
          heldAt: null,
          fixRef: "pr:12",
          events: [
            {
              at,
              by: "claude-code",
              event: "status",
              status: "duplicate",
              note: { untrusted: "Same as the other." },
              evidence: null,
            },
          ],
        },
      ],
      more: false,
    },
  ],
  update_improvement: [PersonalWorkResults.update_improvement, { improvement: imp, status: "triaged" }],
  get_health: [
    PersonalWorkResults.get_health,
    {
      measures: [
        {
          metric: "mail_to_claim_24h",
          state: "failing",
          value: 0.3,
          sample: 40,
          readAt: at,
          healthy: { test: "at_least", value: 0.4 },
          stale: false,
        },
      ],
      checks: [{ source: "mail", code: "ok", at }],
      jobs: [{ job: "extract", code: "ok", at, failing: false }],
      cards: [],
      defects: [{ role: null, severity: "high", open: 2 }],
    },
  ],
  file_learning: [PersonalWorkResults.file_learning, { learning: `lrn_${ULID}`, merged: true }],
  mark_health_seen: [PersonalWorkResults.mark_health_seen, { card: `crd_${ULID}`, seenAt: at }],
  read_meeting: [
    PersonalWorkResults.read_meeting,
    {
      meeting: `cap_${ULID}`,
      startedAt: at,
      endedAt: at,
      app: { untrusted: "Meet" },
      title: null,
      mode: "call",
      speakers: [],
      organizer: null,
      attendees: [],
      turns: [{ index: 0, speaker: "S1", at, text: { untrusted: "hello" } }],
      notes: null,
      from: 0,
      next: null,
    },
  ],
  get_work_time: [
    PersonalWorkResults.get_work_time,
    {
      from: at,
      to: at,
      credited: [
        {
          project: { id: `ent_${ULID}`, kind: "project", name: { untrusted: "Alpha" }, address: null },
          basis: "agent_anchor",
          minutes: 30,
        },
      ],
      uncredited: [
        {
          place: { kind: "thread", value: { untrusted: "Planning" } },
          app: { untrusted: "test.example.chat" },
          host: null,
          minutes: 20,
          stretches: [{ from: at, to: at }],
          more: false,
        },
      ],
      uncreditedMinutes: 20,
      proposals: [],
      anchors: [{ anchor: `aan_${ULID}`, project: `ent_${ULID}`, kind: "repository", createdAt: at }],
      rulings: [{ ruling: `atr_${ULID}`, project: `ent_${ULID}`, from: at, to: at, proposal: null, createdAt: at }],
      more: false,
    },
  ],
  set_anchor: [PersonalWorkResults.set_anchor, { anchor: `aan_${ULID}` }],
  lift_anchor: [PersonalWorkResults.lift_anchor, { lifted: true }],
  rule_time: [PersonalWorkResults.rule_time, { ruling: `atr_${ULID}` }],
  lift_time_ruling: [PersonalWorkResults.lift_time_ruling, { lifted: true }],
  judge_time_proposal: [PersonalWorkResults.judge_time_proposal, { rulings: [`atr_${ULID}`] }],
  list_levers: [
    PersonalWorkResults.list_levers,
    {
      levers: [
        {
          key: "lessons.digest_weekly",
          type: "integer",
          min: 0,
          max: 10,
          allowed: null,
          default: 5,
          value: 3,
          mover: "agent",
          undo: "previous_value",
          measure: "owner_questions_per_week",
          lastChange: { at, by: "you", from: null, to: 3, reason: "tune" },
        },
      ],
    },
  ],
  set_lever: [PersonalWorkResults.set_lever, { key: "lessons.digest_weekly", value: 3 }],
  // A relayed answer: the card, and that it was attached and not applied.
  relay_card_answer: [
    PersonalWorkResults.relay_card_answer,
    { card: "crd_01J8ZQ0000000000000000000A", applied: false },
  ],
  // A project, where it stands, and one whole with its work.
  propose_project: [PersonalWorkResults.propose_project, { project: ent }],
  update_project: [
    PersonalWorkResults.update_project,
    {
      project: ent,
      status: { value: "blocked", asOf: at, by: { kind: "agent", client: "claude-code" } },
      record: rec,
      refused: [{ field: "name", code: "owner_set" }],
    },
  ],
  // An idea another agent filed, with its newest evidence.
  list_ideas: [
    PersonalWorkResults.list_ideas,
    {
      ideas: [
        {
          id: "hyp_01J8ZQ0000000000000000000A",
          idea: { untrusted: "A shared calendar for the club." },
          filedBy: "agent",
          filedAt: at,
          latestAt: at,
          status: "open",
          evidence: [
            { kind: "message", at },
            { kind: "event", at: null },
          ],
          cited: 2,
        },
      ],
    },
  ],
  list_projects: [
    PersonalWorkResults.list_projects,
    {
      projects: [
        {
          id: ent,
          name: { untrusted: "Orchard" },
          status: {
            value: "active",
            asOf: at,
            by: { kind: "source", who: null },
            disputedBy: [{ value: "blocked", asOf: at, by: { kind: "agent", client: "claude-code" } }],
          },
          ownerRole: "research",
          goal: gol,
          dueAt: null,
          createdAt: at,
          updatedAt: at,
          createdBy: "claude-code",
          area: { key: "field-work", name: { untrusted: "Field work" }, retired: false },
        },
      ],
      areas: [
        { key: "field-work", name: { untrusted: "Field work" }, retired: false },
        { key: "old-yard", name: { untrusted: "The old yard" }, retired: true },
      ],
    },
  ],
  get_project: [
    PersonalWorkResults.get_project,
    {
      id: ent,
      name: { untrusted: "Orchard" },
      status: { value: "closed", asOf: at, by: { kind: "owner" } },
      ownerRole: null,
      goal: null,
      dueAt: at,
      createdAt: at,
      updatedAt: at,
      createdBy: "owner",
      area: null,
      work: [
        {
          ...view,
          project: ent,
          parent: opp,
          blockedBy: [opp],
          holder: "claude-code",
          progress: {
            done: [{ untrusted: "Read the thread." }],
            next: { untrusted: "Write the brief." },
            waitingOn: null,
            resumeAt: null,
            at,
            by: "claude-code",
          },
        },
      ],
      nextSteps: [
        { what: { untrusted: "Order the trees." }, at, by: { kind: "agent", client: "claude-code" }, record: rec },
      ],
      decisions: [{ what: { untrusted: "Plant in March." }, at, by: { kind: "owner" } }],
      changes: [
        { kind: "status", at, value: "closed", by: { kind: "owner" } },
        { kind: "field", at, field: "name", by: "agent" },
        { kind: "work", at, opportunity: opp, event: "claimed" },
      ],
      more: false,
    },
  ],
  next_run: [PersonalWorkResults.next_run, { run: request }],
  append_step: [PersonalWorkResults.append_step, { go: true }],
  finish_run: [PersonalWorkResults.finish_run, { recorded: 1, outcome: "finished" }],
  draft_message: [DraftMessageResult, { draft: drf }],
  find_documents: [DocumentList, { documents: [docSummary], more: false, scanned: false }],
  get_document: [DocumentView, { ...docSummary, outline: [], text: null, offset: 0, more: false, link: null }],
  get_evidence_span: [
    EvidenceSpan,
    {
      fact: hex("5"),
      source: { kind: "message", id: msg },
      passage: { untrusted: "Send the deck." },
      chars: 14,
      cut: false,
    },
  ],
  read_item: [
    ThreadView,
    {
      thread: { untrusted: "thread-1" },
      messages: [{ summary, text: { untrusted: "Hello" }, offset: 0, cut: false }],
      next: null,
    },
  ],
  get_decision_history: [NotBuiltResult, undefined],
  get_beliefs: [BeliefList, { beliefs: [compiledBelief], more: false }],
  // A goal the owner only stated, by its fact key, marked stale.
  list_goals: [
    GoalList,
    {
      goals: [
        { id: gol, statement: { untrusted: "Ship the review." }, status: "active", setAt: at },
        { id: hex("f"), statement: { untrusted: "Plant an orchard." }, status: "active", setAt: at, stale: true },
        {
          id: gol,
          statement: { untrusted: "Run a half marathon." },
          status: "active",
          setAt: at,
          disputed: true,
          reversal: hex("e"),
        },
      ],
      more: false,
    },
  ],
  context: [
    ContextView,
    {
      openItems,
      next,
      domains: ["career"],
      sections: [{ domain: "career", lines: [line], people: [{ who, claims: 1 }], activeAt: at, more: false }],
      people: [
        {
          who,
          warmth,
          lastAt: at,
          nextMeeting: meeting,
          nextStep: { kind: "owed_by_owner", fact: hex("f") },
          lines: [{ ...line, fact: hex("e") }],
          more: false,
        },
      ],
      commitments: [commitment],
      goals: [{ id: gol, statement: { untrusted: "Ship the review." }, status: "active", setAt: at }],
      evidence: [
        {
          fact: hex("d"),
          claim: hex("f"),
          source: { kind: "message", id: msg },
          passage: { untrusted: "Ship the review." },
          cut: false,
        },
      ],
      more: false,
    },
  ],
  // A record of the caller's own, the record that superseded it, and one reader.
  record_reads: [
    RecordReads,
    {
      records: [
        {
          record: rec,
          kind: "note",
          recordedAt: at,
          supersededBy: rec,
          erased: false,
          readers: [{ client: "claude-code", firstAt: at, lastAt: at, count: 1 }],
        },
      ],
      more: false,
    },
  ],
  read_record: [
    RecordRead,
    {
      id: rec,
      kind: "finding",
      client: "claude-code",
      at,
      body: { untrusted: "The kiln takes grade 23 firebrick." },
      chars: 33,
      cut: false,
      removed: false,
      project: ent,
    },
  ],
  get_open_items: [OpenItems, openItems],
  get_changes: [
    ChangesView,
    {
      changes: [
        {
          change: "signal",
          key: `sig_${"a".repeat(32)}`,
          kind: "gap",
          at,
          what: null,
          why: "A gap in what is known: no_warm_path.",
          source: { kind: "commitment", id: "a".repeat(64) },
        },
      ],
      cursor: null,
      more: false,
    },
  ],
  find_records: [
    RecordFind,
    {
      records: [
        {
          id: rec,
          kind: "note",
          client: "claude-code",
          at,
          body: { untrusted: "Kiln." },
          chars: 5,
          cut: false,
          removed: false,
        },
      ],
      more: false,
    },
  ],
  // One person of the caller's audience, by tier.
  list_people: [
    PeopleList,
    {
      people: [{ id: ent, name: { untrusted: "Ada" }, address: { untrusted: "ada@example.com" }, warmth }],
      next: "1",
      rebuilding: false,
    },
  ],
  // A belief with one cited claim, a claim in no belief and a commitment.
  about: [
    AboutView,
    {
      subject: { id: ent, kind: "person", name: { untrusted: "Alex Example" } },
      candidates: [],
      beliefs: [
        {
          kind: "commitment",
          factKey: hex("1"),
          value: { counterparty: ent },
          status: "active",
          tier: "source",
          provenance: "source",
          disputed: false,
          settledBy: null,
          independentSources: 1,
          canonical: hex("3"),
          support: [{ fact: hex("3"), speaker: ent, at, span: { start: 0, end: 4 }, tier: "source" }],
          supportCount: 1,
          relations: [{ id: "12", from: hex("3"), to: hex("5"), kind: "supersedes", judge: "rule:reversal" }],
          asOf: at,
        },
      ],
      claims: [
        {
          fact: hex("7"),
          speaker: null,
          at,
          span: null,
          tier: "source",
          type: "plan",
          fields: { what: { untrusted: "the review" } },
        },
      ],
      claimCount: 1,
      commitments: [{ factKey: hex("1"), direction: "owed_to_owner" }],
      toOwner: null,
      connections: [],
      links: [],
      knownVia: {
        firstThread: { at, message: msg },
        meetings: { count: 1, firstAt: at, first: evt },
        sharedMailDomain: null,
        coRecipients: [],
      },
      mail: { inbound: 1, outbound: 1, firstAt: at, lastAt: at },
      lastMeeting: meeting,
      nextMeeting: null,
      warmth,
      asOf: at,
      next: null,
    },
  ],
  find_paths: [
    PathList,
    {
      paths: [
        {
          score: 1,
          hops: [{ from: who, to: { ...who, kind: "organization" }, via: "affiliation", facts: [hex("6")] }],
        },
      ],
      cut: false,
    },
  ],
  fetch_template: [
    TemplateView,
    {
      document: docSummary,
      text: { untrusted: "For {{name:text}}." },
      offset: 0,
      more: false,
      placeholders: [{ ordinal: 0, name: { untrusted: "name" }, kind: { untrusted: "text" } }],
    },
  ],
  get_suggestions: [
    SuggestionList,
    {
      items: [
        { ...suggestion, ref: { kind: "work_request", id: wrq } },
        { ...suggestion, ref: { kind: "proposal", id: prp } },
        { ...suggestion, ref: { kind: "opportunity", id: opp } },
        { ...suggestion, ref: { kind: "hypothesis", id: hyp } },
      ],
      more: false,
    },
  ],
  propose_about_you: [ProposeAboutYouAck, { recordId: rec }],
  propose_person: [ProposePersonAck, { recordId: rec }],
  answer_owner_question: [AnswerOwnerQuestionAck, { recordId: rec }],
  close_commitment: [CloseCommitmentAck, { close: rec, effective: "next_build" }],
  reopen_commitment: [ReopenCommitmentAck, { close: rec, effective: "next_build" }],
  import_memory: [ImportMemoryAck, { received: 1 }],
  request_research: [ResearchAnswer, { request: rsq, state: "pending" }],
  // Lens: a push's ack holds keys Lens made, and a mirror page every section's member.
  push_capture: [
    PushCaptureAck,
    {
      items: [
        { key: `meeting:${ULID}`, outcome: "accepted" },
        { key: `moment:${ULID}`, outcome: "refused", code: "out_of_scope" },
      ],
    },
  ],
  sync_mirror: [
    MirrorPage,
    {
      template: "lens_mirror@1",
      pass: 1,
      removals: [{ projection: `mir_${"c".repeat(40)}`, reason: "withdrawn", at }],
      captureErased: [`meeting:${ULID}`],
      entries: [
        {
          section: "entities",
          stamp: { projection: `mir_${"d".repeat(40)}`, fact: null, state: hex("e") },
          entity: {
            id: ent,
            kind: "person",
            names: [],
            addresses: [],
            organization: null,
            people: [],
            details: [],
            shared: false,
          },
        },
        {
          section: "entities",
          stamp: { projection: `mir_${"d".repeat(40)}`, fact: null, state: hex("e") },
          entity: {
            id: ent,
            kind: "project",
            names: [],
            addresses: [],
            organization: null,
            people: [],
            details: [],
            shared: false,
            status: "active",
            anchors: [{ id: `pan_${ULID}`, kind: "host", value: { untrusted: "plans.example.com" } }],
          },
        },
        // lens_mirror@1 carries no group, as it carries no tier.
        {
          section: "beliefs",
          stamp: { projection: `mir_${"d".repeat(40)}`, fact: hex("f"), state: hex("e") },
          belief: { ...compiledBelief, group: undefined },
        },
        {
          section: "facts",
          stamp: { projection: `mir_${"d".repeat(40)}`, fact: hex("f"), state: hex("e") },
          fact: facts[0],
        },
        {
          section: "events",
          stamp: { projection: `mir_${"d".repeat(40)}`, fact: null, state: hex("e") },
          event: meeting,
        },
        {
          section: "captures",
          stamp: { projection: `mir_${"d".repeat(40)}`, fact: null, state: hex("e") },
          capture: {
            capture: `cap_${ULID}`,
            key: `meeting:${ULID}`,
            revision: 0,
            kind: "meeting",
            startedAt: at,
            endedAt: at,
            event: evt,
          },
        },
      ],
      cursor: `mcr_${ULID}`,
      more: false,
      passComplete: true,
      truncated: false,
      hash: hex("a"),
    },
  ],
};
// A tool whose result a later step gives parses nothing yet (tools.ts, NotBuiltResult).
const built = ([schema]: [Parser, unknown]): boolean => schema !== NotBuiltResult;

const UNTRANSLATED: Partial<Record<PersonalTool, string[]>> = {
  build_context_pack: ["hash"],
  sync_memory: ["entries.*.stamp.fact", "entries.*.stamp.state", "hash"],
  // Lens: the mirror client's ids are stable, so nothing in a page is translated.
  sync_mirror: [
    "entries.*.stamp.fact",
    "entries.*.stamp.state",
    "entries.*.belief.fact",
    "entries.*.belief.state",
    "entries.*.belief.cites.*.id",
    "entries.*.belief.cites.*.fact",
    "entries.*.fact.id",
    "hash",
  ],
};

describe("handles, the id mode and owner_address", () => {
  it("a handle has the hdl_ form and no other", () => {
    expect(accepts(Handle, HANDLE)).toBe(true);
    expect(accepts(Handle, `hdl_${ULID}`)).toBe(true);
    for (const bad of [
      badHandle,
      `HDL_${ULID}`,
      `hdl_${ULID.slice(1)}`,
      `hdl_${ULID}0`,
      `hdl_${ULID.slice(1)}I`,
      `hdl_${ULID.slice(1)}L`,
      `hdl_${ULID.slice(1)}O`,
      `hdl_${ULID.slice(1)}U`,
      `hdl-${ULID}`,
      ` hdl_${ULID}`,
      ent,
      hex("a"),
    ]) {
      expect(accepts(Handle, bad), bad).toBe(false);
    }
  });

  it("a handle is not an EntityId, and an EntityId is not a handle", () => {
    expect(accepts(EntityId, HANDLE)).toBe(false);
    expect(accepts(Handle, ent)).toBe(false);
    const handle = Handle.parse(HANDLE);
    const entity = EntityId.parse(ent);
    // @ts-expect-error a handle is branded PersonalHandle, not EntityId
    const asEntity: EntityId = handle;
    // @ts-expect-error an EntityId is not a handle
    const asHandle: Handle = entity;
    expect([asEntity, asHandle]).toEqual([HANDLE, ent]);
  });

  it("a registration without idMode parses", () => {
    const registration = {
      name: "claude-code",
      runtime: "local",
      vendorRetention: "unknown",
      compartments: ["own"],
      views: ["self"],
      tools: ["get_self"],
    };
    expect(accepts(ClientRegistration, registration)).toBe(true);
    expect(accepts(ClientRegistration, { ...registration, idMode: "stable" })).toBe(true);
    expect(accepts(ClientRegistration, { ...registration, idMode: "session" })).toBe(true);
    expect(accepts(ClientRegistration, { ...registration, idMode: "daily" })).toBe(false);
    expect(IdMode.options).toEqual(["stable", "session"]);
  });

  it("owner_address details are strict", () => {
    expect(OwnerDecisionKind.options).toContain("owner_address");
    const details = DECISION_DETAILS.owner_address;
    if (details === undefined) throw new Error("owner_address has no details schema");
    expect(accepts(details, { addressFp: hex("a") })).toBe(true);
    expect(accepts(details, {})).toBe(false);
    expect(accepts(details, { addressFp: hex("a"), address: "owner@example.com" })).toBe(false);
    expect(accepts(details, { addressFp: "owner@example.com" })).toBe(false);
    expect(accepts(details, { addressFp: hex("A") })).toBe(false);
    expect(accepts(details, { addressFp: hex("a").slice(1) })).toBe(false);
  });

  it("an owner shape takes no handle: a ledger ref and a personal ref refuse one", () => {
    expect(accepts(LedgerRef, { kind: "opportunity", id: opp })).toBe(true);
    expect(accepts(LedgerRef, { kind: "opportunity", id: HANDLE })).toBe(false);
    expect(accepts(PersonalRef, { kind: "message", id: msg })).toBe(true);
    expect(accepts(PersonalRef, { kind: "message", id: HANDLE })).toBe(false);
  });

  it("ClientView still has exactly five fields", () => {
    expect(Object.keys(ClientView.shape)).toEqual(["id", "name", "compartments", "views", "tools"]);
  });

  it("HANDLE_KINDS is the expected list, frozen", () => {
    expect(HANDLE_KINDS).toEqual([
      "entity",
      "message",
      "event",
      "record",
      "goal",
      "hypothesis",
      "test",
      "opportunity",
      "move",
      "intention",
      "run",
      "draft",
      "assignment",
      "document",
      "claim",
      "fact",
      "state",
      "capture",
      "group",
    ]);
    expect(Object.isFrozen(HANDLE_KINDS)).toBe(true);
  });
});

// The work and run tools are held to neither rule below: work.ts's shapes take a row's id alone,
// since no handle is issued for one, and the shapes other files give those tools still take one.
const WORK_TOOLS = new Set<string>([...PersonalWorkTool.options, ...PersonalRunTool.options]);
// A read tool's result that holds a work.ts shape holds its ids alone there.
const WORK_SHAPES: Partial<Record<string, string[]>> = { get_suggestions: ["items.*.results.*.id"] };

describe("ids or handles in every tool", () => {
  it("every argument that took an id takes a handle too, but a work tool's", () => {
    for (const [tool, schema, example] of ARGS) {
      expect(accepts(schema, example), tool).toBe(true);
      const ids = strings(example).filter(([, text]) => ROW_ID.test(text));
      expect(ids.length, tool).toBeGreaterThan(0);
      for (const [path, id] of ids) {
        const where = `${tool} ${general(path)}`;
        if (!WORK_TOOLS.has(tool)) expect(accepts(schema, replaced(example, path, HANDLE)), where).toBe(true);
        expect(accepts(schema, replaced(example, path, otherKind(id))), where).toBe(false);
        expect(accepts(schema, replaced(example, path, badHandle)), where).toBe(false);
      }
    }
  });

  it("a work row named to a work tool is named by its id, never a handle", () => {
    const named: [string, Path][] = [
      ["claim_opportunity", ["id"]],
      ["release_opportunity", ["id"]],
      ["hand_off", ["id"]],
      ["plan_move", ["opportunity"]],
      ["report_move", ["move"]],
      ["set_intention", ["opportunity"]],
    ];
    for (const [tool, path] of named) {
      const found = ARGS.find(([name]) => name === tool);
      if (found === undefined) throw new Error(`no arguments for ${tool}`);
      const [, schema, example] = found;
      expect(accepts(schema, example), tool).toBe(true);
      expect(accepts(schema, replaced(example, path, HANDLE)), tool).toBe(false);
    }
  });

  it("every result that held an id holds a handle too, but a work tool's", () => {
    for (const [tool, [schema, example]] of Object.entries(RESULTS).filter(([, result]) => built(result))) {
      expect(accepts(schema, example), tool).toBe(true);
      // The memory adapter's stamps, and the mirror client, whose ids are stable.
      if (tool === "sync_memory" || tool === "sync_mirror" || WORK_TOOLS.has(tool)) continue;
      const fingerprints = Object.keys(FINGERPRINT_PATHS[tool as PersonalTool] ?? {});
      const translated = strings(example).flatMap(([path, text]) =>
        ROW_ID.test(text) || (HEX64.test(text) && fingerprints.includes(general(path))) ? [path] : [],
      );
      for (const path of translated)
        expect(accepts(schema, replaced(example, path, HANDLE)), `${tool} ${general(path)}`).toBe(
          !WORK_SHAPES[tool]?.includes(general(path)),
        );
    }
  });

  it("get_evidence_span takes a claim id or a handle, and nothing else", () => {
    const schema = PersonalToolArgs.get_evidence_span;
    expect(accepts(schema, { fact: hex("1") })).toBe(true);
    expect(accepts(schema, { fact: HANDLE })).toBe(true);
    for (const bad of [ent, badHandle, hex("A")]) expect(accepts(schema, { fact: bad }), bad).toBe(false);
  });

  it("MemoryEntry.counterparty stays EntityId or null", () => {
    const entry = projection.entries[0];
    expect(accepts(MemoryEntry, entry)).toBe(true);
    expect(accepts(MemoryEntry, { ...entry, counterparty: null })).toBe(true);
    expect(accepts(MemoryEntry, { ...entry, counterparty: HANDLE })).toBe(false);
  });

  it("the results above cover every tool", () => {
    expect(Object.keys(RESULTS).sort()).toEqual([...PersonalTool.options].sort());
  });

  it("FINGERPRINT_PATHS names exactly the 64-hexadecimal fields of the result schemas", () => {
    for (const [tool, [, example]] of Object.entries(RESULTS)) {
      const found = new Set(strings(example).flatMap(([path, text]) => (HEX64.test(text) ? [general(path)] : [])));
      const named = Object.keys(FINGERPRINT_PATHS[tool as PersonalTool] ?? {});
      expect([...found].sort(), tool).toEqual([...named, ...(UNTRANSLATED[tool as PersonalTool] ?? [])].sort());
    }
    for (const paths of Object.values(FINGERPRINT_PATHS)) {
      for (const kind of Object.values(paths ?? {})) expect(["claim", "fact", "state", "group"]).toContain(kind);
    }
    expect(Object.isFrozen(FINGERPRINT_PATHS)).toBe(true);
    for (const paths of Object.values(FINGERPRINT_PATHS)) expect(Object.isFrozen(paths)).toBe(true);
  });
});
