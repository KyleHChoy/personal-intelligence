import { describe, expect, it } from "vitest";
import {
  CardAction,
  CardLabelInput,
  CardSideKey,
  CardState,
  DraftView,
  PartyRole,
  PlaybookId,
  ProposedText,
  SilenceReason,
  ThreadEntryRole,
} from "./index.ts";
import { closedList, needsEvery, refusesOutside } from "./test-checks.ts";
import { toolItems } from "./test-samples.ts";

describe("the ledger's words", () => {
  it("the closed lists are the catalogue's", () => {
    closedList(PlaybookId, ["introduction", "gathering", "intro_paths", "project_next_step", "decision_tracking"]);
    closedList(PartyRole, ["need_side", "capability_side", "introducer", "invitee", "target", "owner"]);
    closedList(CardSideKey, ["a", "b"]);
    closedList(SilenceReason, [
      "vetoed",
      "grant_refused",
      "no_candidate",
      "below_bar",
      "waiting_is_better",
      "conflict",
      "kill_switch",
    ]);
    closedList(CardAction, ["approve", "edit", "hold", "reject"]);
    closedList(ThreadEntryRole, ["option", "proposal", "objection", "question", "decision", "reversal"]);
  });

  it("a card is created verified or held, and never proposed", () => {
    closedList(CardState, [
      "verified",
      "held",
      "broker_review",
      "release_requested",
      "refused",
      "released",
      "in_review",
      "deferred",
      "approved",
      "edited",
      "rejected",
    ]);
    expect(CardState.safeParse("proposed").success).toBe(false);
  });

  it("a proposed text is an introduction or an invitation to someone, never a consent ask", () => {
    const text = { kind: "invitation", recipients: ["party-1"], text: "An invitation, as the reasoner proposed it." };
    needsEvery(ProposedText, text);
    refusesOutside(ProposedText, text, "kind", "consent_ask");
    refusesOutside(ProposedText, text, "recipients", []);
    refusesOutside(ProposedText, text, "text", "");
  });
});

describe("a member's actions on a card", () => {
  it("a card is labelled with at least one of four answers", () => {
    for (const key of ["correct", "novel", "wouldAct", "acted"]) {
      expect(CardLabelInput.safeParse({ [key]: true }).success, key).toBe(true);
      expect(CardLabelInput.safeParse({ [key]: false }).success, key).toBe(true);
      expect(CardLabelInput.safeParse({ [key]: "yes" }).success, key).toBe(false);
    }
    expect(CardLabelInput.safeParse({ correct: true, novel: false, wouldAct: true, acted: false }).success).toBe(true);
    expect(CardLabelInput.safeParse({}).success).toBe(false);
    expect(CardLabelInput.safeParse({ correct: true, useful: true }).success).toBe(false);
    expect(CardLabelInput.safeParse({ correct: true, member: "m-ada" }).success).toBe(false);
  });
});

describe("drafts and the gate", () => {
  it("a draft view is the only draft that carries text", () => {
    needsEvery(DraftView, toolItems.list_drafts, ["decision.draftId"]);
    expect(Object.keys(DraftView.shape)).toContain("text");
    // No author and no label: the provider serves it under the result's own label.
    expect(Object.keys(DraftView.shape)).not.toContain("label");
    expect(Object.keys(DraftView.shape)).not.toContain("author");
  });
});
