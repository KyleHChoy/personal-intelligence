import { type ClaimRecord, PromotionBundle, PromotionMessage } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { bundleOf, noticeOf, promotedClaims, whyNotPromotable } from "./promotion-bundle.ts";

// What one promotion carries, made by code (promotion-bundle.ts), and the strict shape a receiver
// parses it with. Synthetic records only.

const PERSON = "ent_01HZZZZZZZZZZZZZZZZZZZZZZA";
const OTHER = "ent_01HZZZZZZZZZZZZZZZZZZZZZZB";
const ORG = "ent_01HZZZZZZZZZZZZZZZZZZZZZZC";
const PROVENANCE = "a".repeat(64);
const RELEASE = { by: "owner", via: "command", at: "2026-03-10T12:00:00.000Z" } as const;

function record(options: {
  subject?: string;
  fields?: Record<string, unknown>;
  fieldKinds?: Record<string, string>;
  origin?: string;
  released?: true;
  disclosure?: string[];
}): ClaimRecord {
  return {
    claim: {
      id: "c".repeat(64),
      content: {
        type: "role",
        subject: options.subject ?? PERSON,
        fields: options.fields ?? { title: "harbour pilot", organization: ORG },
      },
      statementKind: "stated_fact",
      basis: "third_party",
      validFrom: "2026-03-01T09:00:00.000Z",
      evidence: [],
      primaryEvidenceId: "evidence",
      label: { compartments: ["own"], readers: ["owner"] },
      destination: "personal",
      pipelineVersion: "1",
      extractorGeneration: 1,
      changeKind: "live",
      systemOriginated: false,
      origin: "source",
      identityEpoch: 0,
    },
    subjectKind: "person",
    disclosure: options.disclosure ?? [],
    factKey: "role:key",
    lane: "correspondence",
    fieldKinds: options.fieldKinds ?? { title: "text", organization: "entity" },
    entities: [options.subject ?? PERSON],
    origin: options.origin ?? "source",
    answersSystem: false,
    ...(options.released === true ? { released: { ruling: "rul_01HZZZZZZZZZZZZZZZZZZZZZZA" } } : {}),
  } as unknown as ClaimRecord;
}

describe("whyNotPromotable", () => {
  it("passes a source's or the owner's claim labelled exactly own or public", () => {
    expect(whyNotPromotable(["own"], record({}))).toBeUndefined();
    expect(whyNotPromotable(["public"], record({ origin: "owner_command" }))).toBeUndefined();
  });

  it("refuses any other label, an agent's claim, a released copy, a third party's fact and a statement of entities alone", () => {
    expect(whyNotPromotable(["employer:example"], record({}))).toBe("label");
    expect(whyNotPromotable(["own", "agent:atlas"], record({}))).toBe("label");
    expect(whyNotPromotable(["own", "public"], record({}))).toBe("label");
    expect(whyNotPromotable(["restricted:health"], record({}))).toBe("label");
    for (const origin of ["agent_record", "agent_close", "agent_research"])
      expect(whyNotPromotable(["own"], record({ origin }))).toBe("origin");
    expect(whyNotPromotable(["own"], record({ released: true }))).toBe("origin");
    expect(whyNotPromotable(["own"], record({ disclosure: ["third_party"] }))).toBe("third_party");
    expect(
      whyNotPromotable(["own"], record({ fields: { organization: ORG }, fieldKinds: { organization: "entity" } })),
    ).toBe("statement");
  });
});

describe("promotedClaims and bundleOf", () => {
  it("carries kinds and statements with refs, never an entity id, and is the same bytes each time", () => {
    const claims = promotedClaims([record({}), record({ subject: OTHER }), record({})]);
    expect(claims).toBeDefined();
    const bundle = bundleOf(PROVENANCE, RELEASE, claims ?? []);
    expect(bundle.claims.map((claim) => [claim.ref, claim.subject.ref])).toEqual([
      ["c1", "s1"],
      ["c2", "s2"],
      ["c3", "s1"],
    ]);
    expect(bundle.claims[0]?.statement).toEqual({ title: "harbour pilot" });
    const text = JSON.stringify(bundle);
    for (const id of [PERSON, OTHER, ORG, "c".repeat(64), "evidence"]) expect(text).not.toContain(id);
    expect(text).not.toContain("compartments");
    expect(
      JSON.stringify(
        bundleOf(PROVENANCE, RELEASE, promotedClaims([record({}), record({ subject: OTHER }), record({})]) ?? []),
      ),
    ).toBe(text);
    // The receiver's parse takes it whole.
    expect(PromotionMessage.parse(JSON.parse(text))).toEqual(bundle);
  });

  it("refuses text shaped like an id, a value no promotion carries, and more claims than one promotion holds", () => {
    expect(promotedClaims([record({ fields: { title: `see ${PERSON}` } })])).toBeUndefined();
    expect(promotedClaims([record({ fields: { title: `key ${"f".repeat(64)}` } })])).toBeUndefined();
    expect(promotedClaims([record({ fields: { title: ["a", "b"] } })])).toBeUndefined();
    expect(promotedClaims([])).toBeUndefined();
    expect(promotedClaims(Array.from({ length: 51 }, () => record({})))).toBeUndefined();
  });
});

describe("the receiver's parse", () => {
  const bundle = bundleOf(PROVENANCE, RELEASE, promotedClaims([record({})]) ?? []);
  const claim = bundle.claims[0];

  it("refuses anything but exactly a bundle or a notice", () => {
    const refused = [
      { ...bundle, compartments: ["own"] },
      { ...bundle, claims: [{ ...claim, label: { compartments: ["own"] } }] },
      { ...bundle, claims: [{ ...claim, id: "c".repeat(64) }] },
      { ...bundle, claims: [{ ...claim, subject: { ...claim?.subject, id: PERSON } }] },
      { ...bundle, claims: [{ ...claim, statement: { title: `see ${PERSON}` } }] },
      { ...bundle, claims: [{ ...claim, statement: { title: { nested: "x" } } }] },
      { ...bundle, claims: [claim, claim] },
      { ...bundle, claims: [] },
      { ...bundle, provenance: "not-a-hash" },
      { ...bundle, release: { ...bundle.release, by: "agent" } },
      { ...bundle, version: 2 },
      { ...noticeOf(PROVENANCE, RELEASE.at), claims: [] },
      "a bundle",
      null,
    ];
    for (const one of refused) expect(PromotionMessage.safeParse(one).success, JSON.stringify(one)).toBe(false);
    // The positive controls.
    expect(PromotionBundle.safeParse(bundle).success).toBe(true);
    expect(PromotionMessage.safeParse(noticeOf(PROVENANCE, RELEASE.at)).success).toBe(true);
  });
});
