import { sha256Hex, testId } from "./clients.ts";

// One row of each table of the improvement store and the outcome test, and of what work waits
// on, for the seeder.
type Insert = (table: string, row: Record<string, unknown>) => Promise<unknown>;
type Session = () => Promise<{ id: string; clientId: string }>;

export function measureSeeds(
  asLedger: Insert,
  ledgerSession: Session,
  answerSeeds: {
    card: () => Promise<string>;
    person: () => Promise<string>;
    opportunity: (compartments: string[]) => Promise<string>;
    seal: (compartments: string[], table: string, id: string, column: string, value: string) => unknown;
  },
) {
  const by = async (prefix: string) => {
    const { id: session_id, clientId: client_id } = await ledgerSession();
    return { session_id, client_id, request_id: `seed-${prefix}-${testId("req").slice(4, 20)}` };
  };
  const improvement = async (compartments: string[]): Promise<string> => {
    const id = testId("imp");
    const who = await by("imp");
    await asLedger("ledger.improvements", {
      id,
      ...who,
      created_by: `client:${who.client_id}`,
      compartments,
      kind: "bug",
      area: "other",
      severity: "low",
      title_fp: sha256Hex(`seed improvement ${id}`),
    });
    return id;
  };
  const improvementEvent = async (compartments: string[]): Promise<void> => {
    const who = await by("ime");
    await asLedger("ledger.improvement_events", {
      id: testId("ime"),
      improvement_id: await improvement(compartments.length === 0 ? ["own"] : compartments),
      ...who,
      created_by: `client:${who.client_id}`,
      compartments,
      event: "status",
      status: "triaged",
    });
  };
  const learning = async (compartments: string[]): Promise<void> => {
    const id = testId("lrn");
    const who = await by("lrn");
    await asLedger("ledger.agent_learnings", {
      id,
      ...who,
      created_by: `client:${who.client_id}`,
      compartments,
      scope: "general",
      statement_fp: sha256Hex(`seed learning ${id}`),
      statement_enc: answerSeeds.seal(compartments, "ledger.agent_learnings", id, "statement_enc", "seed statement"),
      rule_enc: answerSeeds.seal(compartments, "ledger.agent_learnings", id, "rule_enc", "seed rule"),
      evidence_enc: answerSeeds.seal(compartments, "ledger.agent_learnings", id, "evidence_enc", "seed evidence"),
    });
  };
  const outcomeRun = async (compartments: string[]): Promise<string> => {
    const id = testId("otr");
    await asLedger("ledger.outcome_test_runs", {
      id,
      ...(await by("otr")),
      compartments,
      suite: "outcome-test@1",
      expected_tasks: 16,
      answer_model: "vendor/a",
      judge_model: "vendor/b",
    });
    return id;
  };
  const outcomeTask = async (compartments: string[]): Promise<void> => {
    await asLedger("ledger.outcome_test_tasks", {
      id: testId("ott"),
      run_id: await outcomeRun(compartments.length === 0 ? ["own"] : compartments),
      ...(await by("ott")),
      compartments,
      task: "what_is_owed",
      held_out: false,
      code_cap: 3,
      failed: [],
      tool_calls: 0,
      cost_microusd: 0,
    });
  };
  const heldOutQuestion = async (compartments: string[]): Promise<void> => {
    await asLedger("ledger.held_out_questions", {
      id: testId("hoq"),
      ...(await by("hoq")),
      compartments,
      class: "person",
    });
  };
  // A same-person question, an agent's answer on it, and a rule from the owner's answers.
  const identityPair = async (compartments: string[]): Promise<{ id: string; a: string; b: string }> => {
    const [a, b] = [await answerSeeds.person(), await answerSeeds.person()];
    const id = `idq_${testId("x").slice(-26)}`;
    await asLedger("ledger.identity_questions", {
      id,
      case_key: `same:${sha256Hex(id).slice(0, 40)}`,
      a_entity: a,
      b_entity: b,
      a_fp: sha256Hex(a),
      b_fp: sha256Hex(b),
      basis: "name",
      pattern: "same_person:name:0",
      evidence_fp: sha256Hex(id).slice(0, 40),
      state: "agents",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      compartments,
    });
    return { id, a, b };
  };
  const identityQuestion = async (compartments: string[]): Promise<string> => (await identityPair(compartments)).id;
  const identityAnswer = async (compartments: string[]): Promise<void> => {
    await asLedger("ledger.identity_answers", {
      id: `ida_${testId("x").slice(-26)}`,
      request_id: testId("req").slice(4),
      question_id: await identityQuestion(compartments),
      client_id: testId("cli"),
      client_name: "seed-agent",
      opportunity_id: testId("opp"),
      verdict: "cant_tell",
      because: "no_evidence",
      cites: [],
      cite_evidence: [],
      evidence_fp: "0".repeat(40),
      created_at: new Date().toISOString(),
      compartments,
    });
  };
  // An agent's answer on a card, as ledger.answer_card writes it as pi_owner.
  const cardAnswer = async (compartments: string[], card?: string): Promise<string> => {
    const id = `can_${testId("x").slice(-26)}`;
    await asLedger("ledger.card_answers", {
      id,
      request_id: testId("req").slice(4),
      card_id: card ?? (await answerSeeds.card()),
      opportunity_id: testId("opp"),
      move_id: testId("mov"),
      client_id: testId("cli"),
      client_name: "seed-agent",
      answer: "cant_tell",
      created_at: new Date().toISOString(),
      compartments,
    });
    return id;
  };
  // An agent's ruling on a card, as ledger.answer_card writes it as pi_owner, beside its answer.
  const agentRuling = async (compartments: string[]): Promise<void> => {
    const card = await answerSeeds.card();
    await asLedger("ledger.agent_rulings", {
      card_id: card,
      answer_id: await cardAnswer(compartments, card),
      kind: "agent_claim",
      answer: "confirm",
      client_id: testId("cli"),
      client_name: "seed-agent",
      cited_kinds: [],
      cited_ids: [],
      created_at: new Date().toISOString(),
      compartments,
    });
  };
  // An agent's report of a wrong merge, as ledger.report_wrong_merge writes it as pi_owner.
  const wrongMergeReport = async (compartments: string[]): Promise<void> => {
    const [a, b] = [await answerSeeds.person(), await answerSeeds.person()].sort();
    await asLedger("ledger.wrong_merge_reports", {
      id: `wmr_${testId("x").slice(-26)}`,
      request_id: testId("req").slice(4),
      entity_id: a,
      members: [a, b],
      parts: [a, b],
      partition_key: "1".repeat(64),
      group_key: "2".repeat(64),
      cross_rulings: [testId("rul")],
      client_id: testId("cli"),
      client_name: "seed-agent",
      session_id: testId("ses"),
      because: "different_employers",
      cites: [],
      cite_evidence: [],
      cite_address_fps: [],
      state: "open",
      created_at: new Date().toISOString(),
      compartments,
    });
  };
  // An agent's report of a wrong relation, as ledger.report_wrong_relation writes it as pi_owner.
  const relationReport = async (compartments: string[]): Promise<void> => {
    const id = `rrp_${testId("x").slice(-26)}`;
    await asLedger("ledger.relation_reports", {
      id,
      request_id: testId("req").slice(4),
      relation_id: 1,
      claim_keys: [sha256Hex(`seed report from ${id}`), sha256Hex(`seed report to ${id}`)],
      client_id: testId("cli"),
      session_id: testId("ses"),
      because: "not_same_fact",
      cites: [testId("msg")],
      evidence_ids: [testId("evi")],
      created_at: new Date().toISOString(),
      compartments,
    });
  };
  // A relayed answer, as ledger.relay_card_answer writes it as pi_owner.
  const cardRelay = async (compartments: string[]): Promise<void> => {
    const id = `crl_${testId("x").slice(-26)}`;
    await asLedger("ledger.card_relays", {
      id,
      request_id: testId("req").slice(4),
      card_id: await answerSeeds.card(),
      opportunity_id: testId("opp"),
      client_id: testId("cli"),
      client_name: "seed-agent",
      option: "confirm",
      quote_enc: answerSeeds.seal(compartments, "ledger.card_relays", id, "quote_enc", "Seed quote"),
      created_at: new Date().toISOString(),
      compartments,
    });
  };
  const questionRule = async (compartments: string[]): Promise<void> => {
    await asLedger("ledger.question_rules", {
      id: `qrl_${testId("x").slice(-26)}`,
      kind: "about_you",
      pattern: `about_you:${testId("x").slice(-8)}`,
      answer: "reject",
      answers: 10,
      status: "proposed",
      proposed_at: new Date().toISOString(),
      compartments,
    });
  };
  // What a task waits on: two opportunities of the label, as pi_owner, the role ledger.place_work
  // writes it as.
  const workDependency = async (compartments: string[]): Promise<void> => {
    await asLedger("ledger.work_dependencies", {
      opportunity_id: await answerSeeds.opportunity(compartments),
      blocked_by: await answerSeeds.opportunity(compartments),
      compartments,
    });
  };
  // Dreaming's, as pi_owner: a conflict the pass filed, an agent's settlement of one (its finding
  // under `own` when the row's own label is empty), and a candidate merge on a question.
  const DREAM_JUDGE = "model:seed/model@personal_dream@1";
  const dreamFinding = async (compartments: string[]): Promise<{ id: string; a: string; b: string }> => {
    const id = `dfd_${testId("x").slice(-26)}`;
    const [a, b] = [sha256Hex(`seed finding a ${id}`), sha256Hex(`seed finding b ${id}`)].sort();
    await asLedger("ledger.dream_findings", {
      id,
      kind: "conflict",
      relation_id: 1,
      a_key: a,
      b_key: b,
      subject: await answerSeeds.person(),
      judge: DREAM_JUDGE,
      compartments,
    });
    return { id, a: a as string, b: b as string };
  };
  const beliefSettlement = async (compartments: string[]): Promise<void> => {
    const finding = await dreamFinding(compartments.length === 0 ? ["own"] : compartments);
    const id = `bst_${testId("x").slice(-26)}`;
    await asLedger("ledger.belief_settlements", {
      id,
      request_id: testId("req").slice(4),
      finding_id: finding.id,
      a_key: finding.a,
      b_key: finding.b,
      holds_key: finding.a,
      client_id: testId("cli"),
      client_name: "seed-agent",
      opportunity_id: testId("opp"),
      move_id: testId("mov"),
      cited_kinds: [],
      cited_ids: [],
      created_at: new Date().toISOString(),
      compartments,
    });
  };
  const dreamCandidate = async (compartments: string[]): Promise<void> => {
    const question = await identityPair(compartments.length === 0 ? ["own"] : compartments);
    await asLedger("ledger.dream_identity_candidates", {
      question_id: question.id,
      a_entity: question.a,
      b_entity: question.b,
      judge: DREAM_JUDGE,
      verdict: "cant_tell",
      claim_keys: [sha256Hex(`seed candidate ${question.id}`)],
      evidence_ids: [testId("evi")],
      compartments,
    });
  };
  return {
    "ledger.dream_findings": async (compartments: string[]) => void (await dreamFinding(compartments)),
    "ledger.belief_settlements": beliefSettlement,
    "ledger.dream_identity_candidates": dreamCandidate,
    "ledger.work_dependencies": workDependency,
    "ledger.identity_questions": identityQuestion,
    "ledger.identity_answers": identityAnswer,
    "ledger.card_answers": async (compartments: string[]) => void (await cardAnswer(compartments)),
    "ledger.agent_rulings": agentRuling,
    "ledger.wrong_merge_reports": wrongMergeReport,
    "ledger.relation_reports": relationReport,
    "ledger.card_relays": cardRelay,
    "ledger.question_rules": questionRule,
    "ledger.improvements": improvement,
    "ledger.improvement_events": improvementEvent,
    "ledger.agent_learnings": learning,
    "ledger.outcome_test_runs": outcomeRun,
    "ledger.outcome_test_tasks": outcomeTask,
    "ledger.held_out_questions": heldOutQuestion,
  };
}
