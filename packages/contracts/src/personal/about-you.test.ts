import {
  ABOUT_YOU_PIPELINES,
  ACTIVITY_PIPELINE,
  AgentRecordArgs,
  AgentRecordItem,
  AgentWriteKind,
  ANSWER_PIPELINE,
  AnswerOwnerQuestionAck,
  AnswerOwnerQuestionArgs,
  AnswerOwnerQuestionPublished,
  answerOf,
  channelled,
  claimTierOf,
  ImportMemoryAck,
  ImportMemoryArgs,
  isLegacy,
  MemoryChange,
  MemoryImportView,
  PackItem,
  PackSection,
  PersonalToolArgs,
  PersonalWriteTool,
  PROPOSAL_PIPELINE,
  ProposeAboutYouAck,
  ProposeAboutYouArgs,
  parseOwnerAnswerBody,
  parseProposalBody,
  QUOTED_PROPOSAL_PIPELINE,
  RestatementAnswer,
  RestatementView,
  TOOL_VIEW,
  TurnId,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// Made-up values only.
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-03-04T10:00:00Z";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const evidence = "a".repeat(64);

// Each kind's domain and key fields.
const goal = {
  kind: "goal",
  fields: { domain: "health", objective: "Run a half marathon this year." },
  scope: "all",
  requestId: "req-0001",
};
const preference = {
  kind: "preference",
  fields: { domain: "career", object: "Morning meetings.", polarity: "avoids" },
  scope: "this_client",
  requestId: "req-0002",
};

describe("agent-lane kinds and proposals", () => {
  it("record still refuses kind proposal: the record tool takes its own kinds", () => {
    const args = { kind: "note", body: "x", requestId: "req-0001" };
    expect(accepts(AgentRecordArgs, args)).toBe(true);
    for (const kind of ["proposal", "memory_change"])
      expect(accepts(AgentRecordArgs, { ...args, kind }), kind).toBe(false);
    expect(AgentWriteKind.options).toEqual([
      "note",
      "finding",
      "handoff",
      "lesson",
      "capability",
      "proposal",
      "memory_change",
      "answer",
      "close",
      "fill",
    ]);
  });

  // Invariant 5: no argument names a channel or a tier, at the top or in the fields.
  it("ProposeAboutYouArgs refuses a subject, a label, a compartment, an origin, a provenance, a channel or a tier field", () => {
    expect(accepts(ProposeAboutYouArgs, goal)).toBe(true);
    for (const key of [
      "subject",
      "label",
      "compartment",
      "compartments",
      "origin",
      "provenance",
      "basis",
      "client",
      "channel",
      "tier",
    ]) {
      expect(accepts(ProposeAboutYouArgs, { ...goal, [key]: "own" }), key).toBe(false);
      expect(accepts(ProposeAboutYouArgs, { ...goal, fields: { ...goal.fields, [key]: "own" } }), `fields.${key}`).toBe(
        false,
      );
    }
    expect(accepts(ProposeAboutYouArgs, { ...goal, tier: "owner" })).toBe(false);
  });

  it("each kind takes its domain and key fields (KEY_FIELDS) and no other's, and never a legacy what", () => {
    const by = "2026-12-31";
    const domain = "career";
    expect(accepts(ProposeAboutYouArgs, { ...goal, fields: { domain, objective: "x", by } })).toBe(true);
    expect(accepts(ProposeAboutYouArgs, { ...goal, kind: "need", fields: { domain, object: "x", by } })).toBe(true);
    expect(accepts(ProposeAboutYouArgs, { ...goal, kind: "need", fields: { domain, objective: "x", by } })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...goal, kind: "capability", fields: { domain, object: "x" } })).toBe(true);
    expect(accepts(ProposeAboutYouArgs, { ...goal, kind: "capability", fields: { domain, object: "x", by } })).toBe(
      false,
    );
    expect(
      accepts(ProposeAboutYouArgs, { ...goal, kind: "constraint", fields: { domain, rule: "x", until: by } }),
    ).toBe(true);
    expect(accepts(ProposeAboutYouArgs, { ...goal, kind: "constraint", fields: { domain, rule: "x", by } })).toBe(
      false,
    );
    expect(
      accepts(ProposeAboutYouArgs, {
        ...goal,
        kind: "situation",
        fields: { domain, state: "x", until: by, momentary: true },
      }),
    ).toBe(true);
    expect(
      accepts(ProposeAboutYouArgs, { ...goal, kind: "situation", fields: { domain, state: "x", momentary: "yes" } }),
    ).toBe(false);
    expect(
      accepts(ProposeAboutYouArgs, { ...goal, kind: "constraint", fields: { domain, rule: "x", momentary: true } }),
    ).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...preference, scope: "all" })).toBe(true);
    // A preference needs its polarity, from the closed list.
    expect(accepts(ProposeAboutYouArgs, { ...preference, fields: { domain, object: "x" } })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...preference, fields: { domain, object: "x", polarity: "loves" } })).toBe(
      false,
    );
    // A date is a date; the domain and the key phrase are required, the domain from the closed list.
    expect(accepts(ProposeAboutYouArgs, { ...goal, fields: { domain, objective: "x", by: "next year" } })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...goal, fields: { objective: "x" } })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...goal, fields: { domain } })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...goal, fields: { domain: "hobbies", objective: "x" } })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...goal, fields: {} })).toBe(false);
    // The legacy shape is read from a stored body, never taken.
    expect(accepts(ProposeAboutYouArgs, { ...goal, fields: { what: "x" } })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...goal, fields: { domain, objective: "x", what: "x" } })).toBe(false);
    // The owner's kinds only: a role or a commitment is not one.
    for (const kind of ["role", "commitment", "consent"])
      expect(accepts(ProposeAboutYouArgs, { ...goal, kind }), kind).toBe(false);
  });

  it("its JSON schema is one object that refuses other properties: what a tool's input schema must be", () => {
    const schema = ProposeAboutYouArgs.toJSONSchema({ io: "input" }) as {
      type?: string;
      additionalProperties?: unknown;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    // A statement, or the older kind and fields; requestId alone is required.
    expect(schema.required).toEqual(["requestId"]);
    const memory = ImportMemoryArgs.toJSONSchema({ io: "input" }) as { type?: string; additionalProperties?: unknown };
    expect([memory.type, memory.additionalProperties]).toEqual(["object", false]);
  });

  it("this_client with goal is refused, with preference accepted", () => {
    expect(accepts(ProposeAboutYouArgs, preference)).toBe(true);
    expect(accepts(ProposeAboutYouArgs, { ...goal, scope: "this_client" })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...goal, scope: "everyone" })).toBe(false);
  });

  it("a key phrase of 501 code points is refused", () => {
    const fields = (objective: string) => ({ domain: "health", objective });
    expect(accepts(ProposeAboutYouArgs, { ...goal, fields: fields("a".repeat(500)) })).toBe(true);
    expect(accepts(ProposeAboutYouArgs, { ...goal, fields: fields("\u{1F600}".repeat(500)) })).toBe(true);
    expect(accepts(ProposeAboutYouArgs, { ...goal, fields: fields("a".repeat(501)) })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...goal, fields: fields("") })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...goal, fields: fields("a\u0000b") })).toBe(false);
  });

  it("a quote is 1 to 1 000 code points, and cites are record's", () => {
    expect(accepts(ProposeAboutYouArgs, { ...goal, quote: "a".repeat(1000) })).toBe(true);
    expect(accepts(ProposeAboutYouArgs, { ...goal, quote: "a".repeat(1001) })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...goal, quote: "" })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...goal, cites: [`msg_${ULID}`, `evt_${ULID}`] })).toBe(true);
    expect(accepts(ProposeAboutYouArgs, { ...goal, cites: [`msg_${ULID}`, `msg_${ULID}`] })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...goal, cites: [`ent_${ULID}`] })).toBe(false);
    expect(accepts(ProposeAboutYouArgs, { ...goal, requestId: "short" })).toBe(false);
  });

  it("the ack is the record id alone, and the answers are four", () => {
    expect(accepts(ProposeAboutYouAck, { recordId: `rec_${ULID}` })).toBe(true);
    expect(accepts(ProposeAboutYouAck, { recordId: `rec_${ULID}`, scope: "all" })).toBe(false);
    expect(RestatementAnswer.options).toEqual(["echo", "stale", "undecided", "new"]);
    expect(accepts(TurnId, `trn_${ULID}`)).toBe(true);
    expect(accepts(TurnId, `rec_${ULID}`)).toBe(false);
  });

  it("AgentRecordItem with memory is valid only for kind memory_change, with or without an entry time", () => {
    const item = {
      recordId: `rec_${ULID}`,
      client: "hermes",
      session: `ses_${ULID}`,
      kind: "note",
      recordedAt: at,
      cites: [evidence],
    };
    const memory = { entryTime: at, change: "added" };
    expect(accepts(AgentRecordItem, item)).toBe(true);
    expect(accepts(AgentRecordItem, { ...item, kind: "proposal" })).toBe(true);
    expect(accepts(AgentRecordItem, { ...item, kind: "memory_change", cites: [], memory })).toBe(true);
    // MemoryChange's entryTime is optional, so an item made from a change without one is valid.
    expect(accepts(AgentRecordItem, { ...item, kind: "memory_change", cites: [], memory: { change: "added" } })).toBe(
      true,
    );
    expect(accepts(AgentRecordItem, { ...item, kind: "memory_change", cites: [] })).toBe(false);
    expect(accepts(AgentRecordItem, { ...item, memory })).toBe(false);
    expect(accepts(AgentRecordItem, { ...item, kind: "memory_change", memory: { ...memory, change: "removed" } })).toBe(
      false,
    );
    // A turn only on a proposal.
    expect(accepts(AgentRecordItem, { ...item, kind: "proposal", turn: `trn_${ULID}` })).toBe(true);
    expect(accepts(AgentRecordItem, { ...item, turn: `trn_${ULID}` })).toBe(false);
  });
});

describe("memory changes and owner views", () => {
  const added = {
    requestId: "AAAAAAAAAAAAAAAAAAAAAA",
    locator: "/home/x/memory/notes.md#1",
    change: "added",
    entryTime: at,
    body: "A remembered line.",
  };
  const removed = { requestId: "BBBBBBBBBBBBBBBBBBBBBB", locator: "/home/x/memory/notes.md#2", change: "removed" };

  it("a removed change with a body is refused, an added one without is refused", () => {
    expect(accepts(MemoryChange, added)).toBe(true);
    expect(accepts(MemoryChange, removed)).toBe(true);
    expect(accepts(MemoryChange, { ...removed, body: "x" })).toBe(false);
    expect(accepts(MemoryChange, { ...added, body: undefined })).toBe(false);
    expect(accepts(MemoryChange, { ...added, body: "a".repeat(8001) })).toBe(false);
    expect(accepts(MemoryChange, { ...added, locator: "a".repeat(513) })).toBe(false);
    expect(accepts(MemoryChange, { ...added, label: "own" })).toBe(false);
  });

  it("51 changes are refused", () => {
    expect(accepts(ImportMemoryArgs, { changes: Array.from({ length: 50 }, () => removed) })).toBe(true);
    expect(accepts(ImportMemoryArgs, { changes: Array.from({ length: 51 }, () => removed) })).toBe(false);
    expect(accepts(ImportMemoryArgs, { changes: [] })).toBe(false);
  });

  it("ImportMemoryAck holds one integer and nothing else", () => {
    expect(accepts(ImportMemoryAck, { received: 3 })).toBe(true);
    expect(accepts(ImportMemoryAck, { received: 1.5 })).toBe(false);
    expect(accepts(ImportMemoryAck, { received: 3, refused: 1 })).toBe(false);
  });

  it("PersonalToolArgs and TOOL_VIEW are unchanged: the write tools need no view and take no read arguments", () => {
    expect(PersonalWriteTool.options).toContain("propose_about_you");
    for (const tool of PersonalWriteTool.options) {
      expect(tool in TOOL_VIEW, tool).toBe(false);
      expect(tool in PersonalToolArgs, tool).toBe(false);
    }
  });

  it("a preference pack item's what is an UntrustedString", () => {
    const item = {
      id: `rec_${ULID}`,
      section: "preferences",
      required: false,
      provenance: "owner",
      asOf: at,
      kind: "preference",
      what: { untrusted: "Morning meetings." },
      polarity: "avoids",
      confirmedAt: at,
    };
    expect(PackSection.options).toContain("preferences");
    expect(accepts(PackItem, item)).toBe(true);
    expect(accepts(PackItem, { ...item, what: "Morning meetings." })).toBe(false);
    expect(accepts(PackItem, { ...item, id: `msg_${ULID}` })).toBe(false);
    expect(accepts(PackItem, { ...item, polarity: "loves" })).toBe(false);
  });

  it("the owner's views hold ids, codes, counts and times", () => {
    const row = {
      id: 1,
      client: "hermes",
      recordId: `rec_${ULID}`,
      claimKeyPrefix: "0123456789abcdef",
      answer: "echo",
      reached: "read",
      checkedAt: at,
      clearedAt: null,
    };
    expect(accepts(RestatementView, [row, { ...row, id: 2, answer: "new", reached: null }])).toBe(true);
    expect(accepts(RestatementView, [{ ...row, claimKeyPrefix: "0123456789abcdef0" }])).toBe(false);
    expect(accepts(RestatementView, [{ ...row, reached: null }])).toBe(false);
    expect(accepts(RestatementView, [{ ...row, answer: "new" }])).toBe(false);
    expect(accepts(RestatementView, [{ ...row, body: "x" }])).toBe(false);
    const client = {
      client: `cli_${ULID}`,
      name: "hermes",
      marks: { new: 1, echo: 2, stale: 0, refused: 0 },
      latestAt: at,
    };
    expect(accepts(MemoryImportView, { clients: [client] })).toBe(true);
    expect(
      accepts(MemoryImportView, {
        clients: [{ ...client, latestAt: null, marks: { new: 0, echo: 0, stale: 0, refused: 0 } }],
      }),
    ).toBe(true);
    expect(accepts(MemoryImportView, { clients: [{ ...client, locator: "x" }] })).toBe(false);
    expect(accepts(MemoryImportView, { clients: [{ ...client, marks: { ...client.marks, new: -1 } }] })).toBe(false);
  });
});

describe("parseProposalBody", () => {
  const PREFERENCE = {
    kind: "preference",
    fields: { domain: "travel", object: "window seats on long flights", polarity: "prefers" },
    scope: "all",
  };
  // A body stored before typed key fields, with one `what` and no domain.
  const LEGACY = {
    kind: "preference",
    fields: { polarity: "prefers", what: "window seats on long flights" },
    scope: "all",
  };
  it("parses the canonical body and refuses one with a requestId, a field the arguments do not have, or no object", () => {
    expect(parseProposalBody(JSON.stringify(PREFERENCE))).toEqual(PREFERENCE);
    expect(parseProposalBody(JSON.stringify({ ...PREFERENCE, requestId: "abcdefgh" }))).toBeNull();
    expect(parseProposalBody(JSON.stringify({ ...PREFERENCE, label: ["own"] }))).toBeNull();
    expect(parseProposalBody(JSON.stringify({ ...PREFERENCE, tier: "owner" }))).toBeNull();
    expect(
      parseProposalBody(
        JSON.stringify({ kind: "goal", fields: { domain: "health", objective: "x" }, scope: "this_client" }),
      ),
    ).toBeNull();
    expect(parseProposalBody("[]")).toBeNull();
    expect(parseProposalBody("not json")).toBeNull();
  });

  it("still reads a stored legacy body, and isLegacy tells the two apart", () => {
    const legacy = parseProposalBody(JSON.stringify(LEGACY));
    expect(legacy).toEqual(LEGACY);
    expect(legacy === null ? null : isLegacy(legacy)).toBe(true);
    const current = parseProposalBody(JSON.stringify(PREFERENCE));
    expect(current === null ? null : isLegacy(current)).toBe(false);
    // A legacy body is held to its own rules, and never mixes with the new shape.
    expect(parseProposalBody(JSON.stringify({ kind: "goal", fields: { what: "x" }, scope: "this_client" }))).toBeNull();
    expect(parseProposalBody(JSON.stringify({ ...LEGACY, fields: { ...LEGACY.fields, domain: "travel" } }))).toBeNull();
    expect(parseProposalBody(JSON.stringify({ ...LEGACY, requestId: "abcdefgh" }))).toBeNull();
  });
});

describe("claimTierOf and channelled", () => {
  const signals = {
    origin: "agent_record" as const,
    pipelineVersion: QUOTED_PROPOSAL_PIPELINE,
    basis: "third_party",
    ownerSaid: false,
    confirmed: true,
  };
  it("an agent's claim is agent_inferred until confirmed; then owner when the owner's words were relayed, owner_relayed for their answer, else owner_confirmed", () => {
    expect(claimTierOf({ ...signals, confirmed: false })).toBe("agent_inferred");
    expect(claimTierOf(signals)).toBe("owner");
    // An answer to an agent's question ranks below the owner's card confirmations, at its own tier.
    expect(claimTierOf({ ...signals, pipelineVersion: ANSWER_PIPELINE, basis: "explicit_self" })).toBe("owner_relayed");
    // A legacy answer's claim: the proposal pipeline with the basis only an answer has.
    expect(claimTierOf({ ...signals, pipelineVersion: PROPOSAL_PIPELINE, basis: "explicit_self" })).toBe(
      "owner_relayed",
    );
    // An unquoted proposal, a legacy quoted one, and a confirmed finding.
    expect(claimTierOf({ ...signals, pipelineVersion: PROPOSAL_PIPELINE })).toBe("owner_confirmed");
    expect(claimTierOf({ ...signals, pipelineVersion: "personal-correspondence-3" })).toBe("owner_confirmed");
    for (const pipelineVersion of ABOUT_YOU_PIPELINES)
      expect(claimTierOf({ ...signals, pipelineVersion, confirmed: false }), pipelineVersion).toBe("agent_inferred");
  });

  // A quote the owner's standing release kept, not their answer, takes the one granted-release tier, never
  // owner; unkept, it is an agent's.
  it("a quoted proposal the owner's standing release kept is researched, never owner", () => {
    expect(claimTierOf({ ...signals, granted: true })).toBe("researched");
    expect(claimTierOf({ ...signals, granted: true, confirmed: false })).toBe("agent_inferred");
    expect(claimTierOf({ ...signals, granted: false })).toBe("owner");
  });

  it("a source's claim is the owner's when they said it, owner_confirmed when they confirmed it on its card, else source", () => {
    const source = {
      ...signals,
      origin: "source" as const,
      pipelineVersion: "personal-correspondence-3",
      confirmed: false,
    };
    expect(claimTierOf(source)).toBe("source");
    expect(claimTierOf({ ...source, ownerSaid: true })).toBe("owner");
    expect(claimTierOf({ ...source, ownerSaid: true, confirmed: true })).toBe("owner_confirmed");
    // A source claim cannot borrow an agent's pipeline version to rank as the owner's.
    expect(claimTierOf({ ...source, pipelineVersion: QUOTED_PROPOSAL_PIPELINE })).toBe("source");
  });

  it("a source claim of ACTIVITY_PIPELINE is observed, and no basis makes any other claim observed", () => {
    const source = {
      ...signals,
      origin: "source" as const,
      pipelineVersion: ACTIVITY_PIPELINE,
      basis: "system_observed",
      confirmed: false,
    };
    expect(ACTIVITY_PIPELINE).toBe("lens-activity-1");
    expect(claimTierOf(source)).toBe("observed");
    expect(claimTierOf({ ...source, basis: "third_party" })).toBe("observed");
    expect(claimTierOf({ ...source, confirmed: true })).toBe("owner_confirmed");
    // A stored mail or document claim that carries system_observed stays a source's.
    for (const pipelineVersion of [
      "personal-correspondence-3",
      "personal-document-1",
      "lens-participants-1",
      "lens-link-1",
    ]) {
      expect(claimTierOf({ ...source, pipelineVersion }), pipelineVersion).toBe("source");
    }
    // An agent's record cannot borrow the activity pipeline.
    expect(claimTierOf({ ...source, origin: "agent_record" })).toBe("agent_inferred");
    expect(claimTierOf({ ...source, origin: "agent_record", confirmed: true })).toBe("owner_confirmed");
  });

  it("channelled names the quoted proposal, the answer and the legacy answer, and nothing else", () => {
    expect(channelled({ pipelineVersion: QUOTED_PROPOSAL_PIPELINE, basis: "third_party" })).toBe(true);
    expect(channelled({ pipelineVersion: ANSWER_PIPELINE, basis: "explicit_self" })).toBe(true);
    expect(channelled({ pipelineVersion: PROPOSAL_PIPELINE, basis: "explicit_self" })).toBe(true);
    expect(channelled({ pipelineVersion: PROPOSAL_PIPELINE, basis: "third_party" })).toBe(false);
    expect(channelled({ pipelineVersion: "personal-correspondence-3", basis: "explicit_self" })).toBe(false);
  });
});

describe("the owner's answers", () => {
  const opportunity = `opp_${ULID}`;
  const answer = {
    quote: "John runs the robotics lab I want to visit; I prefer to meet him in person.",
    facts: [
      { kind: "preference", fields: { domain: "relationships", object: "meet him in person", polarity: "prefers" } },
    ],
    about: "supports",
  };
  const args = { opportunity, answer, requestId: "req-0001" };

  it("AnswerOwnerQuestionArgs takes a quote and an effect, and nothing that names a label, a scope, a provenance, a channel or a tier", () => {
    expect(accepts(AnswerOwnerQuestionArgs, args)).toBe(true);
    expect(accepts(AnswerOwnerQuestionArgs, { ...args, answer: { quote: "I do not know him." } })).toBe(true);
    // A deprecated `facts`, of any shape, parses; answerOf drops it, and the published schema
    // leaves it out.
    expect(
      accepts(AnswerOwnerQuestionArgs, {
        ...args,
        answer: { ...answer, facts: [{ ...answer.facts[0], tier: "owner" }] },
      }),
    ).toBe(true);
    expect(answerOf({ ...args, answer: { ...answer, about: "supports" } } as AnswerOwnerQuestionArgs)).toEqual({
      quote: answer.quote,
      about: "supports",
    });
    expect(accepts(AnswerOwnerQuestionPublished, args)).toBe(false);
    expect(accepts(AnswerOwnerQuestionPublished, { ...args, answer: { quote: answer.quote } })).toBe(true);
    for (const key of ["label", "compartments", "scope", "provenance", "basis", "subject", "channel", "tier"]) {
      expect(accepts(AnswerOwnerQuestionArgs, { ...args, [key]: "own" }), key).toBe(false);
      expect(accepts(AnswerOwnerQuestionArgs, { ...args, answer: { ...answer, [key]: "own" } }), `answer.${key}`).toBe(
        false,
      );
    }
    expect(accepts(AnswerOwnerQuestionArgs, { ...args, opportunity: `hyp_${ULID}` })).toBe(false);
    expect(accepts(AnswerOwnerQuestionArgs, { ...args, answer: { ...answer, quote: "" } })).toBe(false);
    expect(accepts(AnswerOwnerQuestionArgs, { ...args, answer: { ...answer, quote: "x".repeat(8001) } })).toBe(false);
    expect(accepts(AnswerOwnerQuestionArgs, { ...args, answer: { ...answer, about: "maybe" } })).toBe(false);
    expect(accepts(AnswerOwnerQuestionAck, { recordId: `rec_${ULID}` })).toBe(true);
  });

  it("parseOwnerAnswerBody parses the stored body and refuses anything else", () => {
    const body = { opportunity, question: "What do you know about John?", ...answer };
    expect(parseOwnerAnswerBody(JSON.stringify(body))).toEqual(body);
    expect(parseOwnerAnswerBody(JSON.stringify({ ...body, question: null }))).toEqual({ ...body, question: null });
    expect(parseOwnerAnswerBody(JSON.stringify({ ...body, requestId: "req-0001" }))).toBeNull();
    expect(parseOwnerAnswerBody(JSON.stringify({ ...body, opportunity: undefined }))).toBeNull();
    expect(parseOwnerAnswerBody("not json")).toBeNull();
  });

  it("parseOwnerAnswerBody still reads a stored body of legacy facts", () => {
    const legacy = {
      opportunity,
      question: null,
      ...answer,
      facts: [{ kind: "preference", fields: { what: "meet him in person", polarity: "prefers" } }],
    };
    expect(parseOwnerAnswerBody(JSON.stringify(legacy))).toEqual(legacy);
    expect(
      parseOwnerAnswerBody(JSON.stringify({ ...legacy, facts: [{ kind: "preference", fields: { what: "x" } }] })),
    ).toBeNull();
  });
});
