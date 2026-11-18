import { describe, expect, it } from "vitest";
import { aliasFingerprint, aliasKeyNormal } from "./alias-key.ts";
import { Belief, BeliefKind, Claim, ContentKeys, DataKey, Envelope, Fingerprint, Routed, TypedValue } from "./index.ts";
import { closedList } from "./test-checks.ts";
import {
  at,
  claim,
  claimMessage,
  dataKey,
  deletionMessage,
  envelope,
  label,
  sha,
  signedLabel,
} from "./test-samples.ts";

describe("claims", () => {
  it("accepts a well-formed claim", () => {
    expect(Claim.safeParse(claim).success).toBe(true);
  });

  it("rejects a claim with no evidence", () => {
    expect(Claim.safeParse({ ...claim, evidence: [] }).success).toBe(false);
  });

  it("rejects a primary evidence id the claim does not cite", () => {
    expect(Claim.safeParse({ ...claim, primaryEvidenceId: "ev-9" }).success).toBe(false);
  });

  it("rejects a claim whose origin is not a listed one", () => {
    expect(Claim.safeParse({ ...claim, origin: "model" }).success).toBe(false);
  });

  it("carries the subject's alias keys as fingerprints and names, never an address", () => {
    const fingerprint = "ab".repeat(32);
    expect(
      Claim.safeParse({
        ...claim,
        subjectAliases: [
          { kind: "address", fingerprint },
          { kind: "name", value: "Maya Okonkwo" },
        ],
      }).success,
    ).toBe(true);
    expect(Claim.safeParse({ ...claim, subjectAliases: [{ kind: "source_id", fingerprint }] }).success).toBe(true);
    expect(Claim.safeParse({ ...claim, subjectAliases: [] }).success).toBe(true);
    expect(
      Claim.safeParse({ ...claim, subjectAliases: [{ kind: "address", value: "maya@corvane.example" }] }).success,
    ).toBe(false);
    expect(Claim.safeParse({ ...claim, subjectAliases: [{ kind: "name", fingerprint }] }).success).toBe(false);
    expect(Claim.safeParse({ ...claim, subjectAliases: [{ kind: "name", value: "" }] }).success).toBe(false);
    // White space only, the ideographic space included: its normal form is empty.
    for (const value of [" ", "\t\n", "\u3000", " \u00a0 "])
      expect(Claim.safeParse({ ...claim, subjectAliases: [{ kind: "name", value }] }).success).toBe(false);
    expect(Claim.safeParse({ ...claim, subjectAliases: [{ kind: "name", value: "x".repeat(201) }] }).success).toBe(
      false,
    );
    expect(
      Claim.safeParse({ ...claim, subjectAliases: Array.from({ length: 9 }, () => ({ kind: "name", value: "n" })) })
        .success,
    ).toBe(false);
  });
});

describe("alias keys", () => {
  it("fingerprints a key by its normal form, apart by kind, and refuses an empty one", () => {
    expect(aliasKeyNormal("address", " Maya@Corvane.example ")).toBe("maya@corvane.example");
    expect(aliasKeyNormal("name", " \uff2daya   OKONKWO ")).toBe("maya okonkwo");
    expect(aliasKeyNormal("source_id", "CRM-1 ")).toBe("CRM-1 ");
    expect(aliasFingerprint("address", " Maya@Corvane.example ")).toBe(
      aliasFingerprint("address", "maya@corvane.example"),
    );
    expect(aliasFingerprint("address", "\u017feph@b.example")).not.toBe(aliasFingerprint("address", "seph@b.example"));
    expect(aliasFingerprint("address", "sam")).not.toBe(aliasFingerprint("name", "sam"));
    expect(aliasFingerprint("source_id", "CRM-1")).not.toBe(aliasFingerprint("source_id", "crm-1"));
    const key = new Uint8Array(32).fill(7);
    expect(aliasFingerprint("name", "sam", key)).not.toBe(aliasFingerprint("name", "sam"));
    expect(aliasFingerprint("name", "sam", key)).toBe(aliasFingerprint("name", "SAM", key));
    expect(() => aliasFingerprint("name", "   ")).toThrow("empty_alias_key");
    expect(Fingerprint.safeParse(aliasFingerprint("address", "a@b.example")).success).toBe(true);
  });
});

describe("beliefs", () => {
  const belief = {
    kind: "need",
    factKey: "fk-1",
    supportHash: sha,
    subject: "e-maya",
    type: "need.hiring",
    values: { role: "cfo", open: true },
    label,
    status: "active",
    disputed: false,
    confidence: 0.5,
    lastConfirmedAt: at,
    changeKind: "live",
    support: ["c-1"],
  };

  it("accepts a well-formed belief", () => {
    expect(Belief.safeParse(belief).success).toBe(true);
  });

  it("BeliefKind lists every kind, the personal ones included", () => {
    closedList(BeliefKind, [
      "need",
      "capability",
      "role",
      "affiliation",
      "relationship",
      "commitment",
      "decision",
      "project_status",
      "consent",
      "contact_rule",
      "goal",
      "preference",
      "constraint",
      "situation",
      "capture_project",
      "interest",
      "view",
      "status",
      "visited",
    ]);
  });

  it("rejects a belief of a kind that is not kept", () => {
    expect(Belief.safeParse({ ...belief, kind: "remark" }).success).toBe(false);
  });

  it("rejects a belief with no support", () => {
    expect(Belief.safeParse({ ...belief, support: [] }).success).toBe(false);
  });

  it("rejects a sentence as a belief value", () => {
    expect(TypedValue.safeParse("cfo").success).toBe(true);
    expect(TypedValue.safeParse("needs a new chief financial officer").success).toBe(false);
    expect(Belief.safeParse({ ...belief, values: { role: "a chief financial officer" } }).success).toBe(false);
  });

  it("disputed is a flag, not a status", () => {
    expect(Belief.safeParse({ ...belief, status: "disputed" }).success).toBe(false);
    expect(Belief.safeParse({ ...belief, disputed: true }).success).toBe(true);
  });
});

describe("outbox", () => {
  const twoItems = {
    ...claimMessage,
    keys: [
      { evidenceId: "ev-0", keyRef: "kr-0" },
      { evidenceId: "ev-1", keyRef: "kr-1" },
    ],
    readEvidenceIds: ["ev-1", "ev-0"],
    evidenceLabels: [signedLabel("ev-1"), signedLabel("ev-0")],
  };

  const { reason: _reason, ...notice } = deletionMessage;

  it("a routed message carries the body its kind names", () => {
    const routed = {
      kind: "claim",
      destination: "people",
      evidenceId: "ev-1",
      keys: claimMessage.keys,
      readEvidenceIds: ["ev-1"],
      evidenceLabels: [signedLabel("ev-1")],
      label,
      body: claim,
    };
    expect(Routed.safeParse(routed).success).toBe(true);
    expect(Routed.safeParse({ ...routed, kind: "interaction" }).success).toBe(false);
  });
});

describe("keys", () => {
  it("content keys are sorted by evidence id with no repeats", () => {
    const a = { evidenceId: "ev-0", keyRef: "kr-0" };
    const b = { evidenceId: "ev-1", keyRef: "kr-1" };
    expect(ContentKeys.safeParse([a, b]).success).toBe(true);
    expect(ContentKeys.safeParse([]).success).toBe(false);
    expect(ContentKeys.safeParse([a, a]).success).toBe(false);
    expect(ContentKeys.safeParse([b, a]).success).toBe(false);
  });

  it("a data key is 32 bytes and an envelope has no extra field", () => {
    expect(DataKey.safeParse(dataKey).success).toBe(true);
    expect(DataKey.safeParse("AAAA").success).toBe(false);
    expect(Envelope.safeParse(envelope).success).toBe(true);
    expect(Envelope.safeParse({ ...envelope, v: 2 }).success).toBe(false);
    expect(Envelope.safeParse({ ...envelope, key: dataKey }).success).toBe(false);
  });

  const write = { requestId: "req-1" };
  const item = { vault: "team", evidenceId: "ev-1", label };
  const requests = {
    create: { operation: "create", item, ...write },
    register: { operation: "register", ref: "kr-1", store: "people", ...write },
    register_card: {
      operation: "register_card",
      ref: "kr-1",
      store: "people",
      grant: "g-2",
      cardId: "card-1",
      ...write,
    },
    relabel: { operation: "relabel", ref: "kr-1", label, ...write },
    shred: { operation: "shred", ref: "kr-1", reason: "source_deleted", erasureId: 4, ...write },
    reencrypt: { operation: "reencrypt", old: "kr-1", next: item, ...write },
  };
});
