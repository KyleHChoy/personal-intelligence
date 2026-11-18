import { type Claim, ClaimId, EvidenceId, LocalEntityId } from "@intelligence/contracts";
import type { BeliefCheckMark, BeliefClaim, BeliefRelation, BeliefSettlement } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { describe, expect, it } from "vitest";
import { type BeliefInputs, beliefsFor } from "./belief-at.ts";
import { RULE_PREVAILS } from "./relations.ts";

// At read: an agent's settlement settles a dispute code could not, above the
// evidence order, only for an audience that sees both claims and holds its label; a failing source
// check marks a belief unsupported only for an audience that holds the check's label and whose belief
// rests on exactly the check's claims (invariant 6). Synthetic ids and invented values.

const NORA = LocalEntityId.parse("ent_0000000000000000000000NORA");
const THEO = LocalEntityId.parse("ent_0000000000000000000000THEO");
const IDA = LocalEntityId.parse("ent_00000000000000000000000IDA");
const ALDER = LocalEntityId.parse("ent_000000000000000000000ALDER");
const BRIGHT = LocalEntityId.parse("ent_00000000000000000000BRIGHT");
const DAY = 86_400_000;
const day = (n: number): string => new Date(Date.parse("2026-05-01T10:00:00.000Z") + n * DAY).toISOString();
const key = (n: number): string => n.toString(16).padStart(64, "c");

function claimOf(n: number, by: string, at: string, organization: string, compartment = "own"): BeliefClaim {
  const id = EvidenceId.parse(n.toString(16).padStart(64, "0"));
  const claim = {
    id: ClaimId.parse(`claim-${String(n).padStart(3, "0")}`),
    content: { type: "role", subject: NORA, fields: { title: "Lead", organization } },
    statementKind: "stated_fact",
    basis: "third_party",
    assertedBy: by,
    validFrom: at,
    evidence: [{ evidenceId: id, span: "chars:0-24" }],
    primaryEvidenceId: id,
    label: { compartments: [compartment], readers: [THE_OWNER] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 2,
    changeKind: "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  } as unknown as Claim;
  return { claim, origin: "source", subjectKind: "person", ownerSaid: false, keys: [key(n)] };
}

const first = claimOf(1, THEO, day(1), ALDER);
const second = claimOf(2, IDA, day(3), BRIGHT);
const NOW = day(60);
const inputs = (extra: Partial<BeliefInputs>, claims: BeliefClaim[] = [first, second]): BeliefInputs => ({
  groups: [{ factKeyFp: "f".repeat(64), claims }],
  decisions: [],
  retirements: [],
  reclassifications: [],
  goAt: null,
  ...extra,
});
const settlement = (holds: number, extra: Partial<BeliefSettlement> = {}): BeliefSettlement => ({
  id: "set-1",
  a: key(1),
  b: key(2),
  holds: key(holds),
  at: day(40),
  compartments: ["own"],
  ...extra,
});

describe("an agent's settlement at read", () => {
  it("settles the dispute to the claim it holds current, still disputed, marked as the agent's", () => {
    const [plain] = beliefsFor(inputs({}), ["own"], NOW).rows;
    expect(plain?.belief.disputed).toBe(true);
    expect(plain?.belief.values.organization).toBe(BRIGHT);
    const [settled] = beliefsFor(inputs({ settlements: [settlement(1)] }), ["own"], NOW).rows;
    expect(settled?.belief.values.organization).toBe(ALDER);
    expect(settled?.belief.disputed).toBe(true);
    expect(settled?.settled).toEqual({ by: "agent", winner: "claim-001", losing: ["claim-002"], sources: 1 });
  });

  it("outranks the evidence order: a rule's prevails the other way gives way to it", () => {
    const rule: BeliefRelation = {
      id: "r1",
      from: key(2),
      to: key(1),
      kind: "prevails",
      judge: RULE_PREVAILS,
      judgedAt: day(30),
      compartments: ["own"],
    };
    const [byRule] = beliefsFor(inputs({ relations: [rule] }), ["own"], NOW).rows;
    expect(byRule?.settled?.by).toBe("rule");
    const [byAgent] = beliefsFor(inputs({ relations: [rule], settlements: [settlement(1)] }), ["own"], NOW).rows;
    expect(byAgent?.settled).toMatchObject({ by: "agent", winner: "claim-001" });
  });

  it("changes nothing for an audience that does not hold its label or see both claims (invariant 6)", () => {
    const plain = beliefsFor(inputs({}), ["own"], NOW);
    const wide = settlement(1, { compartments: ["employer:example", "own"] });
    expect(beliefsFor(inputs({ settlements: [wide] }), ["own"], NOW)).toEqual(plain);
    // A settlement naming a claim this read does not hold.
    const one = beliefsFor(inputs({}, [first]), ["own"], NOW);
    expect(beliefsFor(inputs({ settlements: [settlement(1)] }, [first]), ["own"], NOW)).toEqual(one);
    // Made after the read's time.
    expect(beliefsFor(inputs({ settlements: [settlement(1, { at: day(70) })] }), ["own"], NOW)).toEqual(plain);
  });
});

describe("an unsupported mark at read", () => {
  const mark = (extra: Partial<BeliefCheckMark> = {}): BeliefCheckMark => ({
    claimKeys: [key(1), key(2)],
    verdict: "unsupported",
    at: day(50),
    compartments: ["own"],
    ...extra,
  });

  it("marks the belief that rests on exactly the check's claims, under a label the audience holds", () => {
    const [row] = beliefsFor(inputs({ beliefChecks: [mark()] }), ["own"], NOW).rows;
    expect(row?.unsupported).toBe(true);
    const [wrong] = beliefsFor(inputs({ beliefChecks: [mark({ verdict: "wrong" })] }), ["own"], NOW).rows;
    expect(wrong?.unsupported).toBe(true);
  });

  it("no mark for other claims, a wider label, a later supported check, or a check after the read", () => {
    const plain = beliefsFor(inputs({}), ["own"], NOW);
    for (const beliefChecks of [
      [mark({ claimKeys: [key(1)] })],
      [mark({ claimKeys: [key(1), key(2), key(3)] })],
      [mark({ compartments: ["employer:example", "own"] })],
      [mark(), mark({ verdict: "supported", at: day(55) })],
      [mark({ at: day(70) })],
    ])
      expect(beliefsFor(inputs({ beliefChecks }), ["own"], NOW)).toEqual(plain);
  });
});
