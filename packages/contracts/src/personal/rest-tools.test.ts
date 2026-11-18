import {
  AgentRecordArgs,
  AgentRecordKind,
  ClientRegistration,
  DecisionRecordView,
  EvidenceSpan,
  PathList,
  PersonalProposeTool,
  PersonalReadTool,
  PersonalTool,
  PersonalToolArgs,
  ProposalId,
  READ_BUDGET,
  SuggestionList,
  TemplateView,
  ThreadView,
  TOOL_VIEW,
  WatchId,
  WorkRequestId,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// Made-up values only.

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-03-04T10:00:00Z";
const fact = "a".repeat(64);
const message = `msg_${ULID}`;
const entity = `ent_${ULID}`;
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const who = { id: entity, kind: "person", name: { untrusted: "Alex Example" }, address: null };
const NEW_READS = [
  "get_evidence_span",
  "read_item",
  "get_decision_history",
  "find_paths",
  "fetch_template",
  "get_suggestions",
] as const;

describe("tool names, views and ids", () => {
  it("every read tool has a view and a budget", () => {
    for (const tool of NEW_READS) expect(PersonalReadTool.options, tool).toContain(tool);
    for (const tool of PersonalReadTool.options) {
      expect(TOOL_VIEW[tool], tool).toBeDefined();
      expect(READ_BUDGET[tool], tool).toBeDefined();
      expect(PersonalToolArgs[tool], tool).toBeDefined();
    }
    expect(NEW_READS.filter((tool) => READ_BUDGET[tool] === "text")).toEqual([
      "get_evidence_span",
      "read_item",
      "fetch_template",
    ]);
  });

  it("the request and propose names once designed and never served are no tool", () => {
    expect(PersonalProposeTool.options).toEqual(["draft_message"]);
    const registration = {
      name: "helper",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: ["work"],
    };
    expect(accepts(ClientRegistration, { ...registration, tools: ["draft_message"] })).toBe(true);
    for (const tool of [
      "log_decision",
      "request_brief",
      "request_intro_paths",
      "request_campaign",
      "set_intent",
      "watch",
      "unwatch",
    ]) {
      expect(accepts(PersonalTool, tool), tool).toBe(false);
      expect(accepts(ClientRegistration, { ...registration, tools: [tool] }), tool).toBe(false);
    }
  });

  it("a work request id, a proposal id and a watch id refuse each other's prefix", () => {
    const ids = [
      [WorkRequestId, "wrq"],
      [ProposalId, "prp"],
      [WatchId, "wch"],
    ] as const;
    for (const [schema, prefix] of ids) {
      for (const [, other] of ids)
        expect(accepts(schema, `${other}_${ULID}`), `${prefix} takes ${other}`).toBe(other === prefix);
      expect(accepts(schema, `${prefix}_${ULID.toLowerCase()}`), prefix).toBe(false);
    }
  });

  it("TOOL_VIEW gives get_evidence_span, read_item and find_paths people, and the rest work", () => {
    expect(Object.fromEntries(NEW_READS.map((tool) => [tool, TOOL_VIEW[tool]]))).toEqual({
      get_evidence_span: "people",
      read_item: "people",
      get_decision_history: "work",
      find_paths: "people",
      fetch_template: "work",
      get_suggestions: "work",
    });
  });

  it("AgentRecordKind is the kinds record takes: its first three, then lesson and capability", () => {
    expect(AgentRecordKind.options).toEqual(["note", "finding", "handoff", "lesson", "capability"]);
    const record = { kind: "note", body: "a note", requestId: "req-0001" };
    for (const kind of ["note", "finding", "handoff", "lesson", "capability"])
      expect(accepts(AgentRecordArgs, { ...record, kind }), kind).toBe(true);
    // Kinds once designed and never written are no kind.
    for (const kind of ["observation", "action", "decision"])
      expect(accepts(AgentRecordArgs, { ...record, kind }), kind).toBe(false);
  });
});

describe("argument shapes", () => {
  it("find_paths refuses maxHops 5", () => {
    expect(accepts(PersonalToolArgs.find_paths, { target: entity, maxHops: 3 })).toBe(true);
    expect(accepts(PersonalToolArgs.find_paths, { target: entity, maxHops: 4 })).toBe(true);
    expect(accepts(PersonalToolArgs.find_paths, { target: entity, maxHops: 5 })).toBe(false);
    expect(accepts(PersonalToolArgs.find_paths, { target: entity, maxHops: 0 })).toBe(false);
  });

  it("read_item refuses limit 21", () => {
    expect(accepts(PersonalToolArgs.read_item, { message, from: 999, limit: 20 })).toBe(true);
    expect(accepts(PersonalToolArgs.read_item, { message, limit: 21 })).toBe(false);
    expect(accepts(PersonalToolArgs.read_item, { message, from: 1000 })).toBe(false);
  });

  it("get_evidence_span and get_suggestions take their arguments; the stub takes none until its step", () => {
    expect(accepts(PersonalToolArgs.get_evidence_span, { fact })).toBe(true);
    expect(accepts(PersonalToolArgs.get_evidence_span, { fact: "A".repeat(64) })).toBe(false);
    expect(accepts(PersonalToolArgs.get_suggestions, { state: "any", limit: 50 })).toBe(true);
    expect(accepts(PersonalToolArgs.get_suggestions, { limit: 51 })).toBe(false);
    expect(accepts(PersonalToolArgs.get_suggestions, { state: "waiting" })).toBe(false);
    // get_decision_history takes no arguments.
    expect(accepts(PersonalToolArgs.get_decision_history, {})).toBe(true);
    expect(accepts(PersonalToolArgs.get_decision_history, { project: entity })).toBe(false);
  });

  it("fetch_template takes a document and get_document's window, strict", () => {
    const document = `doc_${ULID}`;
    expect(accepts(PersonalToolArgs.fetch_template, { document, offset: 1_000_000, limit: 50_000 })).toBe(true);
    expect(accepts(PersonalToolArgs.fetch_template, { document })).toBe(true);
    for (const bad of [
      {},
      { document: message },
      { document, offset: 1_000_001 },
      { document, limit: 50_001 },
      { document, limit: 0 },
      { id: document },
      { document, reference: true },
    ]) {
      expect(accepts(PersonalToolArgs.fetch_template, bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

const span = {
  fact,
  source: { kind: "message", id: message },
  passage: { untrusted: "We agreed on Tuesday." },
  chars: 21,
  cut: false,
};
const summary = {
  id: message,
  at,
  direction: "inbound",
  bulk: false,
  category: "primary",
  subject: { untrusted: "Lunch" },
  sender: { address: { untrusted: "alex@example.com" }, name: null },
  chars: 5,
  attachments: 0,
};
const thread = {
  thread: { untrusted: "t-1" },
  messages: [{ summary, text: { untrusted: "Hello" }, offset: 0, cut: false }],
  next: null,
};
const paths = {
  paths: [{ score: 0.5, hops: [{ from: who, to: who, via: "relationship", facts: [fact] }] }],
  cut: false,
};
const template = {
  document: {
    id: `doc_${ULID}`,
    title: { untrusted: "Intro letter" },
    kind: "doc",
    modifiedAt: at,
    mine: true,
    owner: null,
    reference: true,
    chars: 30,
    sections: 1,
    unreadable: null,
  },
  text: { untrusted: "Dear {{first name:text}}," },
  offset: 0,
  more: false,
  placeholders: [{ ordinal: 0, name: { untrusted: "first name" }, kind: { untrusted: "text" } }],
};
const record = {
  id: `rec_${ULID}`,
  client: "helper",
  at,
  question: { untrusted: "Which venue?" },
  chosen: { untrusted: "The library" },
  alternatives: [{ untrusted: "The park" }],
  reasoning: null,
  expectation: null,
  reviewAt: null,
  removed: false,
  provenance: "agent_reported",
};

describe("result shapes", () => {
  it("every evidence-derived string in a result is under untrusted", () => {
    const cases: [{ safeParse(value: unknown): { success: boolean } }, unknown, (bare: string) => unknown][] = [
      [EvidenceSpan, span, (bare) => ({ ...span, passage: bare })],
      [ThreadView, thread, (bare) => ({ ...thread, thread: bare })],
      [ThreadView, thread, (bare) => ({ ...thread, messages: [{ ...thread.messages[0], text: bare }] })],
      [
        PathList,
        paths,
        (bare) => ({
          ...paths,
          paths: [
            { score: 0.5, hops: [{ from: { ...who, name: bare }, to: who, via: "relationship", facts: [fact] }] },
          ],
        }),
      ],
      [TemplateView, template, (bare) => ({ ...template, text: bare })],
      [
        TemplateView,
        template,
        (bare) => ({ ...template, placeholders: [{ ...template.placeholders[0], name: bare }] }),
      ],
      [
        TemplateView,
        template,
        (bare) => ({ ...template, placeholders: [{ ...template.placeholders[0], kind: bare }] }),
      ],
      [DecisionRecordView, record, (bare) => ({ ...record, question: bare })],
      [DecisionRecordView, record, (bare) => ({ ...record, chosen: bare })],
      [DecisionRecordView, record, (bare) => ({ ...record, alternatives: [bare] })],
      [DecisionRecordView, record, (bare) => ({ ...record, reasoning: bare })],
      [DecisionRecordView, record, (bare) => ({ ...record, expectation: bare })],
    ];
    for (const [schema, valid, bare] of cases) {
      expect(accepts(schema, valid)).toBe(true);
      expect(accepts(schema, bare("a bare string"))).toBe(false);
    }
    // A suggestion carries clear words, ids and times only: no evidence text.
    const suggestions = {
      items: [{ ref: { kind: "work_request", id: `wrq_${ULID}` }, what: "brief", status: "waiting", at, results: [] }],
      more: false,
    };
    expect(accepts(SuggestionList, suggestions)).toBe(true);
    expect(accepts(SuggestionList, { ...suggestions, items: [{ ...suggestions.items[0], what: "A Brief!" }] })).toBe(
      false,
    );
    expect(
      accepts(SuggestionList, { ...suggestions, items: [{ ...suggestions.items[0], summary: { untrusted: "x" } }] }),
    ).toBe(false);
    expect(accepts(DecisionRecordView, { ...record, provenance: "source" })).toBe(false);
  });

  it("the evidence span's source is a message, a record, a document, or the kind of one no tool opens", () => {
    expect(accepts(EvidenceSpan, span)).toBe(true);
    expect(accepts(EvidenceSpan, { ...span, source: { kind: "record", id: `rec_${ULID}` } })).toBe(true);
    expect(accepts(EvidenceSpan, { ...span, source: { kind: "record", id: message } })).toBe(false);
    expect(accepts(EvidenceSpan, { ...span, passage: null, source: { kind: "document", id: `doc_${ULID}` } })).toBe(
      true,
    );
    expect(accepts(EvidenceSpan, { ...span, passage: null, source: { kind: "elsewhere", from: "meeting" } })).toBe(
      true,
    );
    expect(accepts(EvidenceSpan, { ...span, source: { kind: "elsewhere", from: "nowhere" } })).toBe(false);
    expect(accepts(EvidenceSpan, { ...span, source: { kind: "event", id: `evt_${ULID}` } })).toBe(false);
  });

  it("a thread holds at most 20 messages, and a path at most 4 hops; a list of paths at most 20", () => {
    expect(accepts(ThreadView, { ...thread, messages: Array(21).fill(thread.messages[0]) })).toBe(false);
    const hop = paths.paths[0]?.hops[0];
    expect(accepts(PathList, { ...paths, paths: [{ score: 1, hops: [hop, hop, hop, hop] }] })).toBe(true);
    expect(accepts(PathList, { ...paths, paths: [{ score: 1, hops: [hop, hop, hop, hop, hop] }] })).toBe(false);
    expect(accepts(PathList, { ...paths, paths: Array(21).fill(paths.paths[0]) })).toBe(false);
    expect(accepts(PathList, { ...paths, paths: [{ score: 1, hops: [{ ...hop, via: "met" }] }] })).toBe(false);
  });

  it("a template holds at most 100 placeholders, and no outline or link", () => {
    const one = template.placeholders[0];
    expect(accepts(TemplateView, { ...template, placeholders: Array(100).fill(one) })).toBe(true);
    expect(accepts(TemplateView, { ...template, placeholders: Array(101).fill(one) })).toBe(false);
    expect(accepts(TemplateView, { ...template, text: null, placeholders: [] })).toBe(true);
    expect(accepts(TemplateView, { ...template, link: null })).toBe(false);
    expect(accepts(TemplateView, { ...template, outline: [] })).toBe(false);
  });
});
