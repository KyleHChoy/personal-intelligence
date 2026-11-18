import { describe, expect, it } from "vitest";
import { ExtractionCommit } from "./extraction-commit.ts";
import { MentionBindingId, MentionId } from "./ids.ts";
import { FiledMention, MENTION_FIELD, MentionCandidate } from "./mentions.ts";
import { OwnerDecisionKind } from "./owner.ts";

// Mentions.

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;

describe("mentions", () => {
  it("a filed mention and a binding have ids of their own prefixes", () => {
    expect(accepts(MentionId, `umn_${ULID}`)).toBe(true);
    expect(accepts(MentionId, `mbd_${ULID}`)).toBe(false);
    expect(accepts(MentionBindingId, `mbd_${ULID}`)).toBe(true);
    expect(accepts(MentionBindingId, `umn_${ULID}`)).toBe(false);
  });

  it("OwnerDecisionKind holds mention_bind and mention_unbind", () => {
    expect(OwnerDecisionKind.parse("mention_bind")).toBe("mention_bind");
    expect(OwnerDecisionKind.parse("mention_unbind")).toBe("mention_unbind");
  });

  it("a filed mention is a name, a fact type and the field it stood in, and nothing else", () => {
    const filed = { name: "Bryn Calder", type: "role", field: "subject" };
    expect(accepts(FiledMention, filed)).toBe(true);
    expect(accepts(FiledMention, { ...filed, field: "counterparty" })).toBe(true);
    expect(accepts(FiledMention, { ...filed, name: "" })).toBe(false);
    expect(accepts(FiledMention, { ...filed, name: "x".repeat(201) })).toBe(false);
    expect(accepts(FiledMention, { ...filed, type: "not_a_type" })).toBe(false);
    expect(accepts(FiledMention, { ...filed, field: "Subject; drop" })).toBe(false);
    expect(accepts(FiledMention, { ...filed, entity: `ent_${ULID}` })).toBe(false);
    expect(MENTION_FIELD).toBe("subject");
  });

  it("a commit may carry the item's filed mentions, and one with none still parses", () => {
    const commit = {
      evidenceId: "a".repeat(64),
      generation: 2,
      lane: "correspondence",
      status: "done",
      claims: [],
      unmapped: [],
      unresolved: 1,
    };
    expect(accepts(ExtractionCommit, commit)).toBe(true);
    expect(
      accepts(ExtractionCommit, { ...commit, mentions: [{ name: "Bryn Calder", type: "role", field: "subject" }] }),
    ).toBe(true);
    expect(accepts(ExtractionCommit, { ...commit, mentions: [{ name: "Bryn Calder" }] })).toBe(false);
  });

  it("a candidate is ids, a count and code words, its name wrapped", () => {
    const candidate = {
      mention: `umn_${ULID}`,
      count: 2,
      entity: `ent_${ULID}`,
      established: true,
      type: "role",
      field: "subject",
      name: { untrusted: "Bryn Calder" },
    };
    expect(accepts(MentionCandidate, candidate)).toBe(true);
    expect(accepts(MentionCandidate, { ...candidate, count: 0 })).toBe(false);
    expect(accepts(MentionCandidate, { ...candidate, name: "Bryn Calder" })).toBe(false);
    expect(accepts(MentionCandidate, { ...candidate, address: "bryn@example.com" })).toBe(false);
  });
});
