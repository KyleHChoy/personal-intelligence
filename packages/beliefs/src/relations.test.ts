import { type Claim, ClaimId, EvidenceId, LocalEntityId } from "@intelligence/contracts";
import {
  type BeliefClaim,
  type BeliefRelation,
  RelationRules,
  type RelationSwitchRow,
  type SubjectKind,
} from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { relationRules } from "@intelligence/personal-core/views";
import { describe, expect, it } from "vitest";
import { type BeliefInputs, beliefsFor } from "./belief-at.ts";
import {
  appliedAt,
  codeRelations,
  compareEvidence,
  decideSwitch,
  type EvidenceItem,
  independentSources,
  type KeyedClaim,
  mayPrevail,
  prevailHolds,
  quietDay,
  R11_HOLD,
  RULE_PREVAILS,
  RULE_SAME_FACT,
  RULE_SUPERSEDES,
  readRelations,
  type SwitchMeasures,
  supersededIn,
  supersedeHolds,
  switchedOn,
  wilsonLow,
} from "./relations.ts";

// The precedence bounds, the evidence order, the switch, chains and what applies at read. Synthetic
// ids and invented values.

const RULES = relationRules();
const NORA = LocalEntityId.parse("ent_0000000000000000000000NORA");
const OWNER = LocalEntityId.parse("ent_000000000000000000000OWNER");
const THEO = LocalEntityId.parse("ent_0000000000000000000000THEO");
const ALDER = LocalEntityId.parse("ent_000000000000000000000ALDER");
const BRIGHT = LocalEntityId.parse("ent_00000000000000000000BRIGHT");
const DAY = 86_400_000;
const day = (n: number): string => new Date(Date.parse("2026-05-01T10:00:00.000Z") + n * DAY).toISOString();
const evidence = (n: number) => EvidenceId.parse(n.toString(16).padStart(64, "0"));
const key = (n: number): string => n.toString(16).padStart(64, "c");

type Shape = {
  n: number;
  type?: string;
  fields?: Record<string, unknown>;
  subject?: string;
  subjectKind?: SubjectKind;
  by?: string;
  at?: string;
  kind?: Claim["statementKind"];
  compartment?: string;
  ownerSaid?: boolean;
  ownerConfirmed?: boolean;
};

function claimOf(shape: Shape): BeliefClaim {
  const subject = shape.subject ?? NORA;
  const by = shape.by ?? subject;
  const id = evidence(shape.n);
  const claim: Claim = {
    id: ClaimId.parse(`claim-${String(shape.n).padStart(3, "0")}`),
    content: {
      type: shape.type ?? "role",
      subject,
      fields: shape.fields ?? { title: "Head of Finance", organization: ALDER },
    },
    statementKind: shape.kind ?? "stated_fact",
    basis: by === subject ? "explicit_self" : "third_party",
    assertedBy: by,
    validFrom: shape.at ?? day(0),
    evidence: [{ evidenceId: id, span: "chars:0-24" }],
    primaryEvidenceId: id,
    label: { compartments: [shape.compartment ?? "own"], readers: [THE_OWNER] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 2,
    changeKind: "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  } as Claim;
  return {
    claim,
    origin: "source",
    subjectKind: shape.subjectKind ?? (subject === OWNER ? "owner" : "person"),
    ownerSaid: shape.ownerSaid ?? by === OWNER,
    ...(shape.ownerConfirmed === true ? { ownerConfirmed: true } : {}),
    keys: [key(shape.n)],
  };
}

const item = (n: number, extra: Partial<EvidenceItem> = {}): EvidenceItem => ({
  item: `item-${n}`,
  domain: `domain-${n}`,
  thread: `thread-${n}`,
  agent: false,
  firstHand: false,
  authenticated: false,
  domainMatches: false,
  at: day(n),
  flagged: false,
  ...extra,
});

const relation = (
  from: number,
  to: number,
  kind: BeliefRelation["kind"],
  judge: string,
  extra: Partial<BeliefRelation> = {},
): BeliefRelation => ({
  id: `${from}-${to}-${kind}`,
  from: key(from),
  to: key(to),
  kind,
  judge,
  judgedAt: day(40),
  compartments: ["own"],
  ...extra,
});
const MODEL = "model:openrouter/some-model@personal_claim_relations@1";
const OWNER_JUDGE = "owner:rul_00000000000000000000000000";

describe("the rule table (ontology/relations.json)", () => {
  it("parses, and its evidence order runs from independent sources to the newer statement", () => {
    expect(RelationRules.parse(RULES)).toEqual(RULES);
    expect(RULES.evidenceOrder).toEqual([
      "independent_sources",
      "first_hand",
      "authenticated_mail",
      "domain_matches_organization",
      "newer_statement",
    ]);
  });
});

describe("the precedence bounds", () => {
  it("a source-tier supersedes never removes an owner claim", () => {
    const his = claimOf({ n: 1, subject: OWNER, by: OWNER, type: "situation", fields: { what: "based in Lisbon" } });
    const source = claimOf({
      n: 2,
      subject: OWNER,
      by: THEO,
      type: "situation",
      fields: { what: "based in Porto" },
      at: day(5),
    });
    expect(supersedeHolds(source, his, MODEL, false)).toBe(false);
    // A later word of the owner's own supersedes their own.
    const later = claimOf({
      n: 3,
      subject: OWNER,
      by: OWNER,
      type: "situation",
      fields: { what: "based in Porto" },
      at: day(9),
    });
    expect(supersedeHolds(later, his, MODEL, false)).toBe(true);
  });

  it("about the owner, only the owner's own word supersedes their own word, whatever its tier says", () => {
    const his = claimOf({ n: 1, subject: OWNER, by: OWNER, type: "situation", fields: { what: "based in Lisbon" } });
    // The owner's word in a later item supersedes it; a third party's about the owner, at the source tier, never.
    expect(
      supersedeHolds(
        claimOf({ n: 2, subject: OWNER, by: OWNER, type: "situation", fields: { what: "based in Porto" }, at: day(5) }),
        his,
        MODEL,
        false,
      ),
    ).toBe(true);
    const notice = claimOf({
      n: 3,
      subject: OWNER,
      by: THEO,
      type: "situation",
      fields: { what: "based in Faro" },
      at: day(6),
    });
    expect(supersedeHolds(notice, his, MODEL, false)).toBe(false);
  });

  it("the newer claim supersedes, never the older", () => {
    const older = claimOf({ n: 1, at: day(1) });
    const newer = claimOf({ n: 2, at: day(2), fields: { title: "Chief of Staff", organization: ALDER } });
    expect(supersedeHolds(newer, older, MODEL, false)).toBe(true);
    expect(supersedeHolds(older, newer, MODEL, false)).toBe(false);
  });

  it("code's reversal supersedes only where the kind ends a fact by its reversal", () => {
    const stated = claimOf({ n: 1, type: "commitment", fields: { what: "send the deck", counterparty: OWNER } });
    const reversed = claimOf({
      n: 2,
      type: "commitment",
      fields: { what: "send the deck", counterparty: OWNER },
      kind: "reversal",
      at: day(3),
    });
    expect(supersedeHolds(reversed, stated, RULE_SUPERSEDES, true)).toBe(true);
    expect(supersedeHolds(reversed, stated, RULE_SUPERSEDES, false)).toBe(false);
  });

  it("prevails never chooses a lower tier over a higher, never about the owner, never what the owner judged", () => {
    const confirmed = claimOf({ n: 1, ownerConfirmed: true, by: THEO, kind: "question" });
    const source = claimOf({ n: 2, by: THEO, fields: { title: "Chief of Staff", organization: ALDER } });
    // A question the owner confirmed about a person is no owner word here; tiers by claimTier.
    expect(prevailHolds(source, source, RULE_PREVAILS)).toBe(true);
    const his = claimOf({ n: 3, subject: OWNER, by: OWNER, type: "situation", fields: { what: "in Lisbon" } });
    const about = claimOf({ n: 4, subject: OWNER, by: THEO, type: "situation", fields: { what: "in Porto" } });
    expect(prevailHolds(about, his, RULE_PREVAILS)).toBe(false);
    expect(prevailHolds(source, claimOf({ n: 5, by: THEO }), OWNER_JUDGE)).toBe(false);
    expect(confirmed.ownerConfirmed).toBe(true);
  });

  it("prevails is never written, nor applied, for a fact about the owner, a commitment, a consent or a contact rule", () => {
    for (const type of ["commitment", "consent", "contact_rule"])
      expect(
        mayPrevail("person", claimOf({ n: 1, type, fields: { what: "x", counterparty: OWNER } }).claim),
        type,
      ).toBe(false);
    expect(mayPrevail("owner", claimOf({ n: 1, subject: OWNER, type: "situation", fields: { what: "x" } }).claim)).toBe(
      false,
    );
    expect(mayPrevail("person", claimOf({ n: 1 }).claim)).toBe(true);
    // A kind whose key holds no value that can differ is no dispute to settle.
    expect(
      mayPrevail(
        "person",
        claimOf({ n: 1, type: "preference", fields: { what: "mornings", polarity: "prefers" } }).claim,
      ),
    ).toBe(false);
    // And code writes none for them, however the evidence falls.
    const keyed = (
      n: number,
      type: string,
      subjectKind: SubjectKind,
      value: string,
      evidenceOf: EvidenceItem,
    ): KeyedClaim => {
      const one = claimOf({ n, type, fields: { what: value, counterparty: OWNER }, subjectKind });
      return {
        key: key(n),
        id: one.claim.id,
        item: evidenceOf.item,
        claim: one.claim,
        subjectKind,
        tier: "source",
        valueFp: value,
        evidence: evidenceOf,
      };
    };
    for (const [type, kind] of [
      ["commitment", "person"],
      ["consent", "person"],
      ["contact_rule", "person"],
      ["situation", "owner"],
    ] as const) {
      const strong = keyed(1, type, kind, "v1", item(1, { firstHand: true, authenticated: true }));
      const weak = keyed(2, type, kind, "v2", item(2));
      expect(
        codeRelations([strong, weak], new Set([strong.id]), RULES).filter((one) => one.kind === "prevails"),
        type,
      ).toEqual([]);
    }
  });
});

describe("the evidence order", () => {
  it("independent sources: items of one domain or one thread are one source, and an agent's records one together", () => {
    expect(independentSources([item(1), item(2), item(3)])).toBe(3);
    expect(independentSources([item(1), item(2, { domain: "domain-1" }), item(3, { thread: "thread-2" })])).toBe(1);
    expect(independentSources([item(1, { agent: true }), item(2, { agent: true })])).toBe(1);
  });

  it("decides in order: the first difference wins", () => {
    // Two sources against one wins before first-hand speech is looked at.
    expect(compareEvidence([item(1), item(2)], [item(3, { firstHand: true })], RULES)).toEqual({
      winner: "a",
      by: "independent_sources",
    });
    // One against one: first-hand speech decides before authentication.
    expect(compareEvidence([item(1, { authenticated: true })], [item(3, { firstHand: true })], RULES)).toEqual({
      winner: "b",
      by: "first_hand",
    });
    expect(compareEvidence([item(1, { authenticated: true })], [item(3)], RULES)).toEqual({
      winner: "a",
      by: "authenticated_mail",
    });
    expect(compareEvidence([item(1)], [item(3, { domainMatches: true })], RULES)).toEqual({
      winner: "b",
      by: "domain_matches_organization",
    });
    expect(compareEvidence([item(1)], [item(40)], RULES)).toEqual({ winner: "b", by: "newer_statement" });
    expect(compareEvidence([item(1)], [item(20)], RULES)).toEqual({ winner: null, by: "equal" });
  });

  it("an item the triage screen flagged never counts as evidence on either side", () => {
    // The flagged side's strong evidence is gone; what is left decides.
    expect(
      compareEvidence(
        [item(1, { firstHand: true, authenticated: true, flagged: true }), item(2)],
        [item(3, { authenticated: true })],
        RULES,
      ),
    ).toEqual({ winner: "b", by: "authenticated_mail" });
    // A flagged item adds no source.
    expect(compareEvidence([item(1), item(2, { flagged: true })], [item(3)], RULES)).toEqual({
      winner: null,
      by: "equal",
    });
    // A side left with nothing is no evidence: code decides nothing.
    expect(compareEvidence([item(1, { flagged: true })], [item(3)], RULES)).toEqual({
      winner: null,
      by: "no_evidence",
    });
  });

  it("code's relations at commit: a reversal supersedes, one value from two items is same_fact, evidence settles prevails", () => {
    const keyed = (
      n: number,
      value: string,
      evidenceOf: EvidenceItem,
      kind: Claim["statementKind"] = "stated_fact",
      at = day(n),
    ): KeyedClaim => {
      const one = claimOf({ n, kind, at, by: THEO });
      return {
        key: key(n),
        id: one.claim.id,
        item: evidenceOf.item,
        claim: one.claim,
        subjectKind: "person",
        tier: "source",
        valueFp: value,
        evidence: evidenceOf,
      };
    };
    const a = keyed(1, "v1", item(1));
    const b = keyed(2, "v1", item(2));
    const c = keyed(3, "v2", item(3, { firstHand: true }));
    const r = keyed(4, "v1", item(4), "reversal");
    const relations = codeRelations([a, b, c, r], new Set([b.id, c.id, r.id]), RULES);
    expect(relations).toEqual(
      expect.arrayContaining([
        { from: key(2), to: key(1), kind: "same_fact", judge: RULE_SAME_FACT },
        { from: key(4), to: key(1), kind: "supersedes", judge: RULE_SUPERSEDES },
        { from: key(4), to: key(3), kind: "supersedes", judge: RULE_SUPERSEDES },
      ]),
    );
    // Two sources (items 1 and 2) for v1 against one first-hand item for v2: two against one wins.
    expect(relations.filter((one) => one.kind === "prevails")).toEqual([
      { from: key(2), to: key(3), kind: "prevails", judge: RULE_PREVAILS },
    ]);
    expect(codeRelations([a, b, c], new Set(), RULES)).toEqual([]);
  });
});

describe("the relation switch", () => {
  const rules = RULES.switch;
  const good: SwitchMeasures = {
    evaluation: { correct: 100, judged: 100 },
    agreement: { agreed: 99, checked: 100, days: 14 },
    overturns: { overturned: 0, applied: 0 },
    laterContradictions: { contradicted: 0, applied: 0 },
    quietDays: 0,
  };
  const off = { on: false, offByBound: false };

  it("the evaluation-set hold holds in code: no model kind applies by the system's job but through its source checks", () => {
    expect(R11_HOLD).toBe(true);
    expect(appliedAt({ kind: "refines", judge: MODEL }, [], day(2))).toBe(false);
    expect(decideSwitch(off, good, rules)).toEqual({ on: false, code: "held_r11" });
    // Code's and the owner's relations apply.
    expect(appliedAt({ kind: "same_fact", judge: RULE_SAME_FACT }, [], day(2))).toBe(true);
    expect(appliedAt({ kind: "supersedes", judge: OWNER_JUDGE }, [], day(2))).toBe(true);
  });

  it("turns a kind on at the criteria, read as the interval's lower bound", () => {
    expect(decideSwitch(off, good, rules, false)).toEqual({ on: true, code: "criteria" });
    // 40 of 40 is a point estimate of 1 and a lower bound of 0.91: not enough.
    expect(decideSwitch(off, { ...good, evaluation: { correct: 40, judged: 40 } }, rules, false)).toEqual({
      on: false,
      code: "precision",
    });
    expect(wilsonLow(100, 100)).toBeGreaterThan(0.95);
    expect(wilsonLow(40, 40)).toBeLessThan(0.95);
    expect(decideSwitch(off, { ...good, evaluation: null }, rules, false).code).toBe("no_evaluation");
    expect(decideSwitch(off, { ...good, agreement: { agreed: 99, checked: 100, days: 13 } }, rules, false).code).toBe(
      "agreement",
    );
    expect(decideSwitch(off, { ...good, agreement: { agreed: 90, checked: 100, days: 14 } }, rules, false).code).toBe(
      "agreement",
    );
    // A new version no better than the applied one stays off.
    expect(
      decideSwitch(off, { ...good, evaluation: { correct: 200, judged: 202 }, applied: 0.99 }, rules, false).code,
    ).toBe("regression");
  });

  it("turns it off at the overturn bound or the later-contradiction bound", () => {
    const on = { on: true, offByBound: false };
    expect(decideSwitch(on, good, rules, false)).toEqual({ on: true, code: "holds" });
    expect(decideSwitch(on, { ...good, overturns: { overturned: 3, applied: 100 } }, rules, false)).toEqual({
      on: false,
      code: "overturn_bound",
    });
    expect(decideSwitch(on, { ...good, overturns: { overturned: 2, applied: 100 } }, rules, false).on).toBe(true);
    expect(decideSwitch(on, { ...good, laterContradictions: { contradicted: 6, applied: 100 } }, rules, false)).toEqual(
      { on: false, code: "contradiction_bound" },
    );
  });

  it("back on only after 14 quiet days under half the bounds", () => {
    const after = { on: false, offByBound: true };
    expect(decideSwitch(after, { ...good, quietDays: 13 }, rules, false)).toEqual({ on: false, code: "not_quiet" });
    expect(decideSwitch(after, { ...good, quietDays: 14 }, rules, false)).toEqual({ on: true, code: "criteria" });
    // Half the bounds: 1% overturns and 2.5% later contradictions.
    expect(quietDay(0.009, 0.024, rules)).toBe(true);
    expect(quietDay(0.011, 0, rules)).toBe(false);
    expect(quietDay(0, 0.026, rules)).toBe(false);
  });

  // The source check lifts the evaluation-set hold for a relation kind, per kind.
  describe("the source check's criterion", () => {
    const noSet: SwitchMeasures = { ...good, evaluation: null };
    // About 60 consecutive supported checks reach a 95% Wilson lower bound of 0.95.
    const bound = (() => {
      let n = 1;
      while (wilsonLow(n, n) < rules.precisionMin) n += 1;
      return n;
    })();

    it("turns a kind on at the bound, under R11, with no evaluation set", () => {
      expect(bound).toBeGreaterThan(50);
      expect(bound).toBeLessThan(80);
      expect(decideSwitch(off, { ...noSet, sourceCheck: { supported: bound, scored: bound } }, rules)).toEqual({
        on: true,
        code: "source_check",
      });
      // And with the evaluation set also passing: the checks lift the hold.
      expect(decideSwitch(off, { ...good, sourceCheck: { supported: bound, scored: bound } }, rules)).toEqual({
        on: true,
        code: "source_check",
      });
    });

    it("holds it below the bound: one check short, or one check wrong", () => {
      expect(decideSwitch(off, { ...noSet, sourceCheck: { supported: bound - 1, scored: bound - 1 } }, rules)).toEqual({
        on: false,
        code: "precision",
      });
      expect(decideSwitch(off, { ...noSet, sourceCheck: { supported: bound, scored: bound + 1 } }, rules)).toEqual({
        on: false,
        code: "precision",
      });
      // No checks and no set: nothing to read.
      expect(decideSwitch(off, { ...noSet, sourceCheck: null }, rules).code).toBe("no_evaluation");
      // The evaluation set alone still meets the evaluation-set hold.
      expect(decideSwitch(off, { ...good, sourceCheck: { supported: 10, scored: 10 } }, rules)).toEqual({
        on: false,
        code: "held_r11",
      });
    });

    it("order agreement over 14 days, and the quiet days after a bound, still apply", () => {
      const checks = { supported: bound, scored: bound };
      expect(
        decideSwitch(off, { ...noSet, sourceCheck: checks, agreement: { agreed: 99, checked: 100, days: 13 } }, rules)
          .code,
      ).toBe("agreement");
      expect(
        decideSwitch({ on: false, offByBound: true }, { ...noSet, sourceCheck: checks, quietDays: 13 }, rules).code,
      ).toBe("not_quiet");
    });

    it("off again on an overturn past the bound", () => {
      const on = { on: true, offByBound: false };
      const checks = { supported: bound, scored: bound };
      expect(
        decideSwitch(on, { ...noSet, sourceCheck: checks, overturns: { overturned: 0, applied: 40 } }, rules),
      ).toEqual({ on: true, code: "holds" });
      expect(
        decideSwitch(on, { ...noSet, sourceCheck: checks, overturns: { overturned: 1, applied: 40 } }, rules),
      ).toEqual({ on: false, code: "overturn_bound" });
    });

    it("off on the owner's audit wrongs over their audit answers, however many relations applied", () => {
      const on = { on: true, offByBound: false };
      const checks = { supported: bound, scored: bound };
      const many = {
        overturns: { overturned: 0, applied: 500 },
        laterContradictions: { contradicted: 0, applied: 500 },
      };
      // One wrong among fewer than 50 answers passes the bound (2%), with 500 relations applied or none.
      expect(
        decideSwitch(on, { ...noSet, ...many, sourceCheck: checks, audits: { wrong: 1, answered: 49 } }, rules),
      ).toEqual({ on: false, code: "overturn_bound" });
      expect(decideSwitch(on, { ...noSet, sourceCheck: checks, audits: { wrong: 1, answered: 1 } }, rules)).toEqual({
        on: false,
        code: "overturn_bound",
      });
      // One among 50 is at the bound, not past it; no answer is no rate.
      expect(
        decideSwitch(on, { ...noSet, ...many, sourceCheck: checks, audits: { wrong: 1, answered: 50 } }, rules),
      ).toEqual({ on: true, code: "holds" });
      expect(
        decideSwitch(on, { ...noSet, ...many, sourceCheck: checks, audits: { wrong: 0, answered: 0 } }, rules),
      ).toEqual({ on: true, code: "holds" });
    });

    it("at read, the system's on lifts R11 for its kind alone; the owner's latest row outranks the system's (invariant 11)", () => {
      const system: RelationSwitchRow[] = [{ kind: "refines", judge: MODEL, on: true, at: day(1), by: "system" }];
      expect(appliedAt({ kind: "refines", judge: MODEL }, system, day(2))).toBe(true);
      expect(appliedAt({ kind: "refines", judge: MODEL }, system, day(0))).toBe(false);
      expect(appliedAt({ kind: "supersedes", judge: MODEL }, system, day(2))).toBe(false);
      expect(appliedAt({ kind: "refines", judge: "model:other@personal_claim_relations@1" }, system, day(2))).toBe(
        false,
      );
      const ownerOff: RelationSwitchRow[] = [
        ...system,
        { kind: "refines", judge: MODEL, on: false, at: day(3), by: "owner" },
      ];
      expect(appliedAt({ kind: "refines", judge: MODEL }, ownerOff, day(4))).toBe(false);
      // The owner's on applies the kind with no system row, and before the owner's row it does not.
      const ownerOn: RelationSwitchRow[] = [{ kind: "refines", judge: MODEL, on: true, at: day(1), by: "owner" }];
      expect(appliedAt({ kind: "refines", judge: MODEL }, ownerOn, day(2))).toBe(true);
      expect(appliedAt({ kind: "refines", judge: MODEL }, ownerOn, day(0))).toBe(false);
      expect(appliedAt({ kind: "supersedes", judge: MODEL }, ownerOn, day(2))).toBe(false);
      // The owner's on outranks a later system off, and the owner's off a later system on.
      expect(
        appliedAt(
          { kind: "refines", judge: MODEL },
          [...ownerOn, { kind: "refines", judge: MODEL, on: false, at: day(3), by: "system" }],
          day(4),
        ),
      ).toBe(true);
      const ownerFirstOff: RelationSwitchRow[] = [
        { kind: "refines", judge: MODEL, on: false, at: day(1), by: "owner" },
        { kind: "refines", judge: MODEL, on: true, at: day(3), by: "system" },
      ];
      expect(appliedAt({ kind: "refines", judge: MODEL }, ownerFirstOff, day(4))).toBe(false);
      const systemOff: RelationSwitchRow[] = [
        ...system,
        { kind: "refines", judge: MODEL, on: false, at: day(3), by: "system" },
      ];
      expect(appliedAt({ kind: "refines", judge: MODEL }, systemOff, day(4))).toBe(false);
    });
  });

  it("a switch row counts from its time; the latest row wins, the owner's on a tie", () => {
    const rows: RelationSwitchRow[] = [
      { kind: "refines", judge: MODEL, on: true, at: day(1), by: "system" },
      { kind: "refines", judge: MODEL, on: false, at: day(5), by: "system" },
      { kind: "refines", judge: MODEL, on: true, at: day(5), by: "owner" },
    ];
    expect(switchedOn("refines", MODEL, rows, day(0))).toBe(false);
    expect(switchedOn("refines", MODEL, rows, day(2))).toBe(true);
    expect(switchedOn("refines", MODEL, rows, day(6))).toBe(true);
    expect(switchedOn("refines", "model:other@personal_claim_relations@1", rows, day(6))).toBe(false);
    expect(appliedAt({ kind: "refines", judge: MODEL }, rows, day(2))).toBe(true);
  });
});

describe("chains and what applies at read", () => {
  it("chains resolve: a over b and b over c remove both", () => {
    const [a, b, c] = [
      claimOf({ n: 3, at: day(3), ownerConfirmed: false }),
      claimOf({ n: 2, at: day(2) }),
      claimOf({ n: 1, at: day(1) }),
    ];
    const read = readRelations(
      [a, b, c],
      [relation(3, 2, "supersedes", MODEL), relation(2, 1, "supersedes", MODEL)],
      [],
      ["own"],
      day(50),
    ).map((one) => one);
    // Under the evaluation-set hold, the model's relations apply nowhere at read.
    expect(read).toEqual([]);
    const forced = [relation(3, 2, "supersedes", MODEL), relation(2, 1, "supersedes", MODEL)].map((one) => ({
      ...one,
      fromIds: [`claim-00${one.from === key(3) ? 3 : 2}`],
      toIds: [`claim-00${one.to === key(2) ? 2 : 1}`],
    }));
    expect([...supersededIn([a, b, c], forced, false)].sort()).toEqual(["claim-001", "claim-002"]);
  });

  it("a relation applies only when the read holds both claims, inside the audience, and judged by asOf", () => {
    const a = claimOf({ n: 1 });
    const b = claimOf({ n: 2 });
    const rows = [relation(1, 2, "same_fact", RULE_SAME_FACT)];
    expect(readRelations([a, b], rows, [], ["own"], day(50))).toHaveLength(1);
    expect(readRelations([a], rows, [], ["own"], day(50))).toEqual([]);
    expect(
      readRelations([a, b], [{ ...rows[0]!, compartments: ["employer:example", "own"] }], [], ["own"], day(50)),
    ).toEqual([]);
    expect(readRelations([a, b], rows, [], ["own"], day(39))).toEqual([]);
  });
});

describe("beliefsFor with relations", () => {
  // Two speakers within 30 days give Nora two titles at Alder: a dispute.
  const first = claimOf({ n: 1, by: THEO, at: day(1) });
  const second = claimOf({
    n: 2,
    by: LocalEntityId.parse("ent_00000000000000000000000IDA"),
    at: day(3),
    fields: { title: "Chief of Staff", organization: BRIGHT },
  });
  const inputs = (relations: BeliefRelation[], claims: BeliefClaim[] = [first, second]): BeliefInputs => ({
    groups: [{ factKeyFp: "f".repeat(64), claims }],
    decisions: [],
    retirements: [],
    reclassifications: [],
    goAt: null,
    relations,
  });
  const NOW = day(60);

  it("an applied prevails makes the winner's value the belief's, still disputed, with the losing claims cited and how it was settled", () => {
    const [plain] = beliefsFor(inputs([]), ["own"], NOW).rows;
    expect(plain?.belief.disputed).toBe(true);
    expect(plain?.settled).toBeUndefined();
    const [settled] = beliefsFor(inputs([relation(1, 2, "prevails", RULE_PREVAILS)]), ["own"], NOW).rows;
    expect(settled?.belief.disputed).toBe(true);
    expect(settled?.belief.values.organization).toBe(ALDER);
    expect(plain?.belief.values.organization).toBe(BRIGHT);
    expect([...(settled?.belief.support ?? [])].sort()).toEqual(["claim-001", "claim-002"]);
    expect(settled?.settled).toEqual({ by: "rule", winner: "claim-001", losing: ["claim-002"], sources: 1 });
    expect(settled?.phraseClaim).toBe("claim-001");
  });

  it("a relation naming a claim the audience cannot see changes nothing for it (invariant 6)", () => {
    const hidden = claimOf({
      n: 2,
      by: THEO,
      at: day(3),
      compartment: "employer:example",
      fields: { title: "Chief of Staff", organization: ALDER },
    });
    const rows = [relation(2, 1, "prevails", RULE_PREVAILS, { compartments: ["employer:example", "own"] })];
    // The audience of `own` is given only what it may see: the visible claim, and no relation.
    const without = beliefsFor(inputs([], [first]), ["own"], NOW);
    expect(beliefsFor(inputs(rows, [first]), ["own"], NOW)).toEqual(without);
    // Given the hidden claim and the relation all the same, the build counts neither for it.
    expect(beliefsFor(inputs(rows, [first, hidden]), ["own"], NOW).rows).toEqual(without.rows);
  });

  it("a model relation of a kind not switched on changes nothing: no row, or the owner's off over the system's on", () => {
    const plain = beliefsFor(inputs([]), ["own"], NOW);
    expect(beliefsFor({ ...inputs([relation(1, 2, "prevails", MODEL)]), switches: [] }, ["own"], NOW)).toEqual(plain);
    const switches: RelationSwitchRow[] = [
      { kind: "prevails", judge: MODEL, on: false, at: day(1), by: "owner" },
      { kind: "prevails", judge: MODEL, on: true, at: day(2), by: "system" },
    ];
    expect(beliefsFor({ ...inputs([relation(1, 2, "prevails", MODEL)]), switches }, ["own"], NOW)).toEqual(plain);
  });

  it("an applied same_fact across two keys joins them as code's grouping does", () => {
    const a = claimOf({ n: 1, type: "goal", fields: { what: "grow the team" }, at: day(1) });
    const b = claimOf({ n: 2, type: "goal", fields: { what: "grow the team to ten" }, at: day(2) });
    const two: BeliefInputs = {
      groups: [
        { factKeyFp: "a".repeat(64), claims: [a] },
        { factKeyFp: "b".repeat(64), claims: [b] },
      ],
      decisions: [],
      retirements: [],
      reclassifications: [],
      goAt: null,
    };
    expect(beliefsFor(two, ["own"], NOW).rows).toHaveLength(2);
    const joined = beliefsFor({ ...two, relations: [relation(1, 2, "same_fact", RULE_SAME_FACT)] }, ["own"], NOW).rows;
    expect(joined).toHaveLength(1);
    expect(joined[0]?.members).toEqual(["a".repeat(64), "b".repeat(64)]);
  });
});
