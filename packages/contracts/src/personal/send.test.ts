import { GateCheckKind } from "@intelligence/contracts";
import {
  ClientRegistration,
  ContactCandidate,
  DECISION_DETAILS,
  DraftMessageArgs,
  DraftMessageResult,
  GATE_CAUSE_CHECK,
  GateCause,
  GateFacts,
  GateInput,
  GateOutcome,
  PersonalLogEvent,
  PersonalProposeTool,
  PersonalTool,
  RevealedClaim,
  RevealedContact,
  SEND_TOOL_VIEW,
  SendPayload,
  SendResult,
  sendAddress,
  TOOL_VIEW,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// The send proxy. Made-up values on reserved domains only.
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const payload = {
  v: 1,
  account: `acc_${ULID}`,
  to: ["alex@example.com"],
  cc: [],
  subject: "Re: Notes",
  body: "Thanks.\n\tSee you then.",
  thread: { id: "18c0ffee30", inReplyTo: "<b1@example.com>", references: ["<a1@example.com>", "<b1@example.com>"] },
};
const draft = { to: ["alex@example.com"], subject: "Notes", body: "Hello.", requestId: "req-0001" };
const facts = {
  draft: {
    found: true,
    tainted: false,
    status: "new",
    ageSeconds: 0,
    withinCap: true,
    consentFree: true,
    authorCurrent: true,
    disclosureOnly: false,
  },
  account: { connected: true, own: true, copyMissing: false, syncAgeSeconds: 60 },
  recipients: { count: 1, vetoed: 0, suppressed: 0, firstContact: 0 },
  about: { vetoed: false },
  basis: { missing: 0, tainted: 0, flagged: 0, unscreened: 0 },
  beliefs: { changed: 0 },
  thread: { isNew: false, found: true, newer: 0 },
  sent: { already: false },
  work: { named: false, go: false, open: false, tainted: false },
  killSwitch: false,
};

describe("sendAddress", () => {
  it("refuses a name with an address in angle brackets, an address with a line break and a second address after it, one with a comma, one with a letter outside ASCII in its domain, one with a space, and one that starts with an escape character", () => {
    for (const text of [
      "Alex <alex@example.com>",
      "alex@example.com\r\nbcc@example.com",
      "alex@example.com,bcc@example.com",
      "alex@exämple.com",
      "alex @example.com",
      "\u001balex@example.com",
      " alex@example.com",
    ]) {
      expect(sendAddress(text), JSON.stringify(text)).toBeNull();
    }
  });

  it("it refuses a quoted local part, two dots together, a local part of 65 characters, an address of 255 characters, a domain of one label and a last label with a digit", () => {
    expect(sendAddress(`${"a".repeat(64)}@example.com`)).not.toBeNull();
    const long = `${"a".repeat(60)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}.com`;
    expect(long.length).toBe(254);
    expect(sendAddress(long)).toBe(long);
    for (const text of [
      '"alex"@example.com',
      "alex..b@example.com",
      ".alex@example.com",
      `${"a".repeat(65)}@example.com`,
      `${long}m`,
      "alex@localhost",
      "alex@example.c0m",
      "alex@-example.com",
      `alex@${"b".repeat(64)}.com`,
    ]) {
      expect(sendAddress(text), text).toBeNull();
    }
  });

  it("it returns an upper-case address in lower case, and trims nothing", () => {
    expect(sendAddress("Alex.Example+notes@Example.COM")).toBe("alex.example+notes@example.com");
    expect(sendAddress("alex@example.com ")).toBeNull();
  });
});

describe("send contracts", () => {
  it("a payload refuses an address that is not in sendAddress's form, an address twice, and eleven recipients", () => {
    expect(accepts(SendPayload, payload)).toBe(true);
    expect(accepts(SendPayload, { ...payload, to: ["Alex@example.com"] })).toBe(false);
    expect(accepts(SendPayload, { ...payload, to: ["Alex <alex@example.com>"] })).toBe(false);
    expect(accepts(SendPayload, { ...payload, cc: ["alex@example.com"] })).toBe(false);
    const ten = Array.from({ length: 10 }, (_, i) => `p${i}@example.com`);
    expect(accepts(SendPayload, { ...payload, to: ten })).toBe(true);
    expect(accepts(SendPayload, { ...payload, to: ten, cc: ["q@example.com"] })).toBe(false);
    expect(accepts(SendPayload, { ...payload, to: [] })).toBe(false);
    expect(accepts(SendPayload, { ...payload, bcc: [] })).toBe(false);
  });

  it("a draft's arguments refuse the same addresses", () => {
    expect(accepts(DraftMessageArgs, draft)).toBe(true);
    // Upper case is taken here: the provider lowers it with sendAddress.
    expect(accepts(DraftMessageArgs, { ...draft, to: ["Alex@Example.com"] })).toBe(true);
    expect(accepts(DraftMessageArgs, { ...draft, to: ["Alex <alex@example.com>"] })).toBe(false);
    expect(accepts(DraftMessageArgs, { ...draft, cc: ["ALEX@example.com"] })).toBe(false);
    const ten = Array.from({ length: 10 }, (_, i) => `p${i}@example.com`);
    expect(accepts(DraftMessageArgs, { ...draft, to: ten, cc: ["q@example.com"] })).toBe(false);
  });

  it("a payload's body refuses an escape sequence, a carriage return, a C1 control, a bidirectional control and an unpaired surrogate, and accepts line feeds and tabs", () => {
    for (const bad of ["\u001b[31m", "a\rb", "a\u0085b", "a‮b", "a⁦b", "a\ud800b", "a\udc00b", "a\u007fb"]) {
      expect(accepts(SendPayload, { ...payload, body: bad }), JSON.stringify(bad)).toBe(false);
    }
    expect(accepts(SendPayload, { ...payload, body: "line\nline\ttab \u{1F600}" })).toBe(true);
    expect(accepts(SendPayload, { ...payload, body: "a".repeat(20_001) })).toBe(false);
  });

  it("a subject refuses a line feed and a tab as well", () => {
    expect(accepts(SendPayload, { ...payload, subject: "a\nb" })).toBe(false);
    expect(accepts(SendPayload, { ...payload, subject: "a\tb" })).toBe(false);
    expect(accepts(SendPayload, { ...payload, subject: "a".repeat(201) })).toBe(false);
    expect(accepts(DraftMessageArgs, { ...draft, subject: "a\nBcc: x@example.com" })).toBe(false);
  });

  it("a thread id, an In-Reply-To or a reference with a space, a control character or a letter outside ASCII is refused", () => {
    for (const bad of ["a b", "a\u0001", "räf", ""]) {
      expect(accepts(SendPayload, { ...payload, thread: { ...payload.thread, id: bad } }), `id ${bad}`).toBe(false);
      expect(
        accepts(SendPayload, { ...payload, thread: { ...payload.thread, inReplyTo: bad } }),
        `in-reply-to ${bad}`,
      ).toBe(false);
      expect(
        accepts(SendPayload, { ...payload, thread: { ...payload.thread, references: [bad] } }),
        `reference ${bad}`,
      ).toBe(false);
    }
    expect(accepts(SendPayload, { ...payload, thread: null })).toBe(true);
  });

  it("a draft's arguments refuse a key named label, compartment, author, thread, header or from", () => {
    for (const key of ["label", "compartment", "author", "thread", "header", "from"])
      expect(accepts(DraftMessageArgs, { ...draft, [key]: "x" }), key).toBe(false);
  });

  it("without replyTo, to and subject are required", () => {
    const { to: _to, ...noTo } = draft;
    const { subject: _subject, ...noSubject } = draft;
    expect(accepts(DraftMessageArgs, noTo)).toBe(false);
    expect(accepts(DraftMessageArgs, noSubject)).toBe(false);
    expect(accepts(DraftMessageArgs, { ...draft, to: [] })).toBe(false);
    expect(accepts(DraftMessageArgs, { ...draft, to: [], cc: ["alex@example.com"] })).toBe(false);
    expect(accepts(DraftMessageArgs, { body: "Thanks.", replyTo: `msg_${ULID}`, requestId: "req-0001" })).toBe(true);
  });

  it("with replyTo, a subject is refused", () => {
    expect(
      accepts(DraftMessageArgs, {
        body: "Thanks.",
        replyTo: `msg_${ULID}`,
        subject: "Re: Notes",
        requestId: "req-0001",
      }),
    ).toBe(false);
  });

  it("a draft result has one key", () => {
    expect(accepts(DraftMessageResult, { draft: `drf_${ULID}` })).toBe(true);
    expect(accepts(DraftMessageResult, { draft: `drf_${ULID}`, held: true })).toBe(false);
    expect(accepts(DraftMessageResult, { draft: `snt_${ULID}` })).toBe(false);
  });

  it("gate facts refuse a string where a count belongs", () => {
    expect(accepts(GateFacts, facts)).toBe(true);
    expect(accepts(GateFacts, { ...facts, recipients: { ...facts.recipients, count: "1" } })).toBe(false);
    expect(accepts(GateFacts, { ...facts, basis: { ...facts.basis, flagged: -1 } })).toBe(false);
    expect(accepts(GateFacts, { ...facts, draft: { ...facts.draft, status: "waiting" } })).toBe(false);
    expect(accepts(GateFacts, { ...facts, draft: { ...facts.draft, id: `drf_${ULID}` } })).toBe(false);
    // The keys are in the gate table's order, so equal facts are equal bytes.
    expect(Object.keys(GateFacts.parse(facts))).toEqual([
      "draft",
      "account",
      "recipients",
      "about",
      "basis",
      "beliefs",
      "thread",
      "sent",
      "work",
      "killSwitch",
    ]);
    const input = { phase: "draft", facts, revealed: 0, released: 0, computedFp: "a", storedFp: "a" };
    expect(accepts(GateInput, input)).toBe(true);
    expect(accepts(GateInput, { ...input, released: 1 })).toBe(false);
    expect(accepts(GateInput, { ...input, phase: "send", released: 1 })).toBe(true);
  });

  it("a revealed claim has no key that could hold text", () => {
    expect(accepts(RevealedClaim, { id: "c1", tie: "text_value", valueIndex: 0 })).toBe(true);
    expect(accepts(RevealedClaim, { id: "c1", tie: "cited_item", valueIndex: null })).toBe(true);
    for (const key of ["text", "value", "matched"])
      expect(accepts(RevealedClaim, { id: "c1", tie: "text_value", valueIndex: 0, [key]: "x" }), key).toBe(false);
  });

  it("a contact candidate is strict and its birthday has no year", () => {
    const candidate = {
      id: "con_1",
      names: ["Maren Holt"],
      phones: ["+15555550101"],
      organizations: [{ name: "Holt Ceramics", title: null }],
      birthday: { month: 3, day: 14 },
    };
    expect(accepts(ContactCandidate, candidate)).toBe(true);
    expect(accepts(ContactCandidate, { ...candidate, birthday: null, organizations: [] })).toBe(true);
    expect(accepts(ContactCandidate, { ...candidate, birthday: { month: 3, day: 14, year: 1990 } })).toBe(false);
    expect(accepts(ContactCandidate, { ...candidate, birthday: { month: 13, day: 1 } })).toBe(false);
    expect(accepts(ContactCandidate, { ...candidate, addresses: ["a@example.com"] })).toBe(false);
  });

  it("a revealed contact field names its contact, field and index, and holds no value", () => {
    expect(accepts(RevealedContact, { id: "con_1", field: "phone", index: 0 })).toBe(true);
    expect(accepts(RevealedContact, { id: "con_1", field: "birthday", index: null })).toBe(true);
    expect(accepts(RevealedContact, { id: "con_1", field: "email", index: 0 })).toBe(false);
    for (const key of ["text", "value", "matched"])
      expect(accepts(RevealedContact, { id: "con_1", field: "title", index: 0, [key]: "x" }), key).toBe(false);
  });

  it("every gate cause but cannot_answer belongs to exactly one check", () => {
    const causes = GateCause.options.filter((cause) => cause !== "cannot_answer");
    expect(Object.keys(GATE_CAUSE_CHECK).sort()).toEqual([...causes].sort());
    for (const check of Object.values(GATE_CAUSE_CHECK)) expect(accepts(GateCheckKind, check), check).toBe(true);
    // Every check has a cause, so a failed check can always say why.
    expect(new Set(Object.values(GATE_CAUSE_CHECK))).toEqual(new Set(GateCheckKind.options));
    const checks = Object.fromEntries(GateCheckKind.options.map((check) => [check, true]));
    expect(accepts(GateOutcome, { cleared: true, checks, causes: [] })).toBe(true);
    const { authority: _gone, ...eight } = checks;
    expect(accepts(GateOutcome, { cleared: true, checks: eight, causes: [] })).toBe(false);
    expect(accepts(GateOutcome, { cleared: false, checks, causes: ["looks_odd"] })).toBe(false);
  });

  it("authority names a closed opportunity and a draft held at phase draft", () => {
    expect(GATE_CAUSE_CHECK.work_closed).toBe("authority");
    expect(GATE_CAUSE_CHECK.held_at_draft).toBe("authority");
    expect(accepts(GateFacts, { ...facts, work: { named: true, go: true, tainted: false } })).toBe(false);
  });

  it("the send decision's details are exactly firstContact, newThread and released, released holds ids only, and send_settle's are empty", () => {
    const send = DECISION_DETAILS.send;
    expect(send).toBeDefined();
    if (send === undefined) return;
    expect(accepts(send, { firstContact: true, newThread: false, released: [] })).toBe(true);
    expect(accepts(send, { firstContact: true, newThread: false, released: ["a".repeat(64)] })).toBe(true);
    expect(accepts(send, { firstContact: true, newThread: false, released: ["Alex owes the owner a reply"] })).toBe(
      false,
    );
    expect(accepts(send, { firstContact: true, newThread: false })).toBe(false);
    expect(accepts(send, { firstContact: true, newThread: false, released: [], note: "x" })).toBe(false);
    expect(DECISION_DETAILS.send_settle).toBeUndefined();
  });

  it("the send decision takes releasedContacts only with at least one field, by contact id, field and index, never a value", () => {
    const send = DECISION_DETAILS.send;
    if (send === undefined) throw new Error("no send details");
    const base = { firstContact: false, newThread: false, released: [] };
    const contact = `con_${"0".repeat(26)}`;
    expect(accepts(send, { ...base, releasedContacts: [{ contact, field: "phone", index: 0 }] })).toBe(true);
    expect(accepts(send, { ...base, releasedContacts: [{ contact, field: "birthday", index: null }] })).toBe(true);
    expect(accepts(send, { ...base, releasedContacts: [] })).toBe(false);
    expect(accepts(send, { ...base, releasedContacts: [{ contact: "Maren Holt", field: "phone", index: 0 }] })).toBe(
      false,
    );
    expect(accepts(send, { ...base, releasedContacts: [{ contact, field: "email", index: 0 }] })).toBe(false);
    expect(
      accepts(send, { ...base, releasedContacts: [{ contact, field: "phone", index: 0, value: "555 0100" }] }),
    ).toBe(false);
  });

  it("a send result is one of the three outcomes", () => {
    expect(accepts(SendResult, { outcome: "sent", id: "18c0ffee31", threadId: null })).toBe(true);
    expect(accepts(SendResult, { outcome: "failed", status: 400 })).toBe(true);
    expect(accepts(SendResult, { outcome: "unknown" })).toBe(true);
    expect(accepts(SendResult, { outcome: "queued" })).toBe(false);
  });

  it("the tool lists gain draft_message, TOOL_VIEW does not, and SEND_TOOL_VIEW is exactly { draft_message: work }", () => {
    expect(PersonalProposeTool.options).toEqual(["draft_message"]);
    expect(accepts(PersonalTool, "draft_message")).toBe(true);
    expect("draft_message" in TOOL_VIEW).toBe(false);
    expect(SEND_TOOL_VIEW).toEqual({ draft_message: "work" });
  });

  it("a reasoner registration with draft_message is refused", () => {
    const registration = {
      name: "reasoner",
      runtime: "cloud",
      vendorRetention: "none",
      kind: "reasoner",
      compartments: ["own"],
      views: ["work"],
      tools: ["next_run", "draft_message"],
    };
    expect(accepts(ClientRegistration, registration)).toBe(false);
    expect(accepts(ClientRegistration, { ...registration, kind: "agent", tools: ["draft_message"] })).toBe(true);
  });

  it("the log event takes a draft id and a send id and refuses a name", () => {
    expect(accepts(PersonalLogEvent, { event: "draft_made", ids: { draft: `drf_${ULID}`, send: `snt_${ULID}` } })).toBe(
      true,
    );
    expect(accepts(PersonalLogEvent, { event: "draft_made", ids: { draft: "alex@example.com" } })).toBe(false);
  });
});
