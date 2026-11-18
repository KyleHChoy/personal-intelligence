import {
  DECISION_DETAILS,
  FactSettlement,
  IdentityException,
  IdentityRulingView,
  OwnerDecisionDetails,
  OwnerDecisionKind,
  PolicyMergeRefusal,
  SettledReport,
  SweepSettledCounts,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// Fewer cards by code: the settled-card contracts. Made-up values only.
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-10-22T10:00:00Z";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

describe("fewer-cards contracts", () => {
  const settlement = {
    id: `fst_${ULID}`,
    claimKey: "a".repeat(64),
    card: `crd_${ULID}`,
    answer: "confirmed",
    createdAt: at,
    reopenedAt: null,
  };

  it("a FactSettlement holds no text a person or model wrote", () => {
    expect(accepts(FactSettlement, settlement)).toBe(true);
    expect(accepts(FactSettlement, { ...settlement, reopenedAt: at, answer: "waiting" })).toBe(true);
    // Each field an id, a closed code or a time: text anywhere is refused.
    expect(accepts(FactSettlement, { ...settlement, claimKey: "lives in Portland" })).toBe(false);
    expect(accepts(FactSettlement, { ...settlement, answer: "maybe" })).toBe(false);
    expect(accepts(FactSettlement, { ...settlement, card: "the card about Portland" })).toBe(false);
    expect(accepts(FactSettlement, { ...settlement, note: "why" })).toBe(false);
    expect(accepts(FactSettlement, { ...settlement, createdAt: "yesterday" })).toBe(false);
  });

  it("the settled block's exception codes are exactly the four", () => {
    expect(IdentityException.options).toEqual(["ruled_different", "lifted_before", "common_name", "unestablished"]);
    const zero = (codes: readonly string[]) => Object.fromEntries(codes.map((code) => [code, 0]));
    const counts = { merged: 0, carded: zero(IdentityException.options), refused: zero(PolicyMergeRefusal.options) };
    expect(accepts(SweepSettledCounts, counts)).toBe(true);
    expect(accepts(SweepSettledCounts, { ...counts, carded: { ...counts.carded, shared_address: 1 } })).toBe(false);
    const facts = { confirmed: 1, rejected: 0, vetoed: 0, waiting: 2, withdrawn: 0, reopened: 0 };
    const report = {
      facts: { about_you: facts, agent_claim: facts },
      identity: { merged: { contact: 1, phone: 0, name: 0, local_part: 0 }, carded: 3 },
    };
    expect(accepts(SettledReport, report)).toBe(true);
    expect(accepts(SettledReport, { ...report, identity: { ...report.identity, ids: [`rul_${ULID}`] } })).toBe(false);
    expect(
      accepts(SettledReport, { ...report, facts: { ...report.facts, about_you: { ...facts, confirmed: -1 } } }),
    ).toBe(false);
  });

  it("PolicyMergeRefusal is exactly the function's eight codes", () => {
    expect(PolicyMergeRefusal.options).toEqual([
      "merges_off",
      "basis_absent",
      "not_established",
      "excepted",
      "suppressed",
      "owner_address",
      "not_a_person",
      "already_settled",
    ]);
  });

  it("an IdentityRulingView with by policy carries a basis", () => {
    const view = {
      id: `rul_${ULID}`,
      verdict: "same",
      a: `ent_${ULID}`,
      b: "ent_01JABCDEFGHJKMNPQRSTVWXYZ1",
      at,
      liftedAt: null,
    };
    expect(IdentityRulingView.parse(view).by).toBe("owner");
    expect(accepts(IdentityRulingView, { ...view, by: "policy", basis: "name" })).toBe(true);
    expect(accepts(IdentityRulingView, { ...view, by: "policy" })).toBe(false);
    expect(accepts(IdentityRulingView, { ...view, basis: "contact" })).toBe(false);
    expect(accepts(IdentityRulingView, { ...view, verdict: "different", by: "policy", basis: "contact" })).toBe(false);
  });

  it("identity_policy is a decision kind whose details are its basis alone", () => {
    expect(OwnerDecisionKind.parse("identity_policy")).toBe("identity_policy");
    const details = DECISION_DETAILS.identity_policy;
    expect(details).toBeDefined();
    expect(accepts(details as never, { basis: "local_part" })).toBe(true);
    expect(accepts(details as never, { basis: "guess" })).toBe(false);
    expect(accepts(details as never, {})).toBe(false);
    expect(accepts(OwnerDecisionDetails, { basis: "contact" })).toBe(true);
  });
});
