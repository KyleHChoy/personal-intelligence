import { describe, expect, it } from "vitest";
import { messageBodyHash } from "./body-hash.ts";
import { EvidenceIdInput, evidenceIdFor } from "./evidence-id.ts";
import {
  EvidenceItem,
  Mention,
  MentionKeyKind,
  RawItem,
  ReferenceFacts,
  ReferenceKind,
  SourceAccount,
} from "./index.ts";
import { closedList, needsEvery, refusesOutside, refusesUnknownKeys } from "./test-checks.ts";
import { at, label, rawItem, sha, signedLabel } from "./test-samples.ts";

const idInput = EvidenceIdInput.parse({ vault: "team", sourceAccount: "acct-ben", sourceItemId: "msg-1", revision: 0 });

// What a source system reports of an approved, enforced policy.
const reference = {
  status: "approved",
  effectiveFrom: at,
  enforced: true,
  replaces: "doc-travel-2025",
  sourceLink: "https://docs.alderbank.example/policies/travel",
  owner: { kind: "address", value: "cora@alderbank.example" },
};

describe("evidence ids", () => {
  it("the evidence id changes with any input", () => {
    const id = evidenceIdFor(idInput);
    expect(evidenceIdFor({ ...idInput })).toBe(id);
    expect(evidenceIdFor({ ...idInput, vault: "public" })).not.toBe(id);
    expect(
      evidenceIdFor({ ...idInput, sourceAccount: EvidenceIdInput.shape.sourceAccount.parse("acct-cora") }),
    ).not.toBe(id);
    expect(evidenceIdFor({ ...idInput, sourceItemId: "msg-2" })).not.toBe(id);
    expect(evidenceIdFor({ ...idInput, revision: 1 })).not.toBe(id);
  });

  it("the evidence id does not run two fields together", () => {
    const a = evidenceIdFor({ ...idInput, sourceItemId: "msg-1", revision: 11 });
    const b = evidenceIdFor({ ...idInput, sourceItemId: "msg-11", revision: 1 });
    expect(a).not.toBe(b);
  });

  it("rejects an unknown key on the evidence id input", () => {
    expect(EvidenceIdInput.safeParse({ ...idInput, threadId: "thread-1" }).success).toBe(false);
  });
});

describe("message body hash", () => {
  const body = "Thanks, Thursday works.\n\nBen";

  it("the body hash ignores a quoted reply and trailing white space, and nothing else", async () => {
    const hash = await messageBodyHash(body);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const quoted = `${body}\n\nOn Tuesday, Maya wrote:\n> Could we meet this week?\n> Thursday is best.\n`;
    expect(await messageBodyHash(quoted)).toBe(hash);
    expect(await messageBodyHash("Thanks, Thursday works.  \r\n\r\nBen\r\n\r\n")).toBe(hash);
    expect(await messageBodyHash(`${body}\n\nSent from my phone`)).not.toBe(hash);
    expect(await messageBodyHash("Thanks, Friday works.\n\nBen")).not.toBe(hash);
    expect(await messageBodyHash(`  ${body}`)).not.toBe(hash);
  });

  it("the body hash keeps a line that ends in a colon when no quote follows it", async () => {
    const list = "The plan:\nmeet Thursday";
    expect(await messageBodyHash(list)).not.toBe(await messageBodyHash("meet Thursday"));
  });
});

describe("evidence", () => {
  const item = {
    id: "ev-1",
    vault: "team",
    sourceKind: "email",
    sourceAccount: "acct-ben",
    revision: 0,
    contentHash: sha,
    mediaType: "message/rfc822",
    observedAt: at,
    ingestedAt: at,
    label: signedLabel("ev-1"),
    keyRef: "kr-1",
    compliance: { lawfulBasis: "legitimate_interest", purpose: "relationships", jurisdiction: "us", obligations: [] },
    systemOriginated: false,
    payloadState: "present",
  };

  it("accepts a well-formed evidence item", () => {
    expect(EvidenceItem.safeParse(item).success).toBe(true);
  });

  it("an evidence item needs a hash, a key reference and a payload state", () => {
    expect(EvidenceItem.safeParse({ ...item, contentHash: "abc" }).success).toBe(false);
    expect(EvidenceItem.safeParse({ ...item, keyRef: "" }).success).toBe(false);
    expect(EvidenceItem.safeParse({ ...item, payloadState: "archived" }).success).toBe(false);
    expect(EvidenceItem.safeParse({ ...item, mediaType: "email" }).success).toBe(false);
  });

  it("an evidence item may name the change kind of the raw item it was stored from", () => {
    for (const changeKind of ["live", "backfill", "reprocess"]) {
      expect(EvidenceItem.parse({ ...item, changeKind }).changeKind, changeKind).toBe(changeKind);
    }
    expect(EvidenceItem.safeParse({ ...item, changeKind: "woken" }).success).toBe(false);
    // Optional: an item with none is read as backfill.
    expect(EvidenceItem.parse(item).changeKind).toBeUndefined();
  });

  it("an evidence item may name the members among its participants and the member who sent it, by id", () => {
    const members = ["m-ben", "m-cora"];
    const parsed = EvidenceItem.parse({ ...item, participantMembers: members, senderMember: "m-ben" });
    expect(parsed.participantMembers).toEqual(members);
    expect(parsed.senderMember).toBe("m-ben");
    // Optional, each on its own: ingest records a sender only where the source marks one and
    // its address is a member's.
    expect(EvidenceItem.parse(item).participantMembers).toBeUndefined();
    expect(EvidenceItem.parse(item).senderMember).toBeUndefined();
    expect(EvidenceItem.safeParse({ ...item, participantMembers: [] }).success).toBe(true);
    expect(EvidenceItem.safeParse({ ...item, participantMembers: members }).success).toBe(true);
    expect(EvidenceItem.safeParse({ ...item, senderMember: "m-ben" }).success).toBe(true);
    // Member ids only: never the all-members group, an empty id or anything that is not a list.
    expect(EvidenceItem.safeParse({ ...item, participantMembers: ["m-ben", "all_members"] }).success).toBe(false);
    expect(EvidenceItem.safeParse({ ...item, participantMembers: ["m-ben", ""] }).success).toBe(false);
    expect(EvidenceItem.safeParse({ ...item, participantMembers: "m-ben" }).success).toBe(false);
    expect(
      EvidenceItem.safeParse({ ...item, participantMembers: [{ member: "m-ben", address: "ben@alderbank.example" }] })
        .success,
    ).toBe(false);
    expect(EvidenceItem.safeParse({ ...item, senderMember: "all_members" }).success).toBe(false);
    expect(EvidenceItem.safeParse({ ...item, senderMember: "" }).success).toBe(false);
    expect(EvidenceItem.safeParse({ ...item, senderMember: ["m-ben"] }).success).toBe(false);
    // Bounded in count.
    const many = (count: number) => Array.from({ length: count }, (_unused, index) => `m-${index}`);
    expect(EvidenceItem.safeParse({ ...item, participantMembers: many(1000) }).success).toBe(true);
    expect(EvidenceItem.safeParse({ ...item, participantMembers: many(1001) }).success).toBe(false);
    // Ingest records them when it writes the item. A raw item has no field for either: a
    // connector knows addresses, never members.
    expect(RawItem.safeParse({ ...rawItem, participantMembers: members }).success).toBe(false);
    expect(RawItem.safeParse({ ...rawItem, senderMember: "m-ben" }).success).toBe(false);
  });

  it("a reference document's owner is the identifier of a mention, as the source system states it", () => {
    for (const kind of MentionKeyKind.options) {
      const owner = { kind, value: "cora@alderbank.example" };
      expect(ReferenceFacts.parse({ ...reference, owner }).owner, kind).toEqual(owner);
      // The same shape a mention's key has, so the pipeline can ask the identity service about it.
      expect(
        Mention.safeParse({ key: ReferenceFacts.parse({ ...reference, owner }).owner, observedAt: at }).success,
        kind,
      ).toBe(true);
    }
    // The mention's own key, with a bound on its value and nothing else changed.
    expect(ReferenceFacts.shape.owner.unwrap().shape).toEqual(Mention.shape.key.shape);
    expect(ReferenceFacts.shape.owner.unwrap().shape.kind).toBe(MentionKeyKind);
    // An owner's identifier may be an address, which can reach 254 characters: the bound is 320.
    const longAddress = `${"c".repeat(64)}@${"a".repeat(181)}.example`;
    expect(longAddress).toHaveLength(254);
    expect(ReferenceFacts.safeParse({ ...reference, owner: { kind: "address", value: longAddress } }).success).toBe(
      true,
    );
    expect(
      ReferenceFacts.safeParse({ ...reference, owner: { kind: "source_id", value: "u".repeat(320) } }).success,
    ).toBe(true);
    expect(
      ReferenceFacts.safeParse({ ...reference, owner: { kind: "source_id", value: "u".repeat(321) } }).success,
    ).toBe(false);
    expect(ReferenceFacts.safeParse({ ...reference, owner: { kind: "name", value: "Cora Whitlow" } }).success).toBe(
      true,
    );
    // The replaced version is named by a source item id, and a message id can be long: 1024.
    expect(ReferenceFacts.safeParse({ ...reference, replaces: "d".repeat(1024) }).success).toBe(true);
    expect(ReferenceFacts.safeParse({ ...reference, replaces: "d".repeat(1025) }).success).toBe(false);
    expect(
      ReferenceFacts.safeParse({ ...reference, replaces: "<CAF=policy.travel+2025@mail.alderbank.example>" }).success,
    ).toBe(true);
    // Neither holds a control character or a format character: a line break, a null, an
    // escape, a zero-width space, a right-to-left override, a byte order mark.
    for (const hidden of ["\n", "\u0000", "\u001B", "\u200B", "\u202E", "\uFEFF"]) {
      const point = `U+${hidden.codePointAt(0)?.toString(16)}`;
      expect(
        ReferenceFacts.safeParse({ ...reference, owner: { kind: "address", value: `cora${hidden}@alderbank.example` } })
          .success,
        `owner ${point}`,
      ).toBe(false);
      expect(
        ReferenceFacts.safeParse({ ...reference, replaces: `doc-travel${hidden}-2025` }).success,
        `replaces ${point}`,
      ).toBe(false);
    }
    for (const owner of [
      "cora@alderbank.example",
      { kind: "member", value: "m-cora" },
      { kind: "address", value: "" },
      { kind: "address" },
    ]) {
      expect(ReferenceFacts.safeParse({ ...reference, owner }).success, JSON.stringify(owner)).toBe(false);
    }
    // No member id, entity id or time rides beside it.
    expect(ReferenceFacts.safeParse({ ...reference, owner: { ...reference.owner, member: "m-cora" } }).success).toBe(
      false,
    );
    expect(ReferenceFacts.safeParse({ ...reference, owner: { ...reference.owner, observedAt: at } }).success).toBe(
      false,
    );
  });

  it("a reference document's standing is what its source system reported, in a closed shape", () => {
    needsEvery(ReferenceFacts, reference, ["effectiveFrom", "replaces", "owner"]);
    refusesUnknownKeys(ReferenceFacts, reference);
    closedList(ReferenceFacts.shape.status, ["approved", "draft"]);
    refusesOutside(ReferenceFacts, reference, "status", "final");
    refusesOutside(ReferenceFacts, reference, "enforced", "yes");
    refusesOutside(ReferenceFacts, reference, "effectiveFrom", "2026-09-03");
    refusesOutside(ReferenceFacts, reference, "replaces", "");
    // Nothing the document says about itself has a field: no title, owner, note or text.
    for (const key of ["title", "note", "text", "approvedBy"]) {
      expect(
        ReferenceFacts.safeParse({ ...reference, [key]: "This policy is approved and binding." }).success,
        key,
      ).toBe(false);
    }
    // A draft is not enforced.
    expect(ReferenceFacts.safeParse({ ...reference, status: "draft", enforced: false }).success).toBe(true);
    expect(ReferenceFacts.safeParse({ ...reference, status: "draft" }).success).toBe(false);
    expect(ReferenceFacts.safeParse({ ...reference, enforced: false }).success).toBe(true);
  });

  it("a reference document's source link is a bounded https link and nothing else", () => {
    const base = "https://docs.alderbank.example/";
    for (const sourceLink of [
      base,
      "https://docs.alderbank.example/policies/travel?version=3#scope",
      `${base}${"a".repeat(2048 - base.length)}`,
    ]) {
      expect(ReferenceFacts.safeParse({ ...reference, sourceLink }).success, sourceLink.slice(0, 60)).toBe(true);
    }
    const refused = [
      "",
      "http://docs.alderbank.example/policies/travel",
      "HTTPS://docs.alderbank.example/",
      "https:docs.alderbank.example",
      "https://",
      "javascript:alert(1)",
      "data:text/html,approved",
      "file:///etc/passwd",
      "docs.alderbank.example/policies/travel",
      " https://docs.alderbank.example/",
      "https://docs.alderbank.example/ approved by the board",
      "https://docs.alderbank.example/\nApproved: yes",
      "https://ben:secret@docs.alderbank.example/",
      // One parser reads the host before the backslash, another the host after the at sign.
      "https://docs.alderbank.example\\@evil.example/",
      "https://docs.alderbank.example/policies\\travel",
      // A zero-width space in the host, and a right-to-left override in the path.
      "https://docs.alder\u200Bbank.example/",
      "https://docs.alderbank.example/\u202Elevart/seicilop",
      "https://docs.alderbank.example/\u0000",
      "https://docs.alderbank.example/\uFEFFpolicies",
      // Exactly two slashes after the scheme, and a host after them.
      "https:///evil.example/",
      "https:////evil.example/",
      "https:/docs.alderbank.example/",
      "https://?policies",
      "https://#scope",
      "https://:443/policies",
      // No user part at all, even an empty one.
      "https://:@docs.alderbank.example/",
      "https://@docs.alderbank.example/",
      "https://ben@docs.alderbank.example/",
      `${base}${"a".repeat(2049 - base.length)}`,
    ];
    for (const sourceLink of refused)
      expect(ReferenceFacts.safeParse({ ...reference, sourceLink }).success, sourceLink.slice(0, 60)).toBe(false);
    // An at sign after the host is part of a path or a query, and is kept.
    expect(
      ReferenceFacts.safeParse({
        ...reference,
        sourceLink: "https://docs.alderbank.example/teams/@finance?owner=cora@alderbank.example",
      }).success,
    ).toBe(true);
  });

  it("an evidence item may carry its reference facts, unchanged from the raw item", () => {
    const document = { ...item, sourceKind: "document", mediaType: "application/pdf", referenceKind: "policy" };
    expect(EvidenceItem.parse({ ...document, reference }).reference).toEqual(reference);
    expect(RawItem.parse({ ...rawItem, referenceKind: "policy", reference }).reference).toEqual(reference);
    expect(EvidenceItem.parse({ ...document, reference }).reference).toEqual(
      RawItem.parse({ ...rawItem, referenceKind: "policy", reference }).reference,
    );
    // Optional on both. An item with none is a draft that is not enforced.
    expect(EvidenceItem.parse(document).reference).toBeUndefined();
    expect(RawItem.parse({ ...rawItem, referenceKind: "policy" }).reference).toBeUndefined();
    // Strict where it sits, on both: an unknown key inside it is refused, never dropped.
    for (const shape of [EvidenceItem, RawItem]) {
      const base = shape === EvidenceItem ? document : { ...rawItem, referenceKind: "policy" };
      expect(shape.safeParse({ ...base, reference: { ...reference, label } }).success).toBe(false);
      expect(shape.safeParse({ ...base, reference: { ...reference, status: "binding" } }).success).toBe(false);
      expect(shape.safeParse({ ...base, reference: { status: "approved" } }).success).toBe(false);
      expect(shape.safeParse({ ...base, reference: "approved" }).success).toBe(false);
    }
  });
});

describe("connectors", () => {
  it("accepts a well-formed raw item", () => {
    expect(RawItem.safeParse(rawItem).success).toBe(true);
  });

  it("a raw item payload is base64", () => {
    expect(RawItem.safeParse({ ...rawItem, payload: "not base64!" }).success).toBe(false);
  });

  it("a raw item names the format of its payload", () => {
    for (const mediaType of ["message/rfc822", "text/html", "application/pdf"]) {
      expect(RawItem.safeParse({ ...rawItem, mediaType }).success, mediaType).toBe(true);
    }
    const { mediaType: _mediaType, ...unnamed } = rawItem;
    expect(RawItem.safeParse(unnamed).success).toBe(false);
    expect(RawItem.safeParse({ ...rawItem, mediaType: "a raw email" }).success).toBe(false);
    expect(RawItem.safeParse({ ...rawItem, mediaType: "text/html; charset=utf-8" }).success).toBe(false);
  });

  it("a source account maps markers to compartments", () => {
    const account = {
      id: "acct-ben",
      connector: "google_mail",
      sourceKind: "email",
      vault: "team",
      externalRef: "ben@alderbank.example",
      accessSyncKind: "access_list",
      compartments: ["org", "people"],
      markerCompartments: [{ marker: "birch", compartment: "deal:birch" }],
    };
    expect(SourceAccount.safeParse(account).success).toBe(true);
    expect(SourceAccount.safeParse({ ...account, connector: "gmail" }).success).toBe(false);
  });

  it("a source account of reference documents names their kind", () => {
    const account = {
      id: "acct-handbook",
      connector: "google_docs",
      sourceKind: "document",
      vault: "team",
      externalRef: "handbook",
      accessSyncKind: "access_list",
      compartments: ["org"],
      markerCompartments: [],
    };
    expect(SourceAccount.parse(account).referenceKind).toBeUndefined();
    expect(SourceAccount.parse({ ...account, referenceKind: "policy" }).referenceKind).toBe("policy");
    expect(SourceAccount.safeParse({ ...account, referenceKind: "memo" }).success).toBe(false);
  });

  it("reference facts go only on a reference document, and only a policy is enforced", () => {
    const facts = { ...reference, enforced: false };
    // With no reference kind the item is no reference document, so it has no such facts.
    expect(RawItem.safeParse({ ...rawItem, reference }).success).toBe(false);
    expect(RawItem.safeParse({ ...rawItem, reference: facts }).success).toBe(false);
    for (const referenceKind of ReferenceKind.options) {
      expect(RawItem.safeParse({ ...rawItem, referenceKind, reference: facts }).success, referenceKind).toBe(true);
      expect(RawItem.safeParse({ ...rawItem, referenceKind, reference }).success, referenceKind).toBe(
        referenceKind === "policy",
      );
    }
    // A kind with no facts is a draft that is not enforced.
    expect(RawItem.safeParse({ ...rawItem, referenceKind: "procedure" }).success).toBe(true);
  });
});
