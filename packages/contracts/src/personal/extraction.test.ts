import {
  BacklogItem,
  BeliefRecord,
  CurrencyCode,
  DecideScreenOutput,
  DocumentTriageRow,
  DueCapture,
  DueDocument,
  DueItem,
  ExtractionCommit,
  FactList,
  FactView,
  FindFactsArgs,
  MOMENT_BATCH_GROUP_MAX,
  MOMENT_GROUP_MAX,
  ModelUsageEvent,
  PersonalLogEvent,
  PersonalReadTool,
  PersonalToolArgs,
  PersonalUnmappedReason,
  PipelineCode,
  PipelineStatus,
  REJECTED_CONTENT_FILTER,
  REJECTED_LENGTH,
  RunCounts,
  RunSummary,
  TOOL_VIEW,
  TriageLane,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// Made-up values. A ULID is 26 characters of Crockford base32.
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-03-04T10:00:00Z";
const fact = "a".repeat(64);
const owner = { id: `ent_${ULID}`, kind: "owner", name: null, address: { untrusted: "owner@example.com" } };
const person = {
  id: `ent_${ULID}`,
  kind: "person",
  name: { untrusted: "Alex Example" },
  address: { untrusted: "alex@example.com" },
};
const base = {
  id: fact,
  subject: owner,
  statedBy: person,
  basis: "explicit_self",
  statementKind: "stated_fact",
  at,
  message: `msg_${ULID}`,
  document: null,
  passage: null,
  page: null,
  capture: null,
  segment: null,
  thirdParty: false,
  agentReported: false,
  provenance: "source",
};
const receipt = {
  ...base,
  type: "transaction.receipt",
  fields: {
    merchant: { untrusted: "Example Books" },
    amount: 12.5,
    currency: "USD",
    date: "2026-03-04",
    order_ref: { untrusted: "A-1001" },
  },
};
const commitment = {
  ...base,
  type: "commitment",
  status: "active",
  fields: { counterparty: person, what: { untrusted: "I will send the report." }, due: "2026-03-10" },
};
const plan = { ...base, type: "plan", statedBy: null, fields: { what: { untrusted: "Lunch on Friday." }, when: at } };
const counts = {
  done: 1,
  skipped: 0,
  withheld: 0,
  failed: 0,
  waiting: 0,
  claims: 2,
  unmapped: 0,
  unresolved: 0,
  liveCalls: 1,
  beliefs: 1,
  beliefsChanged: 1,
  beliefsMixed: 0,
  beliefsFailed: 0,
  beliefsRemoved: 0,
  rebuildMs: 3,
};

const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

describe("extraction contracts", () => {
  it("find_facts is a work tool with its own strict arguments", () => {
    expect(PersonalReadTool.options).toContain("find_facts");
    expect(TOOL_VIEW.find_facts).toBe("work");
    expect(PersonalToolArgs.find_facts).toBe(FindFactsArgs);
  });

  it("find_facts refuses an unknown field, a limit of 51 and a type that is neither a fact type nor the parent", () => {
    for (const type of ["transaction.receipt", "commitment", "plan", "transaction"]) {
      expect(accepts(FindFactsArgs, { type, entity: `ent_${ULID}`, from: at, to: at, limit: 50 }), type).toBe(true);
    }
    expect(accepts(FindFactsArgs, {})).toBe(true);
    expect(accepts(FindFactsArgs, { limit: 51 })).toBe(false);
    expect(accepts(FindFactsArgs, { limit: 0 })).toBe(false);
    expect(accepts(FindFactsArgs, { type: "receipt" })).toBe(false);
    expect(accepts(FindFactsArgs, { type: "transaction.bill" })).toBe(false);
    expect(accepts(FindFactsArgs, { label: "own" })).toBe(false);
  });

  it("a fact view refuses a bare string where a text value is expected, a one-word one included", () => {
    for (const value of [receipt, commitment, plan]) expect(accepts(FactView, value), value.type).toBe(true);
    expect(accepts(FactView, { ...receipt, fields: { ...receipt.fields, merchant: "Books" } })).toBe(false);
    expect(accepts(FactView, { ...receipt, fields: { ...receipt.fields, order_ref: "A1001" } })).toBe(false);
    expect(accepts(FactView, { ...commitment, fields: { ...commitment.fields, what: "Send" } })).toBe(false);
    expect(accepts(FactView, { ...plan, fields: { ...plan.fields, what: "Lunch" } })).toBe(false);
    // A person's name and address are evidence too.
    expect(accepts(FactView, { ...commitment, statedBy: { ...person, name: "Alex" } })).toBe(false);
  });

  it("a fact view refuses a field its type does not have, and a type the contract does not know", () => {
    expect(accepts(FactView, { ...receipt, fields: { ...receipt.fields, what: { untrusted: "x" } } })).toBe(false);
    expect(accepts(FactView, { ...commitment, fields: { ...commitment.fields, merchant: { untrusted: "x" } } })).toBe(
      false,
    );
    expect(accepts(FactView, { ...plan, fields: { what: plan.fields.what } })).toBe(false);
    expect(accepts(FactView, { ...receipt, type: "transaction.bill" })).toBe(false);
    expect(accepts(FactView, { ...receipt, type: "transaction" })).toBe(false);
    expect(accepts(FactView, { ...receipt, label: "own" })).toBe(false);
    expect(accepts(FactList, { facts: [receipt, commitment, plan], more: false })).toBe(true);
    expect(accepts(FactList, { facts: [{ ...receipt, type: "transaction.bill" }], more: false })).toBe(false);
  });

  it("a fact view refuses a missing agentReported", () => {
    const { agentReported: _left, ...without } = receipt;
    expect(accepts(FactView, without)).toBe(false);
    expect(accepts(FactView, { ...receipt, agentReported: true, provenance: "agent_reported" })).toBe(true);
  });

  it("a currency code is one of the list", () => {
    for (const code of ["USD", "EUR", "GBP", "JPY", "CHF", "XOF"]) expect(accepts(CurrencyCode, code), code).toBe(true);
    for (const code of ["XAU", "XXX", "USN", "usd"]) expect(accepts(CurrencyCode, code), code).toBe(false);
  });

  it("a usage event refuses a cost that is not a whole number of micro-dollars", () => {
    const event = {
      promptId: "personal_transaction",
      promptVersion: "1",
      modelId: "vendor/model",
      inputTokens: 900,
      outputTokens: 120,
      costMicroUsd: 1250,
      outcome: "ok",
    };
    expect(accepts(ModelUsageEvent, event)).toBe(true);
    expect(accepts(ModelUsageEvent, { ...event, outcome: "no_answer", evidenceId: "f".repeat(64) })).toBe(true);
    expect(accepts(ModelUsageEvent, { ...event, costMicroUsd: 0.00125 })).toBe(false);
    expect(accepts(ModelUsageEvent, { ...event, costMicroUsd: 12.5 })).toBe(false);
    expect(accepts(ModelUsageEvent, { ...event, costMicroUsd: -1 })).toBe(false);
    expect(accepts(ModelUsageEvent, { ...event, zdr: false })).toBe(false);
  });

  it("a Jev screen answer is the three probabilities in [0, 1] and nothing else (J1)", () => {
    const answer = { human_written: 0.8, special_category: 0, quarantine: 1 };
    expect(accepts(DecideScreenOutput, answer)).toBe(true);
    expect(accepts(DecideScreenOutput, { ...answer, quarantine: 1.01 })).toBe(false);
    expect(accepts(DecideScreenOutput, { ...answer, special_category: -0.1 })).toBe(false);
    expect(accepts(DecideScreenOutput, { ...answer, human_written: "0.8" })).toBe(false);
    expect(accepts(DecideScreenOutput, { ...answer, human_written: Number.NaN })).toBe(false);
    expect(accepts(DecideScreenOutput, { ...answer, extra: 0.5 })).toBe(false);
    const { quarantine: _left, ...two } = answer;
    expect(accepts(DecideScreenOutput, two)).toBe(false);
  });

  it("a backlog item is a due item with the lane it was committed in, and nothing else (J1)", () => {
    const triage = { direction: "inbound", bulk: true, category: "promotions", unreadable: false, chars: 120 };
    const item = {
      source: "email",
      evidenceId: "a".repeat(64),
      compartments: ["own"],
      sentAt: at,
      attempts: 0,
      override: false,
      triage,
      committedLane: "skip",
    };
    expect(accepts(BacklogItem, item)).toBe(true);
    expect(accepts(BacklogItem, { ...item, lane: "correspondence" })).toBe(true);
    expect(accepts(BacklogItem, { ...item, committedLane: "bulk" })).toBe(false);
    const { committedLane: _none, ...due } = item;
    expect(accepts(BacklogItem, due)).toBe(false);
    expect(accepts(BacklogItem, { ...item, status: "done" })).toBe(false);
  });

  it("a pipeline status is one of the five, and held and flagged are not", () => {
    expect(PipelineStatus.options).toEqual(["waiting", "done", "skipped", "withheld", "failed"]);
    expect(accepts(PipelineStatus, "held")).toBe(false);
    expect(accepts(PipelineStatus, "flagged")).toBe(false);
  });

  it("a run's counts refuse an unknown key, a missing key and a negative number", () => {
    expect(accepts(RunCounts, counts)).toBe(true);
    expect(accepts(RunSummary, { code: "ok", counts })).toBe(true);
    expect(accepts(RunSummary, { code: "fine", counts })).toBe(false);
    expect(accepts(RunCounts, { ...counts, extra: 1 })).toBe(false);
    const { rebuildMs: _left, ...missing } = counts;
    expect(accepts(RunCounts, missing)).toBe(false);
    expect(accepts(RunCounts, { ...counts, claims: -1 })).toBe(false);
    expect(accepts(RunCounts, { ...counts, claims: 1.5 })).toBe(false);
  });

  it("the two rejection texts are not JSON", () => {
    expect(REJECTED_LENGTH).toBe("rejected:length");
    expect(REJECTED_CONTENT_FILTER).toBe("rejected:content_filter");
    for (const text of [REJECTED_LENGTH, REJECTED_CONTENT_FILTER]) expect(() => JSON.parse(text), text).toThrow();
  });

  it("a personal unmapped reason is the shared list, bad_speaker, multi_fact and negated_object, not_standalone and not_what_was_said, and not_first_hand", () => {
    expect(PersonalUnmappedReason.options).toEqual([
      "unknown_type",
      "bad_fields",
      "bad_span",
      "bad_times",
      "ungrounded_mention",
      "author_unknown",
      "bad_speaker",
      "multi_fact",
      "negated_object",
      "not_standalone",
      "not_what_was_said",
      "not_first_hand",
      "not_a_promise",
      "wrong_direction",
      "negation_cut",
      "dated_task",
      "agent_instruction",
      "not_about_owner",
    ]);
  });

  it("a log event takes an evidence id and refuses a name", () => {
    expect(
      accepts(PersonalLogEvent, {
        event: "extract_item_failed",
        code: "check_failed",
        ids: { evidence: "f".repeat(64) },
      }),
    ).toBe(true);
    expect(accepts(PersonalLogEvent, { event: "extract_item_failed", ids: { evidence: "Alex Example" } })).toBe(false);
    expect(accepts(PersonalLogEvent, { event: "extract_item_failed", ids: { evidence: "alex@example.com" } })).toBe(
      false,
    );
  });

  // The document lane's shapes, beside the mail lanes'.
  it("the triage lanes are correspondence, transaction and skip, then agent, document and page; the pipeline codes gain reference, not_owners and old", () => {
    expect(TriageLane.options).toEqual([
      "correspondence",
      "transaction",
      "skip",
      "agent",
      "document",
      "page",
      "meeting",
      "moment",
    ]);
    for (const code of ["reference", "not_owners", "old"]) expect(accepts(PipelineCode, code), code).toBe(true);
    expect(PipelineCode.options.slice(0, 13)).toEqual([
      "bulk",
      "no_text",
      "too_long",
      "sensitive",
      "quarantine",
      "parse_failed",
      "interpret_failed",
      "cut_off",
      "filtered",
      "model_refused_item",
      "check_failed",
      "model_unavailable",
      "commit_failed",
    ]);
    const reference = PipelineCode.options.indexOf("reference");
    expect(PipelineCode.options.slice(reference, reference + 3)).toEqual(["reference", "not_owners", "old"]);
  });

  it("a fact from a document names its document and passage, and a fact never names both a message and a document", () => {
    const fromDocument = { ...commitment, message: null, document: `doc_${ULID}`, passage: { start: 0, end: 40 } };
    expect(accepts(FactView, fromDocument)).toBe(true);
    expect(accepts(FactView, { ...commitment, message: null })).toBe(true);
    expect(accepts(FactView, { ...fromDocument, message: `msg_${ULID}` })).toBe(false);
    expect(accepts(FactView, { ...fromDocument, passage: { start: -1, end: 4 } })).toBe(false);
    expect(accepts(FactView, { ...fromDocument, passage: { start: 0, end: 4, text: "x" } })).toBe(false);
    expect(accepts(FactView, { ...fromDocument, document: `msg_${ULID}` })).toBe(false);
    const { document: _left, ...missing } = commitment;
    expect(accepts(FactView, missing)).toBe(false);
    expect(accepts(FactList, { facts: [fromDocument, receipt], more: false })).toBe(true);
  });

  it("a fact from an agent record names it by its id or a handle, and then names no message", () => {
    const finding = {
      ...commitment,
      message: null,
      record: `rec_${ULID}`,
      agentReported: true,
      provenance: "agent_reported",
    };
    expect(accepts(FactView, finding)).toBe(true);
    expect(accepts(FactView, { ...finding, record: `hdl_${ULID}` })).toBe(true);
    expect(accepts(FactView, { ...finding, record: `msg_${ULID}` })).toBe(false);
    expect(accepts(FactView, { ...finding, message: `msg_${ULID}` })).toBe(false);
  });

  it("a due document carries its triage row of clear columns and sealed counts, and nothing of its text", () => {
    const triage = {
      reference: false,
      kind: "doc",
      mine: true,
      editedByMe: true,
      unreadable: false,
      chars: 120,
      modifiedAt: at,
    };
    expect(accepts(DocumentTriageRow, triage)).toBe(true);
    expect(accepts(DocumentTriageRow, { ...triage, kind: "spreadsheet" })).toBe(false);
    expect(accepts(DocumentTriageRow, { ...triage, title: "Plans" })).toBe(false);
    const due = {
      evidenceId: "f".repeat(64),
      compartment: "own",
      modifiedAt: at,
      attempts: 0,
      override: false,
      triage,
    };
    expect(accepts(DueDocument, due)).toBe(true);
    expect(accepts(DueDocument, { ...due, lane: "document" })).toBe(true);
    expect(accepts(DueDocument, { ...due, lane: "skim" })).toBe(false);
    expect(accepts(DueDocument, { ...due, evidenceId: "doc" })).toBe(false);
  });

  it("a commit may count a document's groups and the passages left out, as whole numbers", () => {
    const batch = {
      evidenceId: "f".repeat(64),
      generation: 1,
      lane: "document",
      status: "done",
      claims: [],
      unmapped: [],
      unresolved: 0,
    };
    expect(accepts(ExtractionCommit, batch)).toBe(true);
    expect(accepts(ExtractionCommit, { ...batch, groups: 2, leftOut: 3 })).toBe(true);
    // A meeting's windows, at most 24; every other lane's groups at most eight.
    expect(accepts(ExtractionCommit, { ...batch, lane: "meeting", groups: 24 })).toBe(true);
    expect(accepts(ExtractionCommit, { ...batch, lane: "meeting", groups: 25 })).toBe(false);
    expect(accepts(ExtractionCommit, { ...batch, groups: 9 })).toBe(false);
    expect(accepts(ExtractionCommit, { ...batch, leftOut: -1 })).toBe(false);
  });

  it("a refusal's status is a fixed http code, on a run summary and a log event, and nothing else", () => {
    expect(PipelineCode.options).toContain("model_refused_item");
    expect(accepts(RunSummary, { code: "model_refused", status: "http_402", counts })).toBe(true);
    expect(accepts(PersonalLogEvent, { event: "command_failed", code: "model_refused", status: "http_400" })).toBe(
      true,
    );
    for (const status of ["http_40", "http_4000", "402", "http_402 key limit", "Alex Example"]) {
      expect(accepts(RunSummary, { code: "model_refused", status, counts }), status).toBe(false);
      expect(accepts(PersonalLogEvent, { event: "command_failed", status }), status).toBe(false);
    }
  });
});

// The agent lane's shapes.
describe("the agent lane's contracts", () => {
  const evidenceId = "e".repeat(64);
  const triageRow = { direction: "inbound", bulk: false, category: "primary", unreadable: false, chars: 120 };
  const email = {
    source: "email",
    evidenceId,
    compartments: ["own"],
    sentAt: at,
    attempts: 0,
    override: false,
    triage: triageRow,
  };
  const agent = {
    source: "agent_record",
    evidenceId,
    compartments: ["agent:alpha", "own"],
    sentAt: at,
    attempts: 0,
    override: false,
    kind: "finding",
  };

  it("a fact view's provenance is agent_reported exactly when agentReported is true", () => {
    expect(accepts(FactView, { ...receipt, provenance: "source" })).toBe(true);
    expect(accepts(FactView, { ...receipt, agentReported: true, provenance: "agent_reported" })).toBe(true);
    expect(accepts(FactView, { ...receipt, agentReported: true, provenance: "source" })).toBe(false);
    expect(accepts(FactView, { ...receipt, agentReported: false, provenance: "agent_reported" })).toBe(false);
    const { provenance: _left, ...without } = { ...receipt, provenance: "source" };
    expect(accepts(FactView, without)).toBe(false);
  });

  it("a fact view refuses a provenance outside the four", () => {
    expect(accepts(FactView, { ...commitment, provenance: "agent" })).toBe(false);
    expect(accepts(FactView, { ...commitment, provenance: "corroborated" })).toBe(true);
  });

  it("a due item is a message's or an agent record's, and each carries its compartments", () => {
    expect(accepts(DueItem, email)).toBe(true);
    expect(accepts(DueItem, { ...email, lane: "transaction" })).toBe(true);
    expect(accepts(DueItem, agent)).toBe(true);
    expect(accepts(DueItem, { ...agent, kind: "handoff" })).toBe(true);
    // Every agent-lane kind is due as an agent record,
    // and no other.
    for (const kind of ["proposal", "memory_change", "lesson", "capability"])
      expect(accepts(DueItem, { ...agent, kind }), kind).toBe(true);
    expect(accepts(DueItem, { ...agent, kind: "transcript" })).toBe(false);
    // Each member is strict: no triage row on an agent record, no kind on a message.
    expect(accepts(DueItem, { ...agent, triage: triageRow })).toBe(false);
    expect(accepts(DueItem, { ...email, kind: "finding" })).toBe(false);
    expect(accepts(DueItem, { ...agent, lane: "agent" })).toBe(false);
    expect(accepts(DueItem, { ...email, compartments: [] })).toBe(false);
    expect(accepts(DueItem, { ...agent, compartments: undefined })).toBe(false);
    const { compartments: _gone, ...one } = email;
    expect(accepts(DueItem, { ...one, compartment: "own" })).toBe(false);
    expect(accepts(DueItem, { ...agent, source: "agent" })).toBe(false);
    expect(TriageLane.options).toContain("agent");
    expect(PipelineCode.options).toContain("not_a_finding");
  });

  it("a proposal ends bad_proposal or client_scoped", () => {
    const proposal = PipelineCode.options.indexOf("bad_proposal");
    expect(PipelineCode.options.slice(proposal, proposal + 2)).toEqual(["bad_proposal", "client_scoped"]);
  });

  it("a page moment ends reading, after every earlier code; the narrowed moment lane's reasons after it", () => {
    const reading = PipelineCode.options.indexOf("reading");
    expect(PipelineCode.options.slice(reading)).toEqual([
      "reading",
      "agent_app",
      "not_chat",
      "no_turns",
      "bad_close",
      "orphaned",
      "bad_fill",
    ]);
  });

  it("a belief record carries its compartments and its provenance, and refuses an empty, unsorted or repeated list and a provenance outside the four", () => {
    const belief = {
      kind: "commitment",
      factKey: "f".repeat(64),
      supportHash: "a".repeat(64),
      subject: `ent_${ULID}`,
      type: "commitment",
      values: {},
      label: { compartments: ["agent:alpha", "own"], readers: ["m-owner"] },
      status: "active",
      disputed: false,
      confidence: 1,
      lastConfirmedAt: at,
      changeKind: "backfill",
      support: ["b".repeat(64)],
    };
    const record = {
      belief,
      factKeyFp: "f".repeat(64),
      compartments: ["agent:alpha", "own"],
      provenance: "agent_reported",
    };
    expect(accepts(BeliefRecord, record)).toBe(true);
    expect(accepts(BeliefRecord, { ...record, compartments: ["own"], provenance: "source" })).toBe(true);
    expect(accepts(BeliefRecord, { ...record, compartments: [] })).toBe(false);
    expect(accepts(BeliefRecord, { ...record, compartments: ["own", "agent:alpha"] })).toBe(false);
    expect(accepts(BeliefRecord, { ...record, compartments: ["own", "own"] })).toBe(false);
    expect(accepts(BeliefRecord, { ...record, provenance: "agent" })).toBe(false);
    const { provenance: _p, ...noProvenance } = record;
    expect(accepts(BeliefRecord, noProvenance)).toBe(false);
    expect(accepts(BeliefRecord, { ...noProvenance, provenance: "source", compartment: "own" })).toBe(false);
  });
});

describe("the meeting lane's contracts", () => {
  const due = {
    evidenceId: "c".repeat(64),
    compartments: ["employer:example", "own"],
    observedAt: at,
    attempts: 0,
    override: false,
  };

  it("the meeting lane and the three capture codes are accepted", () => {
    expect(accepts(TriageLane, "meeting")).toBe(true);
    for (const code of ["too_short", "connected_source", "not_extracted"])
      expect(accepts(PipelineCode, code), code).toBe(true);
    expect(
      accepts(ExtractionCommit, {
        evidenceId: "c".repeat(64),
        generation: 1,
        lane: "meeting",
        status: "skipped",
        code: "not_extracted",
        claims: [],
        unmapped: [],
        unresolved: 0,
      }),
    ).toBe(true);
  });

  it("a due capture carries its whole label, its observed time and the owner's marks, and nothing else", () => {
    expect(accepts(DueCapture, due)).toBe(true);
    expect(accepts(DueCapture, { ...due, lane: "meeting" })).toBe(true);
    expect(accepts(DueCapture, { ...due, lane: "skim" })).toBe(false);
    expect(accepts(DueCapture, { ...due, compartments: [] })).toBe(false);
    expect(accepts(DueCapture, { ...due, compartments: ["own", "employer:example"] })).toBe(false);
    expect(accepts(DueCapture, { ...due, evidenceId: `cap_${ULID}` })).toBe(false);
    expect(accepts(DueCapture, { ...due, attempts: -1 })).toBe(false);
    expect(accepts(DueCapture, { ...due, title: "Weekly" })).toBe(false);
    const { observedAt: _gone, ...without } = due;
    expect(accepts(DueCapture, without)).toBe(false);
  });
});

describe("the moment lane's contracts", () => {
  const member = (n: number) => ({
    evidenceId: n.toString(16).padStart(64, "0"),
    compartments: ["own"],
    observedAt: at,
    attempts: 0,
    override: false,
  });
  const group = (size: number) => ({ ...member(size), moments: Array.from({ length: size }, (_, n) => member(n + 1)) });

  it("the moment lane is accepted, in a commit too", () => {
    expect(accepts(TriageLane, "moment")).toBe(true);
    expect(
      accepts(ExtractionCommit, {
        evidenceId: "c".repeat(64),
        generation: 1,
        lane: "moment",
        status: "skipped",
        code: "not_extracted",
        claims: [],
        unmapped: [],
        unresolved: 0,
      }),
    ).toBe(true);
  });

  it("a due moment group lists one to MOMENT_BATCH_GROUP_MAX moments (the continuous mode's MOMENT_GROUP_MAX), each with its own marks and nothing else", () => {
    expect(MOMENT_GROUP_MAX).toBe(12);
    expect(MOMENT_BATCH_GROUP_MAX).toBe(100);
    expect(accepts(DueCapture, group(1))).toBe(true);
    expect(accepts(DueCapture, group(100))).toBe(true);
    expect(accepts(DueCapture, group(101))).toBe(false);
    expect(accepts(DueCapture, { ...member(1), moments: [] })).toBe(false);
    expect(accepts(DueCapture, { ...group(2), moments: [{ ...member(1), lane: "moment" }, member(2)] })).toBe(true);
    expect(accepts(DueCapture, { ...group(2), moments: [{ ...member(1), thread: "Weekly" }, member(2)] })).toBe(false);
    expect(accepts(DueCapture, { ...group(2), moments: [{ ...member(1), moments: [] }, member(2)] })).toBe(false);
  });
});
