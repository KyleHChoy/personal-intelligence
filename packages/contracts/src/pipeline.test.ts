import { describe, expect, it } from "vitest";
import {
  CheckResult,
  ClaimCandidate,
  EmbeddingRequest,
  InterpreterOutput,
  Mention,
  ModelCallRecord,
  ModelRequest,
  ModelResponse,
  NarrowingValue,
  PipelineConfig,
  Resolution,
  UnmappedClaim,
  UnmappedReason,
} from "./index.ts";
import { candidate, entityPage, label, mention, sha } from "./test-samples.ts";

const RESERVED = ["label", "labels", "readers", "compartments", "destination", "store", "grant", "clearance"];

describe("interpreter output", () => {
  it("accepts claims and a narrowing value", () => {
    expect(InterpreterOutput.safeParse({ claims: [candidate], narrowing: "none" }).success).toBe(true);
  });

  it("rejects an interpreter output with a third key or an unlisted narrowing value", () => {
    expect(InterpreterOutput.safeParse({ claims: [], narrowing: "none", label }).success).toBe(false);
    expect(InterpreterOutput.safeParse({ claims: [], narrowing: "release" }).success).toBe(false);
    expect(InterpreterOutput.safeParse({ claims: [], narrowing: "all_members" }).success).toBe(false);
    expect(InterpreterOutput.safeParse({ claims: [] }).success).toBe(false);
  });

  it("no narrowing value releases an item or widens a label", () => {
    expect([...NarrowingValue.options].sort()).toEqual(["none", "participants_only", "quarantine", "special_category"]);
  });

  it("no model output schema has a label, reader or destination key", () => {
    for (const key of RESERVED) {
      expect(ClaimCandidate.safeParse({ ...candidate, [key]: "people" }).success, key).toBe(false);
      expect(ClaimCandidate.safeParse({ ...candidate, fields: { [key]: "people" } }).success, `fields.${key}`).toBe(
        false,
      );
      expect(Object.keys(ClaimCandidate.shape), key).not.toContain(key);
      expect(Object.keys(InterpreterOutput.shape), key).not.toContain(key);
    }
  });

  it("rejects a reserved key in a candidate's fields at any depth, in any case, singular or plural", () => {
    const keys = [
      "Label",
      "LABELS",
      "reader",
      "Readers",
      "compartment",
      "destinations",
      "Grant",
      "grants",
      "Store",
      "clearances",
    ];
    for (const key of keys) {
      expect(ClaimCandidate.safeParse({ ...candidate, fields: { [key]: "people" } }).success, key).toBe(false);
      expect(
        ClaimCandidate.safeParse({ ...candidate, fields: { role: { [key]: "people" } } }).success,
        `nested ${key}`,
      ).toBe(false);
      expect(
        ClaimCandidate.safeParse({ ...candidate, fields: { roles: [{ detail: { [key]: 1 } }] } }).success,
        `listed ${key}`,
      ).toBe(false);
    }
    expect(ClaimCandidate.safeParse({ ...candidate, fields: { role: "cfo", labelled: true, storey: 2 } }).success).toBe(
      true,
    );
  });

  it("rejects an unknown key inside a candidate's mention or context", () => {
    expect(ClaimCandidate.safeParse({ ...candidate, subject: { ...mention, entity: "e-maya" } }).success).toBe(false);
    expect(ClaimCandidate.safeParse({ ...candidate, context: { kind: "project", id: "e-alder" } }).success).toBe(false);
    expect(ClaimCandidate.safeParse({ ...candidate, context: { kind: "project", mention } }).success).toBe(true);
  });

  it("a mention key is an address, a source id or a name", () => {
    expect(Mention.safeParse(mention).success).toBe(true);
    expect(Mention.safeParse({ ...mention, key: { kind: "crm_id", value: "42" } }).success).toBe(false);
  });

  it("a resolution links, creates, defers or refuses", () => {
    expect(Resolution.safeParse({ outcome: "linked", entity: "e-maya", epoch: 3 }).success).toBe(true);
    expect(Resolution.safeParse({ outcome: "candidate", reviewId: "rv-1" }).success).toBe(true);
    expect(Resolution.safeParse({ outcome: "suppressed" }).success).toBe(true);
    expect(Resolution.safeParse({ outcome: "linked" }).success).toBe(false);
  });

  const unmapped = {
    id: "u-1",
    evidenceId: "ev-1",
    proposedType: "other",
    pipelineVersion: "p-1",
    label,
    reason: "unknown_type",
    extractorGeneration: 0,
    shadow: false,
  };

  it("an unmapped claim carries a reason from the closed list", () => {
    expect([...UnmappedReason.options]).toEqual([
      "unknown_type",
      "bad_fields",
      "bad_span",
      "bad_times",
      "ungrounded_mention",
      "author_unknown",
    ]);
    for (const reason of UnmappedReason.options)
      expect(UnmappedClaim.safeParse({ ...unmapped, reason }).success, reason).toBe(true);
    // The reason is a code, never the model's text, and is not optional.
    const { reason: _reason, ...without } = unmapped;
    expect(UnmappedClaim.safeParse(without).success).toBe(false);
    expect(UnmappedClaim.safeParse({ ...unmapped, reason: "the model named no type" }).success).toBe(false);
    expect(CheckResult.safeParse({ claims: [], unmapped: [unmapped], reviews: [] }).success).toBe(true);
    expect(CheckResult.safeParse({ claims: [], unmapped: [without], reviews: [] }).success).toBe(false);
  });

  it("an unmapped claim names its extractor generation and whether it is a shadow row", () => {
    expect(UnmappedClaim.safeParse(unmapped).success).toBe(true);
    for (const field of Object.keys(unmapped)) {
      const { [field]: _dropped, ...rest } = unmapped as Record<string, unknown>;
      expect(UnmappedClaim.safeParse(rest).success, field).toBe(false);
    }
    expect(UnmappedClaim.safeParse({ ...unmapped, extractorGeneration: -1 }).success).toBe(false);
    expect(UnmappedClaim.safeParse({ ...unmapped, shadow: "no" }).success).toBe(false);
  });

  it("the checker's unmapped claims carry no generation and no shadow mark", () => {
    const { shadow: _shadow, extractorGeneration: _generation, ...checked } = unmapped;
    const parsed = CheckResult.parse({ claims: [], unmapped: [unmapped], reviews: [] });
    // The writer is the one source of both: it sets the generation it runs as and the mark from
    // the commit's mode, so anything the checker gave for either is not kept.
    expect(parsed.unmapped).toEqual([checked]);
    expect(CheckResult.safeParse({ claims: [], unmapped: [checked], reviews: [] }).success).toBe(true);
  });

  it("an unmapped claim's type and pipeline version are plain ids, as the vault's table checks", () => {
    for (const proposedType of [
      "other",
      "invalid",
      "need.hiring",
      "decision.vendor_choice",
      "a",
      `a${"b".repeat(63)}`,
    ]) {
      expect(UnmappedClaim.safeParse({ ...unmapped, proposedType }).success, proposedType).toBe(true);
    }
    // Never the model's own text: a sentence, a name or an address is refused.
    for (const proposedType of [
      "",
      "Need.Hiring",
      "a need for a head of finance",
      "9lives",
      ".hidden",
      "maya@tessel.example",
      `a${"b".repeat(64)}`,
    ]) {
      expect(UnmappedClaim.safeParse({ ...unmapped, proposedType }).success, proposedType).toBe(false);
    }
    for (const pipelineVersion of ["p-1", "0.0.0", "2026.10.1-rc_2", "7"]) {
      expect(UnmappedClaim.safeParse({ ...unmapped, pipelineVersion }).success, pipelineVersion).toBe(true);
    }
    for (const pipelineVersion of ["", "V2", "version two", "-1", "p 1", `1${"0".repeat(64)}`]) {
      expect(UnmappedClaim.safeParse({ ...unmapped, pipelineVersion }).success, pipelineVersion).toBe(false);
    }
    const { shadow: _shadow, extractorGeneration: _generation, ...checked } = unmapped;
    expect(
      CheckResult.safeParse({
        claims: [],
        unmapped: [{ ...checked, proposedType: "a need for a head of finance" }],
        reviews: [],
      }).success,
    ).toBe(false);
  });

  const limits = {
    payloadBytes: 1_048_576,
    payloadLines: 10_000,
    bodyChars: 100_000,
    htmlChars: 400_000,
    htmlDepth: 64,
    htmlTags: 5_000,
    lineChars: 2_000,
    attachments: 10,
    attachmentBytes: 1_048_576,
    segments: 200,
    promptChars: 40_000,
  };
  const config = {
    vault: "team",
    replyChainDepth: 3,
    specialCategoryCompartment: "special",
    gateway: "tg-team",
    limits,
  };

  it("the pipeline configuration names every parse limit, each a positive whole number", () => {
    expect(PipelineConfig.safeParse(config).success).toBe(true);
    const { limits: _limits, ...unbounded } = config;
    expect(PipelineConfig.safeParse(unbounded).success).toBe(false);
    for (const name of Object.keys(limits)) {
      const { [name]: _dropped, ...rest } = limits as Record<string, number>;
      expect(PipelineConfig.safeParse({ ...config, limits: rest }).success, name).toBe(false);
      for (const value of [0, -1, 1.5, "100"]) {
        expect(
          PipelineConfig.safeParse({ ...config, limits: { ...limits, [name]: value } }).success,
          `${name} ${value}`,
        ).toBe(false);
      }
    }
    expect(PipelineConfig.safeParse({ ...config, limits: { ...limits, quoteDepth: 8 } }).success).toBe(false);
  });

  it("rejects an unknown key in the pipeline configuration", () => {
    expect(PipelineConfig.safeParse(config).success).toBe(true);
    expect(PipelineConfig.safeParse({ ...config, replyChainDepth: -1 }).success).toBe(false);
    expect(PipelineConfig.safeParse({ ...config, store: "people" }).success).toBe(false);
  });
});

describe("models", () => {
  const request = { promptId: "interpreter", promptVersion: "1", data: { item: "text" }, label, trustGroup: "tg-team" };
  const call = { id: "call-1", name: "get_entity", args: { entity: "h-1" }, decision: "evidence_check" };
  const tools = [{ name: "get_entity", description: "Read one entity page.", argsSchema: {} }];
  const assistant = { role: "assistant", blocks: [{ type: "tool_call", call }] };
  const result = {
    callId: "call-1",
    outcome: "ok",
    result: { store: "people", tool: "get_entity", label, items: [entityPage] },
  };
  const answer = { role: "tool", blocks: [{ type: "tool_result", result }] };

  it("accepts an interpreter request with no tools", () => {
    expect(ModelRequest.safeParse(request).success).toBe(true);
    expect(ModelRequest.safeParse({ ...request, label: undefined }).success).toBe(false);
    expect(ModelRequest.safeParse({ ...request, temperature: 1 }).success).toBe(false);
  });

  it("a tool result must answer a tool call", () => {
    expect(ModelRequest.safeParse({ ...request, tools, messages: [assistant, answer] }).success).toBe(true);
    expect(ModelRequest.safeParse({ ...request, tools, messages: [answer] }).success).toBe(false);
    const stray = { role: "tool", blocks: [{ type: "tool_result", result: { callId: "call-9", outcome: "refused" } }] };
    expect(ModelRequest.safeParse({ ...request, tools, messages: [assistant, stray] }).success).toBe(false);
    const none = { role: "tool", blocks: [] };
    expect(ModelRequest.safeParse({ ...request, tools, messages: [assistant, none] }).success).toBe(false);
  });

  it("results answer the calls by position, and the call ids of one turn are unique", () => {
    const call = (id: string) => ({
      type: "tool_call",
      call: { id, name: "get_entity", args: { entity: "h-1" }, decision: "candidate_set" },
    });
    const refused = (callId: string) => ({ type: "tool_result", result: { callId, outcome: "refused" } });
    const two = { role: "assistant", blocks: [call("call-1"), call("call-2")] };
    expect(
      ModelRequest.safeParse({
        ...request,
        tools,
        messages: [two, { role: "tool", blocks: [refused("call-1"), refused("call-2")] }],
      }).success,
    ).toBe(true);
    expect(
      ModelRequest.safeParse({
        ...request,
        tools,
        messages: [two, { role: "tool", blocks: [refused("call-2"), refused("call-1")] }],
      }).success,
    ).toBe(false);
    const repeat = { role: "assistant", blocks: [call("call-1"), call("call-1")] };
    expect(
      ModelRequest.safeParse({
        ...request,
        tools,
        messages: [repeat, { role: "tool", blocks: [answer.blocks[0], refused("call-1")] }],
      }).success,
    ).toBe(false);
    expect(
      ModelRequest.safeParse({
        ...request,
        tools,
        messages: [repeat, { role: "tool", blocks: [refused("call-1"), refused("call-1")] }],
      }).success,
    ).toBe(false);
    const rewritten = { role: "assistant", blocks: [call("call-1"), call("call-1:dup:1")] };
    expect(
      ModelRequest.safeParse({
        ...request,
        tools,
        messages: [rewritten, { role: "tool", blocks: [answer.blocks[0], refused("call-1:dup:1")] }],
      }).success,
    ).toBe(true);
    expect(
      ModelRequest.safeParse({
        ...request,
        tools,
        messages: [repeat, { role: "tool", blocks: [refused("call-1"), answer.blocks[0]] }],
      }).success,
    ).toBe(false);
  });

  it("rejects messages without tools", () => {
    expect(ModelRequest.safeParse({ ...request, messages: [assistant, answer] }).success).toBe(false);
  });

  it("a response carries the label and the usage", () => {
    const usage = { inputTokens: 10, outputTokens: 5, cost: 0.01 };
    const response = { output: { claims: [], narrowing: "none" }, label, usage, modelId: "model-1" };
    expect(ModelResponse.safeParse(response).success).toBe(true);
    expect(ModelResponse.safeParse({ ...response, label: undefined }).success).toBe(false);
  });

  const record = {
    key: {
      evidenceId: "ev-1",
      revision: 0,
      extractorGeneration: 0,
      promptId: "interpreter",
      promptVersion: "1",
      inputHash: sha,
    },
    keys: [{ evidenceId: "ev-1", keyRef: "kr-1" }],
    renderedInput: "input",
    rawOutput: "{}",
    outputHash: sha,
    label,
    origin: "live",
  };

  it("a saved call names every item its input held", () => {
    expect(ModelCallRecord.safeParse(record).success).toBe(true);
    expect(ModelCallRecord.safeParse({ ...record, keys: [] }).success).toBe(false);
    expect(ModelCallRecord.safeParse({ ...record, origin: "captured" }).success).toBe(false);
  });

  it("a generated record has no rendered input and the hash of the empty string", () => {
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const generated = {
      ...record,
      origin: "generated",
      renderedInput: "",
      key: { ...record.key, inputHash: emptyHash },
    };
    expect(ModelCallRecord.safeParse(generated).success).toBe(true);
    expect(ModelCallRecord.safeParse({ ...generated, renderedInput: "input" }).success).toBe(false);
    expect(ModelCallRecord.safeParse({ ...record, origin: "generated", renderedInput: "" }).success).toBe(false);
  });

  it("an embedding request has a closed purpose", () => {
    const embedding = { purpose: "query_text", text: "cfo", label, trustGroup: "tg-people" };
    expect(EmbeddingRequest.safeParse(embedding).success).toBe(true);
    expect(EmbeddingRequest.safeParse({ ...embedding, purpose: "rerank" }).success).toBe(false);
    expect(EmbeddingRequest.safeParse({ ...embedding, tools }).success).toBe(false);
  });
});
