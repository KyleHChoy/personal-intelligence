import { describe, expect, it } from "vitest";
import { OwnerCommitmentsArgs, OwnerGoalsArgs } from "./owner-reads.ts";
import { OwnerSearchArgs } from "./owner-reads-history.ts";
import { NetworkArgs } from "./owner-reads-network.ts";
import { OWNER_PAGE_MOST } from "./owner-reads-paging.ts";
import {
  DecideCardBody,
  ListCreateBody,
  NoteAddBody,
  OwnerTaskBody,
  PeoplePairBody,
  SetTierBody,
} from "./owner-words.ts";

// The dashboard's write bodies and read arguments.

const requestId = "req-0000001";
const card = "crd_01J9Z8Y7X6W5V4T3S2R1Q0P9N8";
const a = "ent_01J9Z8Y7X6W5V4T3S2R1Q0P9N8";
const b = "ent_01J9Z8Y7X6W5V4T3S2R1Q0P9N9";

describe("the owner's write bodies", () => {
  it("answers one card a request", () => {
    expect(DecideCardBody.safeParse({ card, answer: "go", requestId }).success).toBe(true);
    expect(DecideCardBody.safeParse({ cards: [card], answer: "go", requestId }).success).toBe(false);
    expect(DecideCardBody.safeParse({ card, answer: "no_go", reason: "wrong_timing", requestId }).success).toBe(true);
    expect(DecideCardBody.safeParse({ card, answer: "go", reason: "wrong_timing", requestId }).success).toBe(false);
    // A finding's dismiss takes a reason and a note, in the body.
    expect(
      DecideCardBody.safeParse({ card, answer: "dismiss", reason: "not_worth_it", note: "seen it already", requestId })
        .success,
    ).toBe(true);
    expect(DecideCardBody.safeParse({ card, answer: "acknowledge", reason: "not_worth_it", requestId }).success).toBe(
      false,
    );
  });

  it("never drops a person on one-way", () => {
    expect(SetTierBody.safeParse({ person: a, tier: "close", requestId }).success).toBe(true);
    expect(SetTierBody.safeParse({ person: a, tier: "one-way", requestId }).success).toBe(false);
  });

  it("rules on two different people", () => {
    expect(PeoplePairBody.safeParse({ a, b, requestId }).success).toBe(true);
    expect(PeoplePairBody.safeParse({ a, b: a, requestId }).success).toBe(false);
  });

  it("takes the owner's words as text: not empty, no control character, a list name on one line", () => {
    expect(NoteAddBody.safeParse({ person: a, role: "bio", text: "Two lines\nof a bio", requestId }).success).toBe(
      true,
    );
    expect(NoteAddBody.safeParse({ person: a, role: "note", text: "  ", requestId }).success).toBe(false);
    expect(NoteAddBody.safeParse({ person: a, role: "note", text: "bell\u0007", requestId }).success).toBe(false);
    expect(ListCreateBody.safeParse({ name: "Friends", requestId }).success).toBe(true);
    expect(ListCreateBody.safeParse({ name: "Two\nlines", requestId }).success).toBe(false);
  });

  it("opens a task of a read-only kind only", () => {
    const task = { role: "researcher", about: [{ kind: "entity", id: a }], note: "Who is this?", requestId };
    expect(OwnerTaskBody.safeParse({ ...task, kind: "research" }).success).toBe(true);
    expect(OwnerTaskBody.safeParse({ ...task, kind: "follow_up" }).success).toBe(false);
  });
});

describe("the owner's read arguments", () => {
  it("pages at most 200 rows", () => {
    expect(OwnerCommitmentsArgs.safeParse({ limit: OWNER_PAGE_MOST, state: "open" }).success).toBe(true);
    expect(OwnerCommitmentsArgs.safeParse({ limit: OWNER_PAGE_MOST + 1 }).success).toBe(false);
  });

  it("parses each argument from the text of a query string", () => {
    expect(OwnerCommitmentsArgs.parse({ limit: "50" }).limit).toBe(50);
    expect(OwnerCommitmentsArgs.safeParse({ limit: "fifty" }).success).toBe(false);
    expect(OwnerGoalsArgs.parse({ stale: "false" }).stale).toBe(false);
    expect(OwnerGoalsArgs.safeParse({ stale: "yes" }).success).toBe(false);
    expect(NetworkArgs.parse({ tiers: "inner,close" }).tiers).toEqual(["inner", "close"]);
    expect(NetworkArgs.safeParse({ tiers: "inner,best" }).success).toBe(false);
  });

  it("bounds a search term", () => {
    expect(OwnerSearchArgs.safeParse({ term: "ada" }).success).toBe(true);
    expect(OwnerSearchArgs.safeParse({ term: "" }).success).toBe(false);
  });
});
