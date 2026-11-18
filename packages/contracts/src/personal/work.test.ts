import { Timestamp } from "@intelligence/contracts";
import {
  About,
  ClientRegistration,
  ClosedCase,
  currentDefinition,
  DECISION_POINT_PINS,
  DECISION_POINTS,
  DecisionPointCall,
  DecisionPointDefinition,
  type DecisionPointId,
  doneRequires,
  EFFECT_CLASS,
  EffectName,
  HarnessModeGrant,
  HypothesisStatus,
  IdeasOutput,
  INTERNAL_STAGES,
  ideaAbout,
  Lesson,
  LessonAppliesTo,
  LessonsOutput,
  MoveReportBody,
  noticeBody,
  noticeDetails,
  noticePriority,
  OPEN_STATUSES,
  OpportunityId,
  OpportunityKind,
  OpportunityView,
  OutcomeLinkKind,
  OWNER_ONLY_EFFECTS,
  OwnerDecisionKind,
  PersonalLogEvent,
  PersonalReadTool,
  PersonalRunTool,
  PersonalTool,
  PersonalToolArgs,
  PersonalWorkArgs,
  PersonalWorkResults,
  PersonalWorkTool,
  PROMPT_PINS,
  ReasoningOutput,
  ReportMark,
  RoleName,
  RUN_CHECK_CODES,
  RunOutput,
  RunRequest,
  RunStep,
  RunTrial,
  STAGE_PLAN,
  Stage,
  stageOfWake,
  TOOL_VIEW,
  TrialModelId,
  TurnReply,
  TurnRequest,
  TurnTool,
  TurnToolCall,
  WORK_NOTICE_ORDER,
  WORK_TOOL_VIEW,
  WorkNotice,
  WorkNoticeBody,
  WorkNoticeCode,
  WorkNoticeEvent,
  WorkNoticeId,
  WorkNoticeOutcome,
  WorkNoticeState,
  WorkRef,
  WorkRunCode,
  WorkTier,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { HealthNotice, HealthNoticeBody, healthNoticeBody } from "./work-notices.ts";

// Durable work, the reasoner's turns and the decision point registry. Made-up values.
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-03-04T10:00:00Z";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const basis = [{ kind: "message", id: `msg_${ULID}` }];
const about = { kind: "entity", id: `ent_${ULID}` };
const view = {
  id: `opp_${ULID}`,
  kind: "follow_up",
  status: "go",
  about,
  summary: { untrusted: "Reply to Alex about the review." },
  basis,
  hypothesis: null,
  goal: null,
  stage: "investigate",
  dueAt: null,
  leaseUntil: null,
  tier: "opportunity",
  role: null,
};
const request = {
  id: `run_${ULID}`,
  attempt: 1,
  source: "daily_sweep",
  anchors: [],
  goals: [{ id: `gol_${ULID}`, statement: { untrusted: "Ship the review." } }],
  open: [view],
  closed: [],
  intentions: [],
  point: { id: "run_outcome", version: 1, promptId: "personal_run", promptVersion: "1" },
  limits: {
    maxTurns: 8,
    maxToolCalls: 20,
    maxOutputTokens: 2000,
    maxInputCodePoints: 200_000,
    ceilingMicroUsdPerToken: 100,
  },
};
const registration = {
  name: "reasoner",
  runtime: "cloud",
  vendorRetention: "none",
  compartments: ["own"],
  views: ["self", "people", "work"],
};

describe("work contracts", () => {
  it("a run request has no key for an earlier attempt's steps, and a run step has none for an output or a hash", () => {
    expect(accepts(RunRequest, request)).toBe(true);
    for (const key of ["steps", "previous", "earlier"])
      expect(accepts(RunRequest, { ...request, [key]: [] }), key).toBe(false);
    const step = {
      kind: "model_call",
      promptId: "personal_run",
      promptVersion: "1",
      modelId: "model-a",
      costMicroUsd: 120,
    };
    expect(accepts(RunStep, step)).toBe(true);
    for (const key of ["output", "hash", "text"]) expect(accepts(RunStep, { ...step, [key]: 1 }), key).toBe(false);
    // A model call's token counts and wall-clock milliseconds, whole and not negative.
    expect(accepts(RunStep, { ...step, inputTokens: 1200, outputTokens: 300, ms: 4100 })).toBe(true);
    for (const key of ["inputTokens", "outputTokens", "ms"]) {
      for (const bad of [-1, 1.5, "1"]) expect(accepts(RunStep, { ...step, [key]: bad }), `${key} ${bad}`).toBe(false);
      expect(accepts(RunStep, { kind: "tool_call", tool: "search", status: "ok", [key]: 1 }), key).toBe(false);
    }
    // A model call's one code: its reply was cut off at the output limit.
    expect(accepts(RunStep, { ...step, code: "truncated" })).toBe(true);
    expect(accepts(RunStep, { ...step, code: "bad_output" })).toBe(false);
    expect(accepts(RunRequest, { ...request, attempt: 3 })).toBe(false);
    expect(accepts(RunRequest, { ...request, open: Array.from({ length: 51 }, () => view) })).toBe(false);
  });

  it("a trial run names an OpenRouter-style model id and an effort, and nothing else", () => {
    for (const model of ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5", "vendor/model_a-1"]) {
      expect(accepts(RunRequest, { ...request, trial: { model, effort: "high" } }), model).toBe(true);
    }
    for (const model of [
      "gpt-6-luna",
      "OpenAI/gpt",
      "vendor/",
      "/model",
      "a/b/c",
      "vendor/model:free",
      "vendor/model name",
      `vendor/${"m".repeat(65)}`,
    ]) {
      expect(accepts(TrialModelId, model), model).toBe(false);
    }
    for (const effort of ["low", "medium", "high"])
      expect(accepts(RunTrial, { model: "vendor/model", effort }), effort).toBe(true);
    for (const effort of ["max", "none", "HIGH"])
      expect(accepts(RunTrial, { model: "vendor/model", effort }), effort).toBe(false);
    expect(accepts(RunTrial, { model: "vendor/model", effort: "low", label: "public" })).toBe(false);
  });

  it("a closed case carries its summary, the owner's answer and note, and its outcome, each optional, and refuses a label or an unknown answer", () => {
    const bare = {
      rowKind: "opportunity",
      kind: "goal_step",
      about: { kind: "goal", id: `gol_${ULID}` },
      closedAt: "2026-10-01T10:00:00Z",
      by: "owner",
    };
    expect(accepts(ClosedCase, bare)).toBe(true);
    const full = {
      ...bare,
      id: `opp_${ULID}`,
      status: "no_go",
      summary: { untrusted: "Build a scorecard for evaluating advisers" },
      decision: "no_go",
      note: { untrusted: "process, not progress" },
      outcome: { moves: { done: 0, failed: 0, blocked: 0 }, tests: { supports: 0, refutes: 0, inconclusive: 0 } },
    };
    expect(accepts(ClosedCase, full)).toBe(true);
    expect(
      accepts(ClosedCase, {
        ...full,
        rowKind: "hypothesis",
        kind: "open_loop",
        id: `hyp_${ULID}`,
        status: "rejected",
        decision: "reject",
        by: "policy",
      }),
    ).toBe(true);
    expect(accepts(ClosedCase, { ...full, summary: null, decision: null, note: null })).toBe(true);
    // The owner's decline reason, a code from the closed list.
    expect(accepts(ClosedCase, { ...full, declineReason: "wrong_timing" })).toBe(true);
    for (const [key, value] of [
      ["declineReason", "bad_idea"],
      ["declineReason", null],
      ["decision", "maybe"],
      ["by", "client"],
      ["status", "pending"],
      ["note", "a bare string"],
      ["label", ["own"]],
    ] as const) {
      expect(accepts(ClosedCase, { ...full, [key]: value }), key).toBe(false);
    }
    expect(
      accepts(ClosedCase, {
        ...full,
        outcome: { moves: { done: -1, failed: 0, blocked: 0 }, tests: { supports: 0, refutes: 0, inconclusive: 0 } },
      }),
    ).toBe(false);
    expect(accepts(RunRequest, { ...request, closed: Array.from({ length: 50 }, () => full) })).toBe(true);
    expect(accepts(RunRequest, { ...request, closed: Array.from({ length: 51 }, () => full) })).toBe(false);
  });

  it("a turn tool's name is a personal read tool and nothing else, and a turn tool call's name is any lower snake case word", () => {
    expect(accepts(TurnTool, { name: "read_message", description: "x", inputSchema: {} })).toBe(true);
    for (const name of ["record", "next_run", "draft_message", "search_web"])
      expect(accepts(TurnTool, { name, description: "x", inputSchema: {} }), name).toBe(false);
    expect(accepts(TurnToolCall, { id: "c1", name: "search_web", arguments: {} })).toBe(true);
    expect(accepts(TurnToolCall, { id: "c1", name: "Search", arguments: {} })).toBe(false);
    expect(accepts(TurnToolCall, { id: "", name: "search", arguments: {} })).toBe(false);
    expect(accepts(TurnToolCall, { id: "c".repeat(129), name: "search", arguments: {} })).toBe(false);
  });

  it("a turn request and a turn reply refuse an unknown key", () => {
    const turn = { system: "s", messages: [{ role: "user", text: "u" }], tools: [], maxOutputTokens: 100 };
    const reply = {
      text: null,
      toolCalls: [],
      inputTokens: 10,
      outputTokens: 5,
      costMicroUsd: null,
      modelId: "model-a",
    };
    expect(accepts(TurnRequest, turn)).toBe(true);
    expect(accepts(TurnReply, reply)).toBe(true);
    expect(accepts(TurnRequest, { ...turn, temperature: 0 })).toBe(false);
    expect(accepts(TurnReply, { ...reply, raw: "{}" })).toBe(false);
    expect(
      accepts(TurnReply, {
        ...reply,
        toolCalls: Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, name: "search", arguments: {} })),
      }),
    ).toBe(false);
  });

  it("a reasoning output refuses a key named label, compartment, client, mode or destination", () => {
    const output = { actions: [{ do: "propose", kind: "follow_up", about, summary: "Reply to Alex.", basis }] };
    expect(accepts(ReasoningOutput, output)).toBe(true);
    for (const key of ["label", "compartment", "client", "mode", "destination"]) {
      expect(accepts(ReasoningOutput, { ...output, [key]: "own" }), key).toBe(false);
      expect(accepts(ReasoningOutput, { actions: [{ ...output.actions[0], [key]: "own" }] }), key).toBe(false);
    }
  });

  it("a proposal may name, by its index, an investigate action of the same output", () => {
    const investigate = { do: "investigate", kind: "open_loop", about, summary: "You appear to be hiring.", basis };
    const propose = { do: "propose", kind: "goal_step", about, summary: "Prepare a listing.", basis, hypothesis: 0 };
    expect(accepts(ReasoningOutput, { actions: [investigate, propose] })).toBe(true);
    for (const hypothesis of [-1, 4, 0.5, "0"])
      expect(accepts(ReasoningOutput, { actions: [investigate, { ...propose, hypothesis }] }), String(hypothesis)).toBe(
        false,
      );
    expect(accepts(ReasoningOutput, { actions: [{ ...investigate, hypothesis: 0 }] })).toBe(false);
  });

  it("ignore stands alone", () => {
    const ignore = { do: "ignore", reason: "nothing_to_do" };
    const remind = { do: "remind", about, dueAt: at, summary: "Check back.", basis };
    expect(accepts(ReasoningOutput, { actions: [ignore] })).toBe(true);
    expect(accepts(ReasoningOutput, { actions: [remind, remind] })).toBe(true);
    expect(accepts(ReasoningOutput, { actions: [ignore, remind] })).toBe(false);
    expect(accepts(ReasoningOutput, { actions: [] })).toBe(false);
    expect(accepts(ReasoningOutput, { actions: Array.from({ length: 100 }, () => remind) })).toBe(true);
    expect(accepts(ReasoningOutput, { actions: Array.from({ length: 101 }, () => remind) })).toBe(false);
    // A summary is 1 to 600 code points.
    expect(accepts(ReasoningOutput, { actions: [{ ...remind, summary: "a".repeat(600) }] })).toBe(true);
    expect(accepts(ReasoningOutput, { actions: [{ ...remind, summary: "a".repeat(601) }] })).toBe(false);
    expect(accepts(ReasoningOutput, { actions: [{ ...remind, basis: [] }] })).toBe(false);
  });

  it("a harness mode grant for pay takes only propose", () => {
    const grant = { client: "hermes", kind: "life_admin", stage: "pay", mode: "propose" };
    expect(accepts(HarnessModeGrant, grant)).toBe(true);
    expect(accepts(HarnessModeGrant, { ...grant, mode: "act" })).toBe(false);
    expect(accepts(HarnessModeGrant, { ...grant, mode: "act_with_check" })).toBe(false);
    expect(accepts(HarnessModeGrant, { ...grant, stage: "draft", mode: "act" })).toBe(true);
  });

  it("a registration takes a run tool only with kind reasoner", () => {
    expect(
      accepts(ClientRegistration, {
        ...registration,
        kind: "reasoner",
        tools: ["get_self", "next_run", "append_step", "finish_run"],
      }),
    ).toBe(true);
    expect(accepts(ClientRegistration, { ...registration, kind: "agent", tools: ["get_self", "next_run"] })).toBe(
      false,
    );
    expect(accepts(ClientRegistration, { ...registration, tools: ["next_run"] })).toBe(false);
  });

  it("a reasoner's registration refuses a work tool, the record tool and a restricted compartment", () => {
    const reasoner = { ...registration, kind: "reasoner", tools: ["get_self", "next_run"] };
    expect(accepts(ClientRegistration, { ...reasoner, tools: ["get_self", "claim_opportunity"] })).toBe(false);
    expect(accepts(ClientRegistration, { ...reasoner, tools: ["get_self", "record"] })).toBe(false);
    expect(accepts(ClientRegistration, { ...reasoner, tools: ["get_self", "draft_message"] })).toBe(false);
    expect(accepts(ClientRegistration, { ...reasoner, compartments: ["own", "restricted:health"] })).toBe(false);
    expect(
      accepts(ClientRegistration, { ...reasoner, compartments: ["own", "agent:alpha", "restricted:health"] }),
    ).toBe(false);
  });

  // The reasoner reads the owner's agents' compartments.
  it("a reasoner's registration takes agent compartments beside own", () => {
    const reasoner = { ...registration, kind: "reasoner", tools: ["get_self", "next_run"] };
    expect(accepts(ClientRegistration, { ...reasoner, compartments: ["own", "agent:alpha"] })).toBe(true);
    expect(
      accepts(ClientRegistration, {
        ...reasoner,
        compartments: ["own", "agent:alpha", "agent:beta", "employer:example"],
      }),
    ).toBe(true);
  });

  it("a reasoner with a restricted compartment is refused", () => {
    const reader = { ...registration, tools: ["get_self", "search"] };
    expect(accepts(ClientRegistration, { ...reader, compartments: ["own", "restricted:health"] })).toBe(true);
    expect(accepts(ClientRegistration, { ...reader, kind: "reasoner", compartments: ["own"] })).toBe(true);
    expect(
      accepts(ClientRegistration, { ...reader, kind: "reasoner", compartments: ["own", "restricted:health"] }),
    ).toBe(false);
  });

  it("a registration with no kind is an agent", () => {
    const parsed = ClientRegistration.parse({ ...registration, tools: ["get_self", "claim_opportunity", "record"] });
    expect(parsed.kind ?? "agent").toBe("agent");
    expect(accepts(ClientRegistration, { ...registration, kind: "robot", tools: ["get_self"] })).toBe(false);
  });

  it("every argument schema is strict and carries a request id where the tool writes", () => {
    const tools = [...PersonalWorkTool.options, ...PersonalRunTool.options];
    expect(Object.keys(PersonalWorkArgs).sort()).toEqual([...tools].sort());
    expect(Object.keys(PersonalWorkResults).sort()).toEqual([...tools].sort());
    const reads = new Set([
      "list_opportunities",
      "append_step",
      "read_agent_inbox",
      "list_improvements",
      "get_health",
      "list_levers",
      "list_projects",
      "get_project",
      "list_ideas",
      "get_work_time",
      "read_meeting",
    ]);
    for (const tool of tools) {
      const shape = (PersonalWorkArgs[tool] as unknown as { shape: Record<string, unknown> }).shape;
      expect("requestId" in shape, tool).toBe(!reads.has(tool));
      expect(accepts(PersonalWorkArgs[tool], { extra: 1 }), tool).toBe(false);
    }
    const valid = {
      claim_opportunity: { id: `opp_${ULID}`, requestId: "req-0001" },
      propose_opportunity: { kind: "reply", about, summary: "Reply.", basis, requestId: "req-0001" },
      report_move: { move: `mov_${ULID}`, outcome: "done", requestId: "req-0001" },
      set_intention: { opportunity: `opp_${ULID}`, kind: "check_back", dueAt: at, requestId: "req-0001" },
      append_step: { run: `run_${ULID}`, ordinal: 0, step: { kind: "tool_call", tool: null, status: "refused" } },
      finish_run: { run: `run_${ULID}`, outcome: "failed", code: "turn_limit", requestId: "req-0001" },
    } as const;
    for (const [tool, value] of Object.entries(valid)) {
      const schema = PersonalWorkArgs[tool as keyof typeof valid];
      expect(accepts(schema, value), tool).toBe(true);
      expect(accepts(schema, { ...value, extra: 1 }), `${tool} extra`).toBe(false);
    }
    expect(accepts(PersonalWorkArgs.set_intention, { ...valid.set_intention, kind: "remind" })).toBe(false);
    // A summary and each report text take up to 20 000 code points.
    expect(accepts(PersonalWorkArgs.report_move, { ...valid.report_move, summary: "a".repeat(20_000) })).toBe(true);
    expect(accepts(PersonalWorkArgs.report_move, { ...valid.report_move, summary: "a".repeat(20_001) })).toBe(false);
    expect(accepts(PersonalWorkArgs.list_opportunities, { limit: 26 })).toBe(false);
  });

  it("finish_run's code is a WorkRunCode, durable work's RunCode, and not the extraction pipeline's", () => {
    const finish = { run: `run_${ULID}`, outcome: "failed", requestId: "req-0001" };
    for (const code of WorkRunCode.options)
      expect(accepts(PersonalWorkArgs.finish_run, { ...finish, code }), code).toBe(true);
    expect(accepts(PersonalWorkArgs.finish_run, { ...finish, code: "store_unavailable" })).toBe(false);
    expect(accepts(PersonalWorkArgs.finish_run, { ...finish, outcome: "stopped" })).toBe(false);
  });

  it("a run ended at a bound of the database carries the code budget", () => {
    expect(WorkRunCode.options).toEqual([
      "turn_limit",
      "tool_limit",
      "bad_output",
      "model_unavailable",
      "context_limit",
      "timeout",
      "kill_switch",
      "erasure",
      "withdrawn",
      "budget",
    ]);
  });

  it("done needs, per kind, the owner's answer, a deliverable and a next step, or the draft on the stage before it", () => {
    expect(doneRequires("owner_question", "investigate")).toEqual(["answer_owner_question"]);
    for (const kind of ["investigate", "goal_step", "life_admin", "meeting_prep"] as const)
      expect(doneRequires(kind, "investigate"), kind).toEqual(["deliverable", "next"]);
    expect(doneRequires("follow_up", "investigate")).toEqual(["draft"]);
    expect(doneRequires("follow_up", "draft")).toEqual([]);
    expect(doneRequires("reply", "draft")).toEqual([]);
    expect(doneRequires("follow_up", null)).toEqual([]);
  });

  it("a report's parts, its sealed body, and report_move's two answers", () => {
    const move = `mov_${ULID}`;
    const report = {
      deliverable: "Found three people.",
      sources: [about, "a web page"],
      uncertain: "",
      next: "Ask the owner.",
      candidates: [about, "a name"],
    };
    expect(accepts(PersonalWorkArgs.report_move, { move, outcome: "done", report, requestId: "req-0001" })).toBe(true);
    expect(
      accepts(PersonalWorkArgs.report_move, {
        move,
        outcome: "done",
        report: { ...report, extra: 1 },
        requestId: "req-0001",
      }),
    ).toBe(false);
    expect(
      accepts(PersonalWorkArgs.report_move, {
        move,
        outcome: "done",
        report: { sources: [" "] },
        requestId: "req-0001",
      }),
    ).toBe(false);
    expect(
      accepts(PersonalWorkArgs.report_move, {
        move,
        outcome: "done",
        report: { draft: "a".repeat(20_001) },
        requestId: "req-0001",
      }),
    ).toBe(false);
    expect(accepts(MoveReportBody, { v: 1, report, marks: ["web_only"] })).toBe(true);
    expect(accepts(MoveReportBody, { v: 1, summary: "s", marks: [] })).toBe(true);
    expect(accepts(MoveReportBody, { v: 2, marks: [] })).toBe(false);
    const results = PersonalWorkResults.report_move;
    expect(accepts(results, { move, opportunity: "done" })).toBe(true);
    expect(accepts(results, { move, opportunity: "done", marks: ["web_only"] })).toBe(true);
    expect(accepts(results, { move, opportunity: "done", marks: [] })).toBe(false);
    expect(accepts(results, { move, refused: ["ask_owner"] })).toBe(true);
    expect(accepts(results, { move, refused: [] })).toBe(false);
    expect(accepts(results, { move, refused: ["no_reason"] })).toBe(false);
  });

  it("a brief is all untrusted text, on a claim and on each of the caller's own", () => {
    const brief = {
      kind: "investigate",
      summary: { untrusted: "Look into it." },
      goal: { id: `gol_${ULID}`, statement: { untrusted: "A goal." } },
      hypothesis: {
        id: `hyp_${ULID}`,
        kind: "idea",
        summary: { untrusted: "An idea." },
        why: { untrusted: "Why." },
        test: { untrusted: "A test." },
      },
      lessons: [{ id: `hyp_${ULID}`, lesson: { untrusted: "A lesson." } }],
      preferences: [{ kind: "preference", what: { untrusted: "Warm intros." }, polarity: "likes" }],
      cases: [],
      done: ["deliverable", "next"],
    };
    expect(accepts(PersonalWorkResults.claim_opportunity, { opportunity: view, leaseUntil: at, brief })).toBe(true);
    expect(accepts(PersonalWorkResults.claim_opportunity, { opportunity: view, leaseUntil: at })).toBe(true);
    expect(accepts(PersonalWorkResults.list_opportunities, { opportunities: [{ ...view, brief }] })).toBe(true);
    expect(accepts(PersonalWorkResults.list_opportunities, { opportunities: [{ ...view, brief, extra: 1 }] })).toBe(
      false,
    );
    expect(
      accepts(PersonalWorkResults.claim_opportunity, {
        opportunity: view,
        leaseUntil: at,
        brief: { ...brief, summary: "Look into it." },
      }),
    ).toBe(false);
    expect(
      accepts(PersonalWorkResults.claim_opportunity, {
        opportunity: view,
        leaseUntil: at,
        brief: { ...brief, preferences: [{ kind: "preference", what: "Warm intros." }] },
      }),
    ).toBe(false);
  });

  it("an opportunity view's summary is an untrusted string", () => {
    expect(accepts(OpportunityView, view)).toBe(true);
    expect(accepts(OpportunityView, { ...view, summary: "Reply to Alex." })).toBe(false);
    expect(accepts(OpportunityView, { ...view, summary: null })).toBe(true);
    expect(accepts(PersonalWorkResults.list_opportunities, { opportunities: [{ ...view, summary: "x" }] })).toBe(false);
  });

  it("every effect name has one class, and every owner-only effect is external", () => {
    expect(Object.keys(EFFECT_CLASS).sort()).toEqual([...EffectName.options].sort());
    for (const effect of OWNER_ONLY_EFFECTS) expect(EFFECT_CLASS[effect], effect).toBe("external");
    expect(EFFECT_CLASS.clear_external_move).toBe("external");
    expect(EFFECT_CLASS.clear_internal_move).toBe("internal_reversible");
    expect(EFFECT_CLASS.withhold_item).toBe("narrow");
    // clear_external_move and run_research.
    expect(Object.values(EFFECT_CLASS).filter((one) => one === "external")).toHaveLength(OWNER_ONLY_EFFECTS.length + 2);
  });

  it("the stage plan of every kind uses only known stages", () => {
    for (const [kind, stages] of Object.entries(STAGE_PLAN)) {
      expect(stages.length, kind).toBeGreaterThan(0);
      for (const stage of stages) expect(accepts(Stage, stage), `${kind} ${stage}`).toBe(true);
    }
    expect(INTERNAL_STAGES).toEqual(["investigate", "prepare"]);
    expect(STAGE_PLAN.reply).toEqual(["draft", "send"]);
  });

  it("research is investigate alone, done with a deliverable and a next step, and no client or run proposes it", () => {
    expect(STAGE_PLAN.research).toEqual(["investigate"]);
    expect(doneRequires("research", "investigate")).toEqual(["deliverable", "next"]);
    const propose = {
      kind: "investigate",
      about: { kind: "owner" },
      summary: "s",
      basis: [{ kind: "goal", id: `gol_${"0".repeat(26)}` }],
      requestId: "request-1",
    };
    expect(accepts(PersonalWorkArgs.propose_opportunity, propose)).toBe(true);
    expect(accepts(PersonalWorkArgs.propose_opportunity, { ...propose, kind: "research" })).toBe(false);
    expect(
      accepts(ReasoningOutput, {
        actions: [{ do: "propose", kind: "research", about: { kind: "owner" }, summary: "s", basis: propose.basis }],
      }),
    ).toBe(false);
    // The owner's request, by a short quote or by the note that keeps it.
    expect(
      accepts(PersonalWorkArgs.propose_opportunity, {
        ...propose,
        basis: [{ kind: "owner_request", quote: "find who runs the lab" }],
      }),
    ).toBe(true);
    expect(
      accepts(PersonalWorkArgs.propose_opportunity, {
        ...propose,
        basis: [{ kind: "owner_request", quote: "x".repeat(501) }],
      }),
    ).toBe(false);
    // Never a ref a tool takes by id: only a quote, which the store keeps as the caller's note.
    expect(accepts(WorkRef, { kind: "owner_request", id: `rec_${"0".repeat(26)}` })).toBe(false);
    expect(
      accepts(PersonalWorkArgs.propose_opportunity, {
        ...propose,
        basis: [{ kind: "owner_request", id: `rec_${"0".repeat(26)}` }],
      }),
    ).toBe(false);
    expect(
      accepts(PersonalWorkArgs.record_test, {
        hypothesis: `hyp_${"0".repeat(26)}`,
        result: "supports",
        basis: [{ kind: "owner_request", quote: "q" }],
        requestId: "request-1",
      }),
    ).toBe(false);
    expect(accepts(PersonalWorkArgs.list_opportunities, { scope: "board" })).toBe(true);
  });

  it("a run step takes the four tool statuses, and a model call carries a cost that is a whole number, never null", () => {
    for (const status of ["ok", "refused", "failed", "too_large"])
      expect(accepts(RunStep, { kind: "tool_call", tool: "search", status }), status).toBe(true);
    expect(accepts(RunStep, { kind: "tool_call", tool: "search", status: "skipped" })).toBe(false);
    expect(accepts(RunStep, { kind: "tool_call", tool: null, status: "ok" })).toBe(false);
    expect(accepts(RunStep, { kind: "tool_call", tool: "record", status: "ok" })).toBe(false);
    const call = { kind: "model_call", promptId: "p", promptVersion: "1", modelId: "m" };
    expect(accepts(RunStep, { ...call, costMicroUsd: 0 })).toBe(true);
    for (const cost of [null, 1.5, -1])
      expect(accepts(RunStep, { ...call, costMicroUsd: cost }), String(cost)).toBe(false);
  });

  it("an output check step is one check's code and nothing else", () => {
    for (const code of RUN_CHECK_CODES) expect(accepts(RunStep, { kind: "output_check", code }), code).toBe(true);
    expect(accepts(RunStep, { kind: "output_check", code: "invalid_request" })).toBe(false);
    expect(accepts(RunStep, { kind: "output_check", code: "same_case", action: 1 })).toBe(false);
    expect(accepts(RunStep, { kind: "output_check", code: "same_case", status: "refused" })).toBe(false);
  });

  it("the open statuses are exactly the five expected", () => {
    expect(OPEN_STATUSES).toEqual(["proposed", "later", "go", "claimed", "handed_to_owner"]);
  });

  it("a registration takes a work tool and a run tool in its tools, and TOOL_VIEW and PersonalToolArgs still hold the read tools alone", () => {
    expect(
      accepts(ClientRegistration, { ...registration, tools: ["get_self", "list_opportunities", "claim_opportunity"] }),
    ).toBe(true);
    expect(accepts(ClientRegistration, { ...registration, kind: "reasoner", tools: ["get_self", "finish_run"] })).toBe(
      true,
    );
    expect(Object.keys(TOOL_VIEW).sort()).toEqual([...PersonalReadTool.options].sort());
    expect(Object.keys(PersonalToolArgs).sort()).toEqual([...PersonalReadTool.options].sort());
    expect(WORK_TOOL_VIEW).toBe("work");
    for (const tool of [...PersonalWorkTool.options, ...PersonalRunTool.options])
      expect(accepts(PersonalTool, tool), tool).toBe(true);
  });

  it("the log event takes a run id and still refuses a free string", () => {
    const ids = {
      run: `run_${ULID}`,
      opportunity: `opp_${ULID}`,
      hypothesis: `hyp_${ULID}`,
      move: `mov_${ULID}`,
      intention: `itn_${ULID}`,
      goal: `gol_${ULID}`,
      intent: `int_${ULID}`,
    };
    expect(accepts(PersonalLogEvent, { event: "run_taken", ids })).toBe(true);
    for (const key of Object.keys(ids))
      expect(accepts(PersonalLogEvent, { event: "run_taken", ids: { [key]: "Alex Example" } }), key).toBe(false);
    // int_ and itn_ differ by one letter: neither passes for the other.
    expect(accepts(PersonalLogEvent, { event: "x", ids: { intent: `itn_${ULID}` } })).toBe(false);
  });
});

describe("decision points", () => {
  it("every definition parses, and each version of a point is defined once", () => {
    for (const definition of DECISION_POINTS)
      expect(accepts(DecisionPointDefinition, definition), definition.id).toBe(true);
    const versions = DECISION_POINTS.map((definition) => `${definition.id}@${definition.version}`);
    expect(new Set(versions).size).toBe(versions.length);
    const ids = [...new Set(DECISION_POINTS.map((definition) => definition.id))];
    expect(ids).toEqual([
      "wake_worth_run",
      "run_outcome",
      "opportunity_go",
      "owner_question",
      "move_clear",
      "extract_triage",
      "extract_claims",
      "extract_injection",
      "extract_sensitivity",
      "send_clear",
      "send_first_contact",
      "draft_disclosure",
      "identity_candidate",
      "identity_ruling",
      "extract_recovery",
      "record_injection",
      "identity_rank",
      "record_echo",
      "about_you",
      "client_preference",
      "restrict_category",
      "claims_same_fact",
      "claims_standalone",
      "claims_said",
      "task_go",
    ]);
    expect(Object.isFrozen(DECISION_POINTS)).toBe(true);
    expect(Object.isFrozen(DECISION_POINTS[0]?.outputs)).toBe(true);
  });

  it("no definition holds a function, every definition has a pin, and every prompt a definition names has one", () => {
    expect(JSON.parse(JSON.stringify(DECISION_POINTS))).toEqual(DECISION_POINTS);
    // And the pins of versions a later version replaced, which records already made name.
    const replaced = ["extract_claims@1", "extract_claims@2", "extract_claims@3", "extract_triage@2"];
    expect(Object.keys(DECISION_POINT_PINS).sort()).toEqual(
      [...DECISION_POINTS.map((definition) => `${definition.id}@${definition.version}`), ...replaced].sort(),
    );
    // Every prompt a definition names is pinned, and so is every prompt a later version replaced: a
    // pin, once merged, stays, as a version once merged never changes. personal_correspondence@2
    // replaced @1, whose saved calls name it. pi's registry-prompts test holds each extraction pin
    // equal to the text hash EXTRACT_PROMPTS records.
    const retired = ["personal_correspondence@1"];
    // Pinned ahead of any point version naming them: lessons 5 for its trial, the second-degree
    // versions behind PI_EXTRACT_SECOND_DEGREE and the fact-kind versions behind
    // PI_EXTRACT_FACT_KINDS; and the daily time pass's and the own-lines lane's prompts, which no decision point runs.
    const ahead = [
      "personal_own_lines@1",
      "personal_time_proposal@1",
      "personal_lessons@5",
      "personal_agent_record@4",
      "personal_agent_record@9",
      "personal_correspondence@5",
      "personal_meeting@8",
      "personal_moment@10",
      "personal_correspondence@6",
      "personal_agent_record@5",
      "personal_transaction@3",
      "personal_transaction@4",
      "personal_meeting@9",
      "personal_moment@11",
      "personal_correspondence@7",
      "personal_agent_record@6",
      "personal_meeting@10",
      "personal_moment@12",
      "personal_correspondence@8",
      "personal_agent_record@7",
      "personal_meeting@11",
      "personal_moment@13",
      "personal_correspondence@9",
      "personal_agent_record@8",
      "personal_meeting@12",
      "personal_moment@14",
      "personal_correspondence@10",
      "personal_correspondence@11",
      "personal_moment@15",
      "personal_moment@16",
    ];
    const prompts = DECISION_POINTS.flatMap((definition) =>
      (definition.prompts ?? []).map((prompt) => `${prompt.id}@${prompt.version}`),
    );
    expect(Object.keys(PROMPT_PINS).sort()).toEqual([...new Set([...prompts, ...retired, ...ahead])].sort());
  });

  it("the external stage is its own point, owned by the send proxy, and move_clear holds no external effect", () => {
    const point = (id: DecisionPointId) => currentDefinition(id);
    expect(Object.values(point("move_clear")?.outputs ?? {}).map((effect) => EFFECT_CLASS[effect])).not.toContain(
      "external",
    );
    expect(point("send_clear")).toMatchObject({
      rungs: [0, 4],
      outputs: { clear: "clear_external_move", refuse: "hold" },
      queue: "draft_waiting",
      expiresAfterDays: 7,
    });
    expect(point("send_first_contact")).toMatchObject({
      rungs: [4],
      outputs: { clear: "first_contact", refuse: "decline" },
    });
    expect(point("draft_disclosure")).toMatchObject({
      rungs: [0, 4],
      outputs: { hold: "hold", no_finding: "record_silence" },
    });
  });

  // Narrow, every one.
  it("restrict_category@1 asks a restriction for each category or records silence, and names jev_screen@2", () => {
    const point = DECISION_POINTS.find((definition) => definition.id === "restrict_category");
    expect(point).toEqual({
      id: "restrict_category",
      version: 1,
      rungs: [0, 1],
      outputs: {
        restrict_health: "request_restriction",
        restrict_money: "request_restriction",
        restrict_legal: "request_restriction",
        restrict_intimate: "request_restriction",
        none: "record_silence",
      },
      prompts: [{ id: "jev_screen", version: "2" }],
    });
    for (const effect of Object.values(point?.outputs ?? {})) expect(EFFECT_CLASS[effect], effect).toBe("narrow");
    // jev_screen@1 stays pinned for the four points that name it and the calls already made.
    expect(PROMPT_PINS["jev_screen@1"]).toBeDefined();
    expect(PROMPT_PINS["jev_screen@2"]).toBeDefined();
  });

  it("a definition refuses an effect outside the set, a rung of 5 and an unknown key", () => {
    const definition = { id: "move_clear", version: 1, rungs: [0], outputs: { clear: "clear_internal_move" } };
    expect(accepts(DecisionPointDefinition, definition)).toBe(true);
    expect(accepts(DecisionPointDefinition, { ...definition, outputs: { clear: "send_now" } })).toBe(false);
    expect(accepts(DecisionPointDefinition, { ...definition, rungs: [5] })).toBe(false);
    expect(accepts(DecisionPointDefinition, { ...definition, run: "() => 1" })).toBe(false);
    const call = {
      point: "move_clear",
      version: 1,
      definitionHash: "a".repeat(64),
      rung: 0,
      inputHash: "b".repeat(64),
      output: "clear",
      effect: "clear_internal_move",
      effectClass: "internal_reversible",
      escalated: false,
    };
    expect(accepts(DecisionPointCall, call)).toBe(true);
    expect(accepts(DecisionPointCall, { ...call, inputHash: "B".repeat(64) })).toBe(false);
  });
});

// The planner split's shapes.
describe("the planner split's contracts", () => {
  const idea = {
    idea: "Introduce two founders you know.",
    why: "Each needs what the other built.",
    basis,
    confidence: 0.5,
    test: "Ask one of them.",
  };

  it("an ideas output holds up to twenty strict ideas, none included; a lessons output up to ten lessons", () => {
    expect(accepts(IdeasOutput, { ideas: [] })).toBe(true);
    expect(accepts(IdeasOutput, { ideas: Array(20).fill(idea) })).toBe(true);
    expect(accepts(IdeasOutput, { ideas: Array(21).fill(idea) })).toBe(false);
    expect(accepts(IdeasOutput, { ideas: [{ ...idea, kind: "follow_up" }] })).toBe(false);
    expect(accepts(IdeasOutput, { ideas: [{ ...idea, confidence: 1.5 }] })).toBe(false);
    expect(accepts(IdeasOutput, { ideas: [{ ...idea, idea: " " }] })).toBe(false);
    expect(accepts(IdeasOutput, { ideas: [{ ...idea, why: "x".repeat(4000) }] })).toBe(true);
    expect(accepts(IdeasOutput, { ideas: [{ ...idea, why: "x".repeat(4001) }] })).toBe(false);
    expect(accepts(IdeasOutput, { ideas: [{ ...idea, label: "public" }] })).toBe(false);
    expect(
      accepts(LessonsOutput, {
        lessons: [{ lesson: "Prefers named introductions.", basis: [{ kind: "hypothesis", id: `hyp_${ULID}` }] }],
      }),
    ).toBe(true);
    expect(accepts(LessonsOutput, { lessons: [{ lesson: "x".repeat(601), basis }] })).toBe(false);
    for (const output of [{ ideas: [idea] }, { lessons: [] }, { actions: [{ do: "ignore", reason: "nothing_to_do" }] }])
      expect(accepts(RunOutput, output)).toBe(true);
    expect(
      accepts(PersonalWorkArgs.finish_run, {
        run: `run_${ULID}`,
        outcome: "finished",
        output: { ideas: [idea] },
        requestId: "finish-request-1",
      }),
    ).toBe(true);
  });

  it("an idea is about the first message, event, person or goal its basis cites, never the owner", () => {
    const refs = (list: unknown[]) => list as Parameters<typeof ideaAbout>[0];
    expect(
      ideaAbout(refs([{ kind: "hypothesis", id: `hyp_${ULID}` }, { kind: "goal", id: `gol_${ULID}` }, ...basis])),
    ).toEqual({ kind: "goal", id: `gol_${ULID}` });
    expect(ideaAbout(refs([{ kind: "opportunity", id: `opp_${ULID}` }]))).toBeNull();
    // An agent record is cited, never what an idea is about.
    expect(ideaAbout(refs([{ kind: "agent_record", id: `rec_${ULID}` }]))).toBeNull();
  });

  it("a basis takes an agent record by its id, never a handle; an about never does", () => {
    expect(accepts(WorkRef, { kind: "agent_record", id: `rec_${ULID}` })).toBe(true);
    expect(accepts(WorkRef, { kind: "agent_record", id: `hdl_${ULID}` })).toBe(false);
    expect(accepts(WorkRef, { kind: "agent_record", id: `msg_${ULID}` })).toBe(false);
    expect(accepts(WorkRef, { kind: "record", id: `rec_${ULID}` })).toBe(false);
    expect(accepts(About, { kind: "agent_record", id: `rec_${ULID}` })).toBe(false);
    expect(
      accepts(IdeasOutput, { ideas: [{ ...idea, basis: [...basis, { kind: "agent_record", id: `rec_${ULID}` }] }] }),
    ).toBe(true);
  });

  it("a wake's stage: the owner's pursue translates, N answers learn, every other wake makes ideas", () => {
    expect(stageOfWake("idea_pursued")).toBe("translate");
    expect(stageOfWake("lessons_due")).toBe("lessons");
    for (const source of [
      "daily_sweep",
      "calendar",
      "goal_changed",
      "owner_request",
      "commitment_due",
      "belief_changed",
    ] as const)
      expect(stageOfWake(source)).toBe("ideas");
  });

  it("a run request takes the mission, the confirmed lessons and a translate run's idea, each optional", () => {
    expect(accepts(RunRequest, request)).toBe(true);
    const staged = {
      ...request,
      mission: { untrusted: "Grow the company." },
      lessons: [{ id: `hyp_${ULID}`, lesson: { untrusted: "Prefers named introductions." } }],
      idea: { id: `hyp_${ULID}`, summary: null, basis },
    };
    expect(accepts(RunRequest, staged)).toBe(true);
    expect(accepts(RunRequest, { ...staged, mission: "Grow the company." })).toBe(false);
    expect(
      accepts(ClosedCase, {
        rowKind: "hypothesis",
        kind: "idea",
        about,
        closedAt: at,
        by: "owner",
        decision: "pursue",
        status: "pursued",
      }),
    ).toBe(true);
  });
});

describe("lesson, report mark and run step shapes", () => {
  const lesson = `hyp_${ULID}`;
  const other = `hyp_01JABCDEFGHJKMNPQRSTVWXYZ1`;
  const report = { move: `mov_${ULID}`, outcome: "done", requestId: "req-0001" };
  const call = {
    kind: "model_call",
    promptId: "personal_reasoner",
    promptVersion: "1",
    modelId: "anthropic/claude-haiku-5-5",
    costMicroUsd: 10,
  };

  it("HypothesisStatus takes retired", () => {
    expect(HypothesisStatus.parse("retired")).toBe("retired");
  });

  it("ReportMark takes mixed_session", () => {
    expect(ReportMark.parse("mixed_session")).toBe("mixed_session");
  });

  it("a lesson takes appliesTo and supersedes, sorted and each once", () => {
    const body = {
      lesson: "Ask before drafting.",
      basis,
      appliesTo: { kinds: ["reply"], roles: ["drafter", "researcher"] },
      supersedes: other,
    };
    expect(Lesson.safeParse(body).success).toBe(true);
    expect(Lesson.safeParse({ lesson: "Ask before drafting.", basis }).success).toBe(true);
    expect(LessonAppliesTo.safeParse({ kinds: [], roles: [] }).success).toBe(true);
    expect(LessonAppliesTo.safeParse({ kinds: ["reply", "follow_up"], roles: [] }).success).toBe(false);
    expect(LessonAppliesTo.safeParse({ kinds: ["reply", "reply"], roles: [] }).success).toBe(false);
    const roles = Array.from({ length: 17 }, (_, at) => `role-${String.fromCharCode(97 + at)}`);
    expect(LessonAppliesTo.safeParse({ kinds: [], roles: roles.slice(0, 16) }).success).toBe(true);
    expect(LessonAppliesTo.safeParse({ kinds: [], roles }).success).toBe(false);
  });

  it("each shape refuses an unknown key and a name or text where an id or code belongs", () => {
    expect(LessonAppliesTo.safeParse({ kinds: [], roles: [], why: "x" }).success).toBe(false);
    expect(LessonAppliesTo.safeParse({ kinds: ["Reply to Alex"], roles: [] }).success).toBe(false);
    expect(LessonAppliesTo.safeParse({ kinds: [], roles: ["Alex Smith"] }).success).toBe(false);
    expect(Lesson.safeParse({ lesson: "x", basis, supersedes: "the old lesson" }).success).toBe(false);
    expect(
      PersonalWorkArgs.report_move.safeParse({ ...report, lessonsApplied: ["Ask before drafting."] }).success,
    ).toBe(false);
    const recorded = { move: `mov_${ULID}`, opportunity: "done" };
    expect(PersonalWorkResults.report_move.safeParse({ ...recorded, dropped: 2 }).success).toBe(true);
    expect(PersonalWorkResults.report_move.safeParse({ ...recorded, dropped: 0 }).success).toBe(false);
    expect(PersonalWorkResults.report_move.safeParse({ ...recorded, dropped: "two" }).success).toBe(false);
  });

  it("lessonsApplied refuses 11 ids and a repeated id", () => {
    const ids = Array.from({ length: 11 }, (_, at) => `hyp_01JABCDEFGHJKMNPQRSTVWXY${String(at).padStart(2, "0")}`);
    expect(PersonalWorkArgs.report_move.safeParse({ ...report, lessonsApplied: ids.slice(0, 10) }).success).toBe(true);
    expect(PersonalWorkArgs.report_move.safeParse({ ...report, lessonsApplied: ids }).success).toBe(false);
    expect(PersonalWorkArgs.report_move.safeParse({ ...report, lessonsApplied: [lesson, lesson] }).success).toBe(false);
  });

  it("a RunStep model call takes cost_missing and refuses timed_out", () => {
    expect(RunStep.safeParse({ ...call, code: "cost_missing" }).success).toBe(true);
    expect(RunStep.safeParse({ ...call, code: "truncated" }).success).toBe(true);
    expect(RunStep.safeParse({ ...call, code: "timed_out" }).success).toBe(false);
  });
});

// The work notice, its codes, and the release that declines.
describe("work notices", () => {
  const notice = {
    notice: `ntc_${ULID}`,
    event: "routed",
    opportunity: `opp_${ULID}`,
    tier: "task",
    kind: "research",
    role: "chief-of-staff",
    at,
    deadline: null,
  };

  it("a WorkNotice with any key beyond the eight and the optional outcome is refused", () => {
    expect(accepts(WorkNotice, notice)).toBe(true);
    expect(Object.keys(WorkNotice.shape).sort()).toEqual([
      "at",
      "deadline",
      "event",
      "kind",
      "notice",
      "opportunity",
      "outcome",
      "role",
      "tier",
    ]);
    for (const extra of ["summary", "subject", "label", "compartments", "version", "client"])
      expect(accepts(WorkNotice, { ...notice, [extra]: "x" }), extra).toBe(false);
    for (const key of Object.keys(notice)) {
      const { [key]: _, ...without } = notice as Record<string, unknown>;
      expect(accepts(WorkNotice, without), key).toBe(false);
    }
  });

  it("every value of a WorkNotice is an id, a closed code, a role name or a time", () => {
    const shape = WorkNotice.shape;
    expect(shape.notice).toBe(WorkNoticeId);
    expect(shape.opportunity).toBe(OpportunityId);
    expect(shape.event).toBe(WorkNoticeEvent);
    expect(shape.tier).toBe(WorkTier);
    expect(shape.kind).toBe(OpportunityKind);
    expect(shape.role.unwrap()).toBe(RoleName);
    expect(shape.at).toBe(Timestamp);
    expect(shape.deadline.unwrap()).toBe(Timestamp);
    // A role is the owner's name in a fixed form, never a source's text.
    expect(accepts(WorkNotice, { ...notice, role: null })).toBe(true);
    for (const role of ["Chief of Staff", "alex@example.com", "a", "x".repeat(40)])
      expect(accepts(WorkNotice, { ...notice, role }), role).toBe(false);
    expect(accepts(WorkNotice, { ...notice, notice: "Alex Example" })).toBe(false);
    expect(accepts(WorkNotice, { ...notice, event: "card_answered" })).toBe(false);
  });

  // The routine's fields, built by code from codes and times alone.
  it("the body is exactly the routine's fields beside the notice's own, id and kind at the top level, and its text is the code's", () => {
    const body = noticeBody(WorkNotice.parse(notice));
    expect(Object.keys(WorkNoticeBody.shape).sort()).toEqual([
      "at",
      "deadline",
      "details",
      "event",
      "id",
      "kind",
      "notice",
      "opportunity",
      "outcome",
      "priority",
      "role",
      "tier",
      "title",
    ]);
    expect(body).toMatchObject({ id: `opp_${ULID}`, kind: "research", deadline: null, priority: "low" });
    expect(body.title).toBe("PI task: research (routed)");
    expect(body.details).toBe(
      `Claim it with claim_opportunity opp_${ULID}. The brief comes with the claim. Event: routed. Role: chief-of-staff.`,
    );
    expect(
      noticeBody(
        WorkNotice.parse({ ...notice, tier: "opportunity", kind: "follow_up", event: "opportunity_go", role: null }),
      ),
    ).toMatchObject({
      title: "PI opportunity: follow_up (opportunity_go)",
      details: `Claim it with claim_opportunity opp_${ULID}. The brief comes with the claim. Event: opportunity_go. Role: none.`,
    });
    // Any other title, details or priority, an id that is not the item's, or one more key, is refused.
    expect(accepts(WorkNoticeBody, body)).toBe(true);
    for (const change of [
      { title: "PI task: research for Alex Example" },
      { details: `${body.details} Summary: meet Alex.` },
      { id: `opp_${ULID.slice(0, 25)}1` },
      { priority: "high" },
      { summary: "x" },
    ]) {
      expect(accepts(WorkNoticeBody, { ...body, ...change }), Object.keys(change)[0]).toBe(false);
    }
  });

  // An outcome notice cites its link and the item it rests on, by
  // ids and codes alone, and only an outcome notice carries an outcome.
  it("an outcome notice names the link's kind, its id and the item, built from codes; no other event carries one", () => {
    const outcome = { kind: "not_met", link: 42, evidence: { kind: "message", id: `msg_${ULID}` } } as const;
    expect([...WorkNoticeOutcome.shape.kind.options]).toEqual([...OutcomeLinkKind.options]);
    const body = noticeBody(
      WorkNotice.parse({ ...notice, tier: "opportunity", kind: "follow_up", event: "outcome", role: null, outcome }),
    );
    expect(body).toMatchObject({ outcome, priority: "normal", title: "PI opportunity: follow_up (outcome)" });
    expect(body.details).toBe(
      `An outcome of opp_${ULID}: not_met (link 42), from message msg_${ULID}. Read the work with read_item opp_${ULID}. Event: outcome. Role: none.`,
    );
    expect(accepts(WorkNoticeBody, body)).toBe(true);
    const { outcome: _, ...bare } = body;
    expect(accepts(WorkNoticeBody, { ...bare, details: noticeDetails(bare) })).toBe(false);
    expect(accepts(WorkNoticeBody, { ...noticeBody(WorkNotice.parse(notice)), outcome })).toBe(false);
    for (const evidence of [
      { kind: "message", id: "Re: the lease" },
      { kind: "entity", id: `ent_${ULID}` },
      { kind: "message", id: `hdl_${ULID}` },
    ])
      expect(accepts(WorkNoticeOutcome, { ...outcome, evidence }), evidence.id).toBe(false);
    expect(accepts(WorkNoticeOutcome, { ...outcome, evidence: null })).toBe(true);
    expect(accepts(WorkNoticeOutcome, { ...outcome, summary: "they said no" })).toBe(false);
  });

  it("the priority: high within 24 hours or past due, normal within 7 days or an opportunity's go, low otherwise", () => {
    const now = new Date("2026-10-22T12:00:00.000Z");
    const due = (hours: number): string => new Date(now.getTime() + hours * 3_600_000).toISOString();
    expect(noticePriority({ event: "routed", deadline: due(-5) }, now)).toBe("high");
    expect(noticePriority({ event: "routed", deadline: due(24) }, now)).toBe("high");
    expect(noticePriority({ event: "opportunity_go", deadline: due(2) }, now)).toBe("high");
    expect(noticePriority({ event: "routed", deadline: due(25) }, now)).toBe("normal");
    expect(noticePriority({ event: "task_go", deadline: due(7 * 24) }, now)).toBe("normal");
    expect(noticePriority({ event: "opportunity_go", deadline: null }, now)).toBe("normal");
    expect(noticePriority({ event: "opportunity_go", deadline: due(30 * 24) }, now)).toBe("normal");
    expect(noticePriority({ event: "task_go", deadline: due(7 * 24 + 1) }, now)).toBe("low");
    expect(noticePriority({ event: "returned", deadline: null }, now)).toBe("low");
    expect(noticePriority({ event: "outcome", deadline: null }, now)).toBe("normal");
  });

  it("the events, their order, the states and the last codes are closed", () => {
    expect([...WORK_NOTICE_ORDER].sort()).toEqual([...WorkNoticeEvent.options].sort());
    expect(WORK_NOTICE_ORDER[0]).toBe("intention_due");
    expect(WorkNoticeState.options).toEqual(["pending", "delivered", "failed", "stale", "rolled"]);
    for (const code of ["notice_error", "no_secret", "timeout", "http_503"])
      expect(accepts(WorkNoticeCode, code), code).toBe(true);
    for (const code of ["http_5xx", "an address", ""]) expect(accepts(WorkNoticeCode, code), code).toBe(false);
    expect(OwnerDecisionKind.options).toEqual(expect.arrayContaining(["webhook_set", "webhook_removed"]));
    expect(
      accepts(PersonalLogEvent, { event: "notify_failed", code: "no_secret", ids: { notice: `ntc_${ULID}` } }),
    ).toBe(true);
    expect(
      accepts(PersonalLogEvent, { event: "notify_failed", ids: { notice: "https://agent.example.com/hook" } }),
    ).toBe(false);
  });

  it("a release answers released, or declined for an item the caller does not hold, and nothing else", () => {
    expect(accepts(PersonalWorkResults.release_opportunity, { released: true })).toBe(true);
    expect(accepts(PersonalWorkResults.release_opportunity, { declined: true })).toBe(true);
    expect(accepts(PersonalWorkResults.release_opportunity, { released: true, declined: true })).toBe(false);
    expect(accepts(PersonalWorkResults.release_opportunity, { declined: false })).toBe(false);
  });
});

// A box health card forwarded by the notice sender, ids and codes only.
describe("HealthNotice", () => {
  const health = {
    notice: `ntc_${ULID}`,
    event: "box_health",
    card: `crd_${ULID}`,
    kind: "failure_streak",
    about: "reasoner",
    at: "2026-10-30T00:00:00.000Z",
  };

  it("holds a card's id, kind, what it is about and its time, and nothing else", () => {
    expect(accepts(HealthNotice, health)).toBe(true);
    expect(accepts(HealthNotice, { ...health, about: `account/acc_${ULID}` })).toBe(true);
    for (const extra of ["summary", "label", "client"])
      expect(accepts(HealthNotice, { ...health, [extra]: "x" }), extra).toBe(false);
    for (const about of ["Alex Example", "alex@example.com", "account/Alex"])
      expect(accepts(HealthNotice, { ...health, about }), about).toBe(false);
    expect(accepts(HealthNotice, { ...health, kind: "anything" })).toBe(false);
  });

  it("its body's text is the code's, high priority, with the card as its id", () => {
    const body = healthNoticeBody(HealthNotice.parse(health));
    expect(body).toMatchObject({
      id: `crd_${ULID}`,
      kind: "failure_streak",
      deadline: null,
      priority: "high",
      title: "PI box health: failure_streak (reasoner)",
    });
    // A kind an agent may mark is the agent's to look at first.
    expect(body.details).toBe(
      `Look at it with get_health. If it needs nothing of the owner (it mended, or it passes), mark it seen with mark_health_seen. If it needs them, tell the owner. They read it with pia status and mark it seen with pia decide crd_${ULID} --answer seen.`,
    );
    expect(accepts(HealthNoticeBody, body)).toBe(true);
    // Any other kind is the owner's at once: an agent is not told to mark it.
    const owners = healthNoticeBody(HealthNotice.parse({ ...health, kind: "backup_due", about: "backup" }));
    expect(owners.details).toBe(
      `Tell the owner the box needs a look. They read it with pia status and mark it seen with pia decide crd_${ULID} --answer seen.`,
    );
    expect(accepts(HealthNoticeBody, owners)).toBe(true);
    for (const change of [
      { title: "PI box health: Alex" },
      { details: "x" },
      { id: `crd_${ULID.slice(0, 25)}1` },
      { priority: "low" },
    ])
      expect(accepts(HealthNoticeBody, { ...body, ...change })).toBe(false);
  });
});
