import { type Claim, ClaimId, EvidenceId } from "@intelligence/contracts";
import {
  ACTIVITY_PIPELINE,
  type BeliefClaim,
  CORRECTION_PIPELINE,
  claimTierOf,
  isSystemNotice,
} from "@intelligence/contracts/personal";
import {
  BELIEF_RULES,
  type BeliefRule,
  beliefTier,
  buildBelief,
  claimTier,
  differs,
  ownerSideTiers,
  PERSONAL_ONTOLOGY,
  ranksAbove,
  settle,
} from "@intelligence/personal-beliefs";
import { THE_OWNER } from "@intelligence/personal-core";
import { ownStatement } from "@intelligence/personal-core/views";
import { describe, expect, it } from "vitest";
import { ANSWER_PIPELINE, PROPOSAL_PIPELINE, QUOTED_PROPOSAL_PIPELINE } from "./proposal.ts";
import { OWNER_ENTITY } from "./test-support/memory-store.ts";
import { processRecord, recordBody, type Setup, setup } from "./test-support/support.ts";

const DAY = 86_400_000;
const at = (n: number): string => new Date(Date.parse("2026-05-01T10:00:00.000Z") + n * DAY).toISOString();
const evidence = (n: number) => EvidenceId.parse(n.toString(16).padStart(64, "0"));

type Shape = {
  n: number;
  origin?: BeliefClaim["origin"];
  pipeline?: string;
  basis?: Claim["basis"];
  ownerSaid?: boolean;
  ownerConfirmed?: boolean;
  subjectKind?: BeliefClaim["subjectKind"];
  at?: string;
  title?: string;
  by?: string;
};
function one(shape: Shape): BeliefClaim {
  const claim: Claim = {
    id: ClaimId.parse(`claim-${String(shape.n).padStart(3, "0")}`),
    content: { type: "role", subject: OWNER_ENTITY, fields: { title: shape.title ?? "Head of Finance" } },
    statementKind: "stated_fact",
    basis: shape.basis ?? "third_party",
    ...(shape.by === undefined ? {} : { assertedBy: shape.by as never }),
    validFrom: shape.at ?? at(0),
    evidence: [{ evidenceId: evidence(shape.n), span: "chars:0-10" }],
    primaryEvidenceId: evidence(shape.n),
    label: { compartments: ["own"], readers: [THE_OWNER] },
    destination: "personal",
    pipelineVersion: shape.pipeline ?? "personal-correspondence-3",
    extractorGeneration: 4,
    changeKind: "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  };
  return {
    claim,
    origin: shape.origin ?? "source",
    subjectKind: shape.subjectKind ?? "owner",
    ...(shape.ownerSaid === undefined ? {} : { ownerSaid: shape.ownerSaid }),
    ...(shape.ownerConfirmed === undefined ? {} : { ownerConfirmed: shape.ownerConfirmed }),
  };
}

describe("claimTier, for every origin, basis and confirmation", () => {
  it("an agent record's claim", () => {
    const agent = (pipeline: string, basis: Claim["basis"] = "third_party") =>
      one({ n: 1, origin: "agent_record", pipeline, basis });
    // Not confirmed: agent_inferred, whatever it is.
    for (const pipeline of [QUOTED_PROPOSAL_PIPELINE, ANSWER_PIPELINE, PROPOSAL_PIPELINE, "personal-agent-record-2"])
      expect(claimTier(agent(pipeline), false), pipeline).toBe("agent_inferred");
    // Confirmed: the owner's words relayed are the owner's; anything else they confirmed is owner_confirmed.
    expect(claimTier(agent(QUOTED_PROPOSAL_PIPELINE), true)).toBe("owner");
    // The answer from the owner to an agent's question, which nothing proves they gave, is owner_relayed: below their
    // card confirmations, above an agent's inference.
    expect(claimTier(agent(ANSWER_PIPELINE, "explicit_self"), true)).toBe("owner_relayed");
    expect(claimTier(agent(PROPOSAL_PIPELINE, "explicit_self"), true)).toBe("owner_relayed");
    expect(claimTier(agent(PROPOSAL_PIPELINE), true)).toBe("owner_confirmed");
    expect(claimTier(agent("personal-agent-record-2"), true)).toBe("owner_confirmed");
    // The source's marks do not reach an agent's claim.
    expect(claimTier({ ...agent(PROPOSAL_PIPELINE), ownerSaid: true, ownerConfirmed: true }, false)).toBe(
      "agent_inferred",
    );
  });

  it("a source's claim", () => {
    expect(claimTier(one({ n: 1 }), true)).toBe("source");
    expect(claimTier(one({ n: 1, basis: "explicit_self" }), true)).toBe("source");
    expect(claimTier(one({ n: 1, ownerSaid: true, basis: "explicit_self" }), true)).toBe("owner");
    expect(claimTier(one({ n: 1, ownerSaid: true, ownerConfirmed: true }), true)).toBe("owner_confirmed");
    expect(claimTier(one({ n: 1, ownerConfirmed: true }), false)).toBe("owner_confirmed");
    // A source claim that borrows an agent's pipeline version is still a source's.
    expect(claimTier(one({ n: 1, pipeline: QUOTED_PROPOSAL_PIPELINE }), true)).toBe("source");
    expect(claimTier(one({ n: 1, pipeline: ACTIVITY_PIPELINE, basis: "system_observed" }), true)).toBe("observed");
    expect(claimTier(one({ n: 1, basis: "system_observed" }), true)).toBe("source");
  });

  it("ranksAbove follows R11's order", () => {
    expect(ranksAbove("owner", "owner_confirmed")).toBe(true);
    expect(ranksAbove("owner_confirmed", "owner_relayed")).toBe(true);
    expect(ranksAbove("owner_relayed", "observed")).toBe(true);
    expect(ranksAbove("owner_relayed", "agent_inferred")).toBe(true);
    expect(ranksAbove("observed", "source")).toBe(true);
    expect(ranksAbove("source", "observed")).toBe(false);
    expect(ranksAbove("owner_confirmed", "source")).toBe(true);
    expect(ranksAbove("source", "agent_inferred")).toBe(true);
    expect(ranksAbove("source", "owner")).toBe(false);
    expect(ranksAbove("owner", "owner")).toBe(false);
  });
});

describe("beliefTier", () => {
  it("is the best kept claim's tier, never agent_inferred, and source with nothing better", () => {
    expect(beliefTier([])).toBe("source");
    expect(beliefTier([one({ n: 1 })])).toBe("source");
    expect(beliefTier([one({ n: 1 }), one({ n: 2, origin: "agent_record", pipeline: PROPOSAL_PIPELINE })])).toBe(
      "owner_confirmed",
    );
    expect(
      beliefTier([
        one({ n: 1 }),
        one({ n: 2, origin: "agent_record", pipeline: PROPOSAL_PIPELINE }),
        one({ n: 3, ownerSaid: true, basis: "explicit_self" }),
      ]),
    ).toBe("owner");
  });

  it("an observed claim ranks a belief above a source's and below the owner's word", () => {
    const observed = one({ n: 4, pipeline: ACTIVITY_PIPELINE, basis: "system_observed" });
    expect(beliefTier([one({ n: 1 }), observed])).toBe("observed");
    expect(beliefTier([observed, one({ n: 3, ownerSaid: true, basis: "explicit_self" })])).toBe("owner");
  });

  // Invariant 6 in the pure rule: a belief is built once per audience from that audience's claims,
  // so a claim outside it changes nothing of its tier.
  it("an audience that cannot see the owner-tier claim gets the tier of its own claims", () => {
    const owners = one({ n: 1, origin: "agent_record", pipeline: QUOTED_PROPOSAL_PIPELINE });
    const theirs = one({ n: 2 });
    expect(beliefTier([owners, theirs])).toBe("owner");
    expect(beliefTier([theirs])).toBe("source");
  });
});

describe("the tier in an owner-side dispute", () => {
  const latest = one({
    n: 2,
    at: at(10),
    title: "Chief of Staff",
    by: "ent_0000000000000000000000NORA",
    origin: "agent_record",
    pipeline: QUOTED_PROPOSAL_PIPELINE,
  });
  const earlier = one({ n: 1, at: at(0), title: "Head of Finance", by: "ent_0000000000000000000000THEO" });

  it("ownerSideTiers is given for a fact about the owner only", () => {
    expect(ownerSideTiers([earlier, latest])?.(latest.claim)).toBe("owner");
    expect(ownerSideTiers([earlier, latest])?.(earlier.claim)).toBe("source");
    expect(
      ownerSideTiers([
        { ...earlier, subjectKind: "person" },
        { ...latest, subjectKind: "person" },
      ]),
    ).toBeUndefined();
    expect(ownerSideTiers([])).toBeUndefined();
  });

  it("in a dispute about the owner an observed claim outranks another's statement and the owner's word outranks it", () => {
    const observed = one({ n: 5, pipeline: ACTIVITY_PIPELINE, basis: "system_observed" });
    const his = one({ n: 6, ownerSaid: true, basis: "explicit_self", by: OWNER_ENTITY });
    const tiers = ownerSideTiers([earlier, observed, his]);
    expect(tiers?.(observed.claim)).toBe("observed");
    expect(ranksAbove("observed", tiers?.(earlier.claim) ?? "owner")).toBe(true);
    expect(ranksAbove(tiers?.(his.claim) ?? "source", "observed")).toBe(true);
  });

  // The belief as buildBelief makes it from what `settle` gives it, as the belief build calls them.
  const built = (kept: readonly BeliefClaim[], asOf: string) => {
    const rule = BELIEF_RULES.role as BeliefRule;
    expect(kept.every((x) => rule.counts(x))).toBe(true);
    const { claims, conflict } = settle(rule, kept);
    const belief = buildBelief(claims, [], asOf, PERSONAL_ONTOLOGY, "fact", undefined, { conflict });
    return { support: belief?.support, disputed: belief?.disputed };
  };
  const OWNER_WORDS = { ownerSaid: true, basis: "explicit_self", by: OWNER_ENTITY } as const;

  // A belief holds no text value (its `values` are the typed fields), so the answer is read from
  // its support: the claim left alone in it is the answer.
  it("a higher tier is the answer whichever came first, and disputes nothing", () => {
    // The relayed quote (claim-002) over a colleague's word (claim-001), later and earlier.
    expect(built([earlier, latest], at(10))).toEqual({ support: ["claim-002"], disputed: false });
    expect(
      built(
        [
          { ...earlier, claim: { ...earlier.claim, validFrom: at(20) } },
          { ...latest, claim: { ...latest.claim, validFrom: at(0) } },
        ],
        at(20),
      ),
    ).toEqual({ support: ["claim-002"], disputed: false });
  });

  it("the owner writes CTO; a colleague's later VP neither disputes it within 30 days nor supersedes it after", () => {
    const owners = one({ n: 1, at: at(0), title: "CTO", ...OWNER_WORDS });
    expect(claimTier(owners, true)).toBe("owner");
    for (const days of [10, 40]) {
      const colleague = one({ n: 2, at: at(days), title: "VP", by: "ent_0000000000000000000000NORA" });
      expect(built([owners, colleague], at(days)), `${days} days`).toEqual({ support: ["claim-001"], disputed: false });
    }
    // The other order: the colleague first, the owner after.
    const colleague = one({ n: 2, at: at(0), title: "VP", by: "ent_0000000000000000000000NORA" });
    for (const days of [10, 40])
      expect(
        built([colleague, one({ n: 1, at: at(days), title: "CTO", ...OWNER_WORDS })], at(days)),
        `${days} days`,
      ).toEqual({ support: ["claim-001"], disputed: false });
  });

  it("claims of one tier keep R16: two colleagues dispute within 30 days, and the later wins after", () => {
    const theo = one({ n: 1, at: at(0), title: "CTO", by: "ent_0000000000000000000000THEO" });
    expect(built([theo, one({ n: 2, at: at(10), title: "VP", by: "ent_0000000000000000000000NORA" })], at(10))).toEqual(
      { support: ["claim-001", "claim-002"], disputed: true },
    );
    expect(built([theo, one({ n: 2, at: at(40), title: "VP", by: "ent_0000000000000000000000NORA" })], at(40))).toEqual(
      { support: ["claim-001", "claim-002"], disputed: false },
    );
    // A lower-tier claim that states what the higher one does stays in support.
    const same = one({ n: 3, at: at(10), title: "CTO", by: "ent_0000000000000000000000NORA" });
    expect(
      settle(BELIEF_RULES.role as BeliefRule, [one({ n: 1, at: at(0), title: "CTO", ...OWNER_WORDS }), same]).claims,
    ).toHaveLength(2);
  });

  it("the owner's correction outranks every claim of its key that states something else, before or after it", () => {
    const person = (shape: Shape): BeliefClaim => one({ ...shape, subjectKind: "person" });
    const correction = (n: number, days: number, title: string) =>
      person({ n, at: at(days), title, origin: "owner_command", pipeline: CORRECTION_PIPELINE });
    const nora = person({ n: 1, at: at(0), title: "VP", by: "ent_0000000000000000000000NORA" });
    const theo = person({ n: 2, at: at(20), title: "VP", by: "ent_0000000000000000000000THEO" });
    const agrees = person({ n: 3, at: at(15), title: "CTO", by: "ent_0000000000000000000000THEO" });
    const his = correction(4, 10, "CTO");
    expect(built([nora, his, theo, agrees], at(20))).toEqual({ support: ["claim-003", "claim-004"], disputed: false });
    // A later correction of the owner's replaces an earlier one.
    expect(built([his, correction(5, 12, "COO"), theo], at(20))).toEqual({ support: ["claim-005"], disputed: false });
    // The control: the owner's goal command's claim (another pipeline) is no correction, and keeps the
    // ordinary dispute between claims of one tier.
    const command = person({ n: 6, at: at(10), title: "CTO", origin: "owner_command", pipeline: "owner_command@1" });
    expect(settle(BELIEF_RULES.role as BeliefRule, [nora, command]).claims).toHaveLength(2);
  });

  it("with no tiers (another subject) every claim is kept", () => {
    const person = [
      { ...earlier, subjectKind: "person" as const },
      { ...latest, subjectKind: "person" as const },
    ];
    expect(settle(BELIEF_RULES.role as BeliefRule, person).claims).toHaveLength(2);
    expect(differs(person.map((x) => x.claim))).toBe(true);
  });
});

// A new-shape situation is compared by its key phrase, `state`, so two that differ can dispute, as
// two that differ in `what` always could.
describe("a situation in the new shape is compared by its state", () => {
  const situation = (n: number, fields: Record<string, unknown>, by: string): Claim => ({
    ...one({ n, at: at(n), by }).claim,
    content: { type: "situation", subject: OWNER_ENTITY, fields },
  });
  it("different states dispute; the same state does not; a legacy what still compares", () => {
    const nora = "ent_0000000000000000000000NORA";
    const theo = "ent_0000000000000000000000THEO";
    expect(
      differs([
        situation(1, { domain: "career", state: "on leave", momentary: false }, nora),
        situation(2, { domain: "career", state: "moving to Lisbon", momentary: false }, theo),
      ]),
    ).toBe(true);
    expect(
      differs([
        situation(1, { domain: "career", state: "on leave", momentary: false }, nora),
        situation(2, { domain: "career", state: "On leave", momentary: false }, theo),
      ]),
    ).toBe(false);
    expect(differs([situation(1, { what: "on leave" }, nora), situation(2, { what: "moving to Lisbon" }, theo)])).toBe(
      true,
    );
  });
});

describe("third-party roles and affiliations of the owner", () => {
  it("count when stated, never when asked, and never another owner-side kind", () => {
    const stated = one({ n: 1, by: "ent_0000000000000000000000NORA" });
    expect(BELIEF_RULES.role?.counts(stated)).toBe(true);
    expect(BELIEF_RULES.affiliation?.counts(stated)).toBe(true);
    expect(claimTier(stated, true)).toBe("source");
    const asked: BeliefClaim = { ...stated, claim: { ...stated.claim, statementKind: "question" } };
    expect(BELIEF_RULES.role?.counts(asked)).toBe(false);
    const system: BeliefClaim = { ...stated, claim: { ...stated.claim, systemOriginated: true } };
    expect(BELIEF_RULES.role?.counts(system)).toBe(false);
    for (const kind of ["goal", "need", "capability", "preference", "constraint", "situation"] as const)
      expect(BELIEF_RULES[kind]?.counts(stated), kind).toBe(false);
  });
});

// Invariant 5 (model output and client arguments can only narrow): on the memory store.
describe("invariant 5: a quote builds no belief unconfirmed, and no argument sets a tier", () => {
  const QUOTED = {
    kind: "goal",
    fields: { domain: "health", objective: "run a half marathon" },
    scope: "all",
    quote: "This year I want to run a half marathon.",
  };
  const put = (s: Setup, body: unknown) =>
    s.store.putRecord({
      client: "alpha",
      kind: "proposal",
      body: recordBody(body),
      recordedAt: new Date(Date.parse(s.w.now) - 3_600_000).toISOString() as never,
    });
  const ownerBeliefs = async (s: Setup) => {
    const { rebuildBeliefs } = await import("./test-support/rebuild.ts");
    await rebuildBeliefs(s.deps);
    return s.store.beliefs(await s.store.ownerAudience()).filter((row) => row.belief.subject === OWNER_ENTITY);
  };

  it("a quoted proposal with no confirmation builds no belief; confirmed, one whose claim is the owner's tier", async () => {
    const s = await setup();
    const id = put(s, QUOTED);
    expect(await processRecord(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(await ownerBeliefs(s)).toEqual([]);
    s.store.confirm(id);
    expect((await ownerBeliefs(s)).map((row) => row.belief.kind)).toEqual(["goal"]);
    const [given] = (await s.store.beliefClaims())
      .flatMap((group) => group.claims)
      .filter((x) => x.claim.primaryEvidenceId === id);
    if (given === undefined) throw new Error("no claim given");
    expect(given.claim.pipelineVersion).toBe(QUOTED_PROPOSAL_PIPELINE);
    expect(beliefTier([given])).toBe("owner");
  });

  it("a body that names a tier, a channel, a basis or a provenance builds nothing", async () => {
    const s = await setup();
    for (const key of ["tier", "channel", "basis", "provenance"]) {
      const id = put(s, { ...QUOTED, [key]: key === "channel" ? "beta" : "owner" });
      expect(await processRecord(s, id), key).toMatchObject({ status: "skipped", code: "bad_proposal", claims: 0 });
      s.store.confirm(id);
    }
    expect(await ownerBeliefs(s)).toEqual([]);
  });
});

describe("a system notice's tier", () => {
  const sender = "ent_0000000000000000000000SEND";
  const notice = (n: number, fields: Record<string, unknown>, extra: Partial<Claim> = {}): BeliefClaim => {
    const base = one({ n, at: at(n) });
    return {
      ...base,
      claim: {
        ...base.claim,
        content: { type: "situation", subject: OWNER_ENTITY, fields },
        pipelineVersion: "personal-transaction-2",
        ...extra,
      },
      notice: true,
    };
  };
  const inProcess = notice(1, { domain: "travel", state: "passport application is In Process" });
  const mailed = notice(8, { domain: "travel", state: "supporting documents were mailed" });

  // Third review: isSystemNotice is the check's mark alone, one definition; the check sets it only
  // where every other condition holds (eval-transactions.test.ts, "what counts as a notice").
  it("isSystemNotice is the check's notice mark, and nothing else", () => {
    expect(isSystemNotice({ notice: true })).toBe(true);
    expect(isSystemNotice({})).toBe(false);
    expect(isSystemNotice({ notice: undefined })).toBe(false);
  });

  it("is system_notice, below observed and above source; never the owner's word, whatever its basis", () => {
    expect(claimTier(inProcess, true)).toBe("system_notice");
    expect(claimTier({ ...inProcess, claim: { ...inProcess.claim, basis: "explicit_self" } }, true)).toBe(
      "system_notice",
    );
    expect(
      claimTierOf({
        origin: "source",
        pipelineVersion: "personal-transaction-2",
        basis: "third_party",
        ownerSaid: false,
        confirmed: false,
        notice: true,
      }),
    ).toBe("system_notice");
    expect(
      claimTierOf({
        origin: "source",
        pipelineVersion: "personal-transaction-2",
        basis: "third_party",
        ownerSaid: false,
        confirmed: false,
      }),
    ).toBe("source");
    expect(ranksAbove("observed", "system_notice")).toBe(true);
    expect(ranksAbove("system_notice", "source")).toBe(true);
    for (const his of ["owner", "owner_confirmed"] as const) expect(ranksAbove(his, "system_notice")).toBe(true);
    // ownStatement: a notice is not the owner's own words, the speaker being the sender.
    expect(ownStatement(inProcess.claim, inProcess.ownerSaid === true)).toBe(false);
    expect(beliefTier([inProcess])).toBe("system_notice");
    expect(beliefTier([inProcess, one({ n: 3, ownerSaid: true, basis: "explicit_self" })])).toBe("owner");
  });

  const built = (kept: readonly BeliefClaim[], asOf: string) => {
    const rule = BELIEF_RULES.situation as BeliefRule;
    const counted = kept.filter((x) => rule.counts(x));
    const { claims, conflict } = settle(rule, counted);
    const belief = buildBelief(claims, [], asOf, PERSONAL_ONTOLOGY, "fact", undefined, { conflict });
    return { counted: counted.map((x) => x.claim.id), support: belief?.support, disputed: belief?.disputed };
  };

  // Third review: a question, a reversal or mail the system sent never gets the mark (the check's
  // tests), so the rule reads the mark alone, beside `ownerSaid`.
  it("counts in the owner's situation as a statement; without the mark a third party's word about the owner does not", () => {
    expect(built([inProcess], at(1))).toEqual({ counted: ["claim-001"], support: ["claim-001"], disputed: false });
    expect(BELIEF_RULES.situation?.counts({ ...inProcess, ownerSaid: true })).toBe(false);
    const { notice: _mark, ...unmarked } = inProcess;
    expect(BELIEF_RULES.situation?.counts(unmarked)).toBe(false);
  });

  it("a later notice supersedes an earlier one from the same sender or another, within 30 days, with no dispute", () => {
    expect(built([inProcess, mailed], at(8))).toEqual({
      counted: ["claim-001", "claim-008"],
      support: ["claim-001", "claim-008"],
      disputed: false,
    });
    const fromSender = (one: BeliefClaim): BeliefClaim => ({
      ...one,
      claim: { ...one.claim, assertedBy: sender as never },
    });
    expect(built([fromSender(inProcess), fromSender(mailed)], at(8)).disputed).toBe(false);
  });

  // One message's two statuses on one key are a dispute, never one dropping the other.
  it("two notice claims of one message that state different things dispute the belief, and both stay in it", () => {
    const sameMessage = (n: number, state: string): BeliefClaim => {
      const base = notice(n, { domain: "admin", state }, { validFrom: at(3) as never });
      return {
        ...base,
        claim: {
          ...base.claim,
          primaryEvidenceId: evidence(3),
          evidence: [{ evidenceId: evidence(3), span: `chars:${n}-${n + 5}` }],
        },
      };
    };
    const approved = sameMessage(3, "license renewal approved");
    const expired = sameMessage(4, "registration expired");
    expect(built([approved, expired], at(3))).toEqual({
      counted: ["claim-003", "claim-004"],
      support: ["claim-003", "claim-004"],
      disputed: true,
    });
    // A later message from the sender still supersedes both, with no dispute.
    expect(built([approved, expired, mailed], at(8)).disputed).toBe(false);
  });

  it("the owner's own word that states something else outranks it, whichever came first, and the notice never disputes or closes it", () => {
    const his = {
      ...one({ n: 5, at: at(5), ownerSaid: true, basis: "explicit_self", by: OWNER_ENTITY }),
      claim: {
        ...one({ n: 5, at: at(5), by: OWNER_ENTITY }).claim,
        basis: "explicit_self" as const,
        content: {
          type: "situation",
          subject: OWNER_ENTITY,
          fields: { domain: "travel", state: "planning a trip to Lisbon" },
        },
      },
    };
    expect(claimTier(his, true)).toBe("owner");
    expect(built([inProcess, his], at(5))).toEqual({
      counted: ["claim-001", "claim-005"],
      support: ["claim-005"],
      disputed: false,
    });
    expect(built([his, mailed], at(8))).toEqual({
      counted: ["claim-005", "claim-008"],
      support: ["claim-005"],
      disputed: false,
    });
    // A heard claim is still left out where the owner's word is; a notice is no word of the owner's, so
    // it does not remove a heard one where the owner's word is absent.
    const heard = {
      ...one({ n: 6, at: at(6) }),
      claim: {
        ...one({ n: 6, at: at(6) }).claim,
        content: {
          type: "situation",
          subject: OWNER_ENTITY,
          fields: { domain: "travel", state: "passport application is In Process" },
        },
        evidence: [{ evidenceId: evidence(6), span: "seg:0-10" }],
      },
      meeting: true as const,
    };
    expect(settle(BELIEF_RULES.situation as BeliefRule, [inProcess, heard]).claims.map((claim) => claim.id)).toContain(
      "claim-006",
    );
  });
});
