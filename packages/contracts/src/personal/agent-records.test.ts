import {
  AgentRecordAck,
  AgentRecordArgs,
  AgentRecordItem,
  AgentRecordView,
  AttendeeBrief,
  BuildContextPackArgs,
  ClientRegistration,
  ClientView,
  ContextPack,
  isProjectTyped,
  PACK_VIEW,
  PackItem,
  PersonalContextPackPurpose,
  PersonalLogEvent,
  PersonalSourceKind,
  PersonalToolArgs,
  PersonalToolError,
  PersonalWriteTool,
  ProjectTypedClaimArgs,
  Provenance,
  READ_BUDGET,
  RECORD_READS_LISTED,
  RecordReads,
  RecordReadsArgs,
  TOOL_VIEW,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// Agent records and context packs. Made-up values only.
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-03-04T10:00:00Z";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const args = { kind: "note", body: "Met Alex; follow up on the draft.", requestId: "req-0001" };
const evidence = "a".repeat(64);
const who = {
  id: `ent_${ULID}`,
  kind: "person",
  name: { untrusted: "Alex Example" },
  address: { untrusted: "alex@example.com" },
};

describe("agent records", () => {
  it("record args refuse a label, a compartment, a client, a session, a subject, an origin, a view and a provenance", () => {
    expect(accepts(AgentRecordArgs, args)).toBe(true);
    for (const key of ["label", "compartment", "client", "session", "subject", "origin", "view", "provenance"]) {
      expect(accepts(AgentRecordArgs, { ...args, [key]: "own" }), key).toBe(false);
    }
  });

  it("an empty body, a body of 8 001 code points and a body with a NUL are refused, and one of 8 000 is taken", () => {
    expect(accepts(AgentRecordArgs, { ...args, body: "" })).toBe(false);
    expect(accepts(AgentRecordArgs, { ...args, body: "a".repeat(8000) })).toBe(true);
    expect(accepts(AgentRecordArgs, { ...args, body: "a".repeat(8001) })).toBe(false);
    expect(accepts(AgentRecordArgs, { ...args, body: "a\u0000b" })).toBe(false);
    // Counted in code points: 8 000 astral characters are 16 000 UTF-16 units, and taken.
    expect(accepts(AgentRecordArgs, { ...args, body: "\u{1F600}".repeat(8000) })).toBe(true);
    expect(accepts(AgentRecordArgs, { ...args, body: "\u{1F600}".repeat(8001) })).toBe(false);
  });

  it("21 cites and a repeated cite are refused", () => {
    const cites = Array.from({ length: 20 }, (_, i) => `msg_${ULID.slice(0, 24)}${String(i).padStart(2, "0")}`);
    expect(accepts(AgentRecordArgs, { ...args, cites })).toBe(true);
    expect(accepts(AgentRecordArgs, { ...args, cites: [...cites, `evt_${ULID}`] })).toBe(false);
    expect(accepts(AgentRecordArgs, { ...args, cites: [`msg_${ULID}`, `msg_${ULID}`] })).toBe(false);
    expect(accepts(AgentRecordArgs, { ...args, cites: [`msg_${ULID}`, `evt_${ULID}`] })).toBe(true);
    expect(accepts(AgentRecordArgs, { ...args, cites: [`ent_${ULID}`] })).toBe(false);
  });

  it("a request id of 7 characters, of 65, and one with a space are refused", () => {
    expect(accepts(AgentRecordArgs, { ...args, requestId: "a".repeat(8) })).toBe(true);
    expect(accepts(AgentRecordArgs, { ...args, requestId: "a".repeat(64) })).toBe(true);
    for (const requestId of ["a".repeat(7), "a".repeat(65), "req 0001"])
      expect(accepts(AgentRecordArgs, { ...args, requestId }), requestId).toBe(false);
  });

  it("a registration may list record, and a client view carries it", () => {
    const registration = {
      name: "hermes",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own", "agent:hermes"],
      views: ["self"],
      tools: ["get_self", "record"],
    };
    expect(accepts(ClientRegistration, registration)).toBe(true);
    expect(
      accepts(ClientView, {
        id: `cli_${ULID}`,
        name: "hermes",
        compartments: ["own"],
        views: ["self"],
        tools: ["record"],
      }),
    ).toBe(true);
    expect(PersonalWriteTool.options).toContain("record");
    // record needs no view: TOOL_VIEW and PersonalToolArgs stay records of the read tools.
    expect("record" in TOOL_VIEW).toBe(false);
    expect("record" in PersonalToolArgs).toBe(false);
  });

  it("rate_limited is a tool error", () => {
    expect(accepts(PersonalToolError, "rate_limited")).toBe(true);
  });

  it("a record item refuses a cite that is not an evidence id", () => {
    const item = {
      recordId: `rec_${ULID}`,
      client: "hermes",
      session: `ses_${ULID}`,
      kind: "finding",
      recordedAt: at,
      cites: [evidence],
    };
    expect(accepts(AgentRecordItem, item)).toBe(true);
    expect(accepts(AgentRecordItem, { ...item, cites: [`msg_${ULID}`] })).toBe(false);
    expect(accepts(AgentRecordItem, { ...item, cites: ["A".repeat(64)] })).toBe(false);
    expect(accepts(AgentRecordItem, { ...item, label: ["own"] })).toBe(false);
    expect(accepts(AgentRecordAck, { recordId: `rec_${ULID}` })).toBe(true);
    expect(accepts(AgentRecordAck, { recordId: `rec_${ULID}`, label: "own" })).toBe(false);
  });

  it("provenance is one of the four, and the source kind is agent_record", () => {
    expect(Provenance.options).toEqual(["source", "agent_reported", "corroborated", "owner"]);
    expect(accepts(Provenance, "agent")).toBe(false);
    expect(PersonalSourceKind.options).toEqual([
      "agent_record",
      "screen_activity",
      "time_block",
      "owner_task",
      "owner_command",
    ]);
  });

  it("a log event takes a record id and a session id and refuses a name in either", () => {
    expect(
      accepts(PersonalLogEvent, { event: "record_written", ids: { record: `rec_${ULID}`, session: `ses_${ULID}` } }),
    ).toBe(true);
    expect(accepts(PersonalLogEvent, { event: "record_written", ids: { record: "Alex Example" } })).toBe(false);
    expect(accepts(PersonalLogEvent, { event: "record_written", ids: { session: "alex@example.com" } })).toBe(false);
  });
});

const meeting = {
  id: `evt_${ULID}`,
  title: { untrusted: "Review" },
  startsAt: at,
  endsAt: null,
  allDay: false,
  cancelled: false,
  participants: [who],
};
const record = {
  id: `rec_${ULID}`,
  kind: "handoff",
  client: "hermes",
  at,
  body: { untrusted: "Next: reply to Alex." },
  chars: 20,
  cut: false,
  removed: false,
};
const base = { required: true, provenance: "source", asOf: at };
const summary = {
  id: `msg_${ULID}`,
  at,
  direction: "inbound",
  bulk: false,
  category: "primary",
  subject: { untrusted: "Notes" },
  sender: { address: { untrusted: "alex@example.com" }, name: null },
  chars: 10,
  attachments: 0,
};
const items = [
  { ...base, id: "address:0", section: "owner", kind: "address", value: { untrusted: "owner@example.org" } },
  { ...base, id: `evt_${ULID}`, section: "upcoming", kind: "meeting", meeting, cut: false },
  {
    ...base,
    id: `ent_${ULID}`,
    section: "contacts",
    kind: "contact",
    contact: { ...who, emails30d: 1, emails90d: 2, meetings90d: 0 },
  },
  {
    ...base,
    id: `ent_${ULID}`,
    section: "attendees",
    kind: "attendee",
    attendee: { who, inbound: 1, outbound: 0, lastAt: at, lastMeetingAt: null },
  },
  { ...base, id: `msg_${ULID}`, section: "recent_messages", kind: "message", message: summary },
  { ...base, id: `rec_${ULID}`, section: "handoff", kind: "record", provenance: "agent_reported", record },
];
const pack = {
  purpose: "agent_bootstrap",
  template: "agent_bootstrap@1",
  asOf: at,
  items,
  truncated: false,
  hash: "0".repeat(64),
};

// Supersession and read receipts.
describe("supersession and read receipts", () => {
  const rec = `rec_${ULID}`;
  const entry = {
    record: rec,
    kind: "note",
    recordedAt: at,
    supersededBy: null,
    erased: false,
    readers: [{ client: "other-agent", firstAt: at, lastAt: at, count: 2 }],
  };

  it("a note or a finding may name one record it supersedes; a handoff may not, and the id must be a record's", () => {
    expect(accepts(AgentRecordArgs, { ...args, supersedes: rec })).toBe(true);
    expect(accepts(AgentRecordArgs, { ...args, kind: "finding", supersedes: rec })).toBe(true);
    expect(accepts(AgentRecordArgs, { ...args, supersedes: `hdl_${ULID}` })).toBe(true);
    expect(accepts(AgentRecordArgs, { ...args, kind: "handoff", supersedes: rec })).toBe(false);
    expect(accepts(AgentRecordArgs, { ...args, kind: "handoff" })).toBe(true);
    for (const bad of [`msg_${ULID}`, "rec_bad", "", [rec]])
      expect(accepts(AgentRecordArgs, { ...args, supersedes: bad }), JSON.stringify(bad)).toBe(false);
  });

  it("a finding may name a project, by an entity id or a handle; a note, a handoff and a typed finding may not", () => {
    const project = `ent_${ULID}`;
    const base = { body: "A fact.", requestId: "request-0001" };
    const claim = { subject: { name: "Ada" }, type: "role", fields: {}, cites: [], requestId: "request-0002" };
    expect(accepts(AgentRecordArgs, { ...base, kind: "finding", project })).toBe(true);
    expect(accepts(AgentRecordArgs, { ...base, kind: "finding" })).toBe(true);
    expect(accepts(AgentRecordArgs, { ...base, kind: "note", project })).toBe(false);
    expect(accepts(AgentRecordArgs, { ...base, kind: "handoff", project })).toBe(false);
    expect(accepts(AgentRecordArgs, { ...base, kind: "finding", project: "the kiln" })).toBe(false);
    expect(accepts(AgentRecordArgs, { ...base, kind: "finding", claims: [claim] })).toBe(true);
    // A typed finding may be filed under a project too: its project claims are about that project,
    // which the write path checks claim by claim.
    expect(accepts(AgentRecordArgs, { ...base, kind: "finding", project, claims: [claim] })).toBe(true);
    const status = { subject: { id: project }, type: "project.status", cites: [], requestId: "request-0003" };
    expect(accepts(ProjectTypedClaimArgs, { ...status, fields: { status: "waiting" } })).toBe(true);
    expect(accepts(ProjectTypedClaimArgs, { ...status, fields: { status: "waiting", what: "On the supplier." } })).toBe(
      true,
    );
    // The words an agent sets a status with, and no field outside the type's.
    expect(accepts(ProjectTypedClaimArgs, { ...status, fields: { status: "cancelled" } })).toBe(false);
    expect(accepts(ProjectTypedClaimArgs, { ...status, fields: { status: "waiting", owner: "Ada" } })).toBe(false);
    expect(
      accepts(ProjectTypedClaimArgs, {
        ...status,
        type: "project.next_step",
        fields: { what: "Order the brick.", who: project },
      }),
    ).toBe(true);
    expect(
      accepts(ProjectTypedClaimArgs, { ...status, type: "project.next_step", fields: { what: "Order the brick." } }),
    ).toBe(false);
    expect(
      accepts(ProjectTypedClaimArgs, { ...status, type: "project.decision", fields: { what: "Fire in March." } }),
    ).toBe(true);
    expect(accepts(ProjectTypedClaimArgs, { ...status, type: "role", fields: { title: "lead" } })).toBe(false);
    expect(isProjectTyped("project.status")).toBe(true);
    expect(isProjectTyped("project.fact")).toBe(false);
  });

  it("read_record and find_records take the view self, and find_records only its own filters", () => {
    expect(TOOL_VIEW.read_record).toBe("self");
    expect(TOOL_VIEW.find_records).toBe("self");
    expect(accepts(PersonalToolArgs.read_record, { record: rec })).toBe(true);
    expect(accepts(PersonalToolArgs.read_record, {})).toBe(false);
    expect(accepts(PersonalToolArgs.find_records, {})).toBe(true);
    expect(accepts(PersonalToolArgs.find_records, { text: "kiln", limit: 50, client: "claude-code" })).toBe(true);
    for (const bad of [{ limit: 51 }, { text: "" }, { text: "x".repeat(201) }, { offset: 3 }, { label: ["own"] }])
      expect(accepts(PersonalToolArgs.find_records, bad), JSON.stringify(bad)).toBe(false);
  });

  it("record_reads is a list read tool of the self view, taking one record id or none, and nothing else", () => {
    expect(PersonalToolArgs.record_reads).toBe(RecordReadsArgs);
    expect(TOOL_VIEW.record_reads).toBe("self");
    expect(READ_BUDGET.record_reads).toBe("list");
    expect(accepts(RecordReadsArgs, {})).toBe(true);
    expect(accepts(RecordReadsArgs, { record: rec })).toBe(true);
    for (const extra of [{ record: `ent_${ULID}` }, { client: "other-agent" }, { record: rec, limit: 5 }])
      expect(accepts(RecordReadsArgs, extra), JSON.stringify(extra)).toBe(false);
  });

  it("an answer holds ids, kinds, times and counts only: a body, a label or a cite is refused", () => {
    expect(accepts(RecordReads, { records: [entry], more: false })).toBe(true);
    expect(
      accepts(RecordReads, {
        records: [{ ...entry, supersededBy: `rec_${"1".repeat(26)}`, erased: true, readers: [] }],
        more: true,
      }),
    ).toBe(true);
    for (const key of ["body", "compartments", "cites", "label"])
      expect(accepts(RecordReads, { records: [{ ...entry, [key]: "x" }], more: false }), key).toBe(false);
    expect(
      accepts(RecordReads, { records: [{ ...entry, readers: [{ ...entry.readers[0], body: "x" }] }], more: false }),
    ).toBe(false);
    expect(
      accepts(RecordReads, { records: [{ ...entry, readers: [{ ...entry.readers[0], count: 0 }] }], more: false }),
    ).toBe(false);
    expect(accepts(RecordReads, { records: [{ ...entry, kind: "proposal" }], more: false })).toBe(false);
    expect(
      accepts(RecordReads, { records: Array.from({ length: RECORD_READS_LISTED + 1 }, () => entry), more: true }),
    ).toBe(false);
  });
});

describe("context packs", () => {
  it("build_context_pack refuses meeting_prep with no event, agent_bootstrap with an event, an unknown purpose and an unknown field", () => {
    expect(accepts(BuildContextPackArgs, { purpose: "agent_bootstrap" })).toBe(true);
    expect(accepts(BuildContextPackArgs, { purpose: "meeting_prep", event: `evt_${ULID}` })).toBe(true);
    expect(accepts(BuildContextPackArgs, { purpose: "meeting_prep" })).toBe(false);
    // project_brief takes a project, and only it.
    expect(accepts(BuildContextPackArgs, { purpose: "project_brief", project: `ent_${ULID}` })).toBe(true);
    expect(accepts(BuildContextPackArgs, { purpose: "project_brief" })).toBe(false);
    expect(accepts(BuildContextPackArgs, { purpose: "project_brief", entity: `ent_${ULID}` })).toBe(false);
    expect(accepts(BuildContextPackArgs, { purpose: "agent_bootstrap", project: `ent_${ULID}` })).toBe(false);
    expect(accepts(BuildContextPackArgs, { purpose: "agent_bootstrap", event: `evt_${ULID}` })).toBe(false);
    expect(accepts(BuildContextPackArgs, { purpose: "person_brief" })).toBe(false);
    expect(accepts(BuildContextPackArgs, { purpose: "agent_bootstrap", label: "own" })).toBe(false);
    expect(PersonalToolArgs.build_context_pack).toBe(BuildContextPackArgs);
    expect(PersonalContextPackPurpose.options).toEqual([
      "agent_bootstrap",
      "meeting_prep",
      "person_brief",
      "project_brief",
    ]);
    expect(PACK_VIEW).toEqual({
      agent_bootstrap: "self",
      meeting_prep: "people",
      person_brief: "people",
      project_brief: "work",
    });
  });

  it("person_brief takes an entity and refuses an event; every other purpose refuses an entity", () => {
    expect(accepts(BuildContextPackArgs, { purpose: "person_brief", entity: `ent_${ULID}` })).toBe(true);
    expect(accepts(BuildContextPackArgs, { purpose: "person_brief", event: `evt_${ULID}` })).toBe(false);
    expect(
      accepts(BuildContextPackArgs, { purpose: "person_brief", entity: `ent_${ULID}`, event: `evt_${ULID}` }),
    ).toBe(false);
    expect(accepts(BuildContextPackArgs, { purpose: "person_brief", entity: `evt_${ULID}` })).toBe(false);
    expect(
      accepts(BuildContextPackArgs, { purpose: "meeting_prep", event: `evt_${ULID}`, entity: `ent_${ULID}` }),
    ).toBe(false);
    expect(accepts(BuildContextPackArgs, { purpose: "agent_bootstrap", entity: `ent_${ULID}` })).toBe(false);
  });

  it("its input schema has type object and additionalProperties false", () => {
    const schema = z.toJSONSchema(BuildContextPackArgs, { io: "input" }) as {
      type?: string;
      additionalProperties?: boolean;
    };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("a pack item refuses a bare string where evidence text goes", () => {
    for (const one of items) expect(accepts(PackItem, one), one.kind).toBe(true);
    const [address, met, , attendee, message, written] = items;
    expect(accepts(PackItem, { ...address, value: "owner@example.org" })).toBe(false);
    expect(accepts(PackItem, { ...met, meeting: { ...meeting, title: "Review" } })).toBe(false);
    expect(
      accepts(PackItem, {
        ...attendee,
        attendee: { ...(attendee as { attendee: object }).attendee, who: { ...who, name: "Alex Example" } },
      }),
    ).toBe(false);
    expect(accepts(PackItem, { ...message, message: { ...summary, subject: "Notes" } })).toBe(false);
    expect(accepts(PackItem, { ...written, record: { ...record, body: "Next: reply to Alex." } })).toBe(false);
  });

  it("a pack item refuses a section or a provenance outside the lists, and a missing as-of time", () => {
    const [address] = items;
    expect(accepts(PackItem, { ...address, section: "beliefs" })).toBe(false);
    expect(accepts(PackItem, { ...address, provenance: "agent" })).toBe(false);
    const { asOf: _gone, ...noTime } = address as Record<string, unknown>;
    expect(accepts(PackItem, noTime)).toBe(false);
  });

  it("a meeting item carries cut, and refuses to go without it", () => {
    const met = items[1] as Record<string, unknown>;
    expect(accepts(PackItem, { ...met, cut: true })).toBe(true);
    const { cut: _gone, ...uncut } = met;
    expect(accepts(PackItem, uncut)).toBe(false);
  });

  it("a pack's hash must be 64 lower-case hex characters", () => {
    expect(accepts(ContextPack, pack)).toBe(true);
    for (const hash of ["0".repeat(63), "0".repeat(65), "A".repeat(64), "g".repeat(64)])
      expect(accepts(ContextPack, { ...pack, hash }), hash).toBe(false);
    expect(accepts(ContextPack, { ...pack, template: "agent_bootstrap" })).toBe(false);
    expect(accepts(ContextPack, { ...pack, extra: 1 })).toBe(false);
  });

  it("an agent record view carries its length, whether it was cut and whether it was removed, and a removed one has a null body", () => {
    expect(accepts(AgentRecordView, { ...record, chars: 4000, cut: true })).toBe(true);
    expect(accepts(AgentRecordView, { ...record, body: null, chars: 0, removed: true })).toBe(true);
    expect(accepts(AgentRecordView, { ...record, removed: true })).toBe(false);
    expect(accepts(AgentRecordView, { ...record, body: null, chars: 3, removed: true })).toBe(false);
    for (const key of ["chars", "cut", "removed"]) {
      const { [key]: _gone, ...rest } = record as Record<string, unknown>;
      expect(accepts(AgentRecordView, rest), key).toBe(false);
    }
    expect(accepts(AttendeeBrief, { who, inbound: -1, outbound: 0, lastAt: null, lastMeetingAt: null })).toBe(false);
  });
});
