import type { Who } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { composeOpenItems, type PlanInput } from "./open-items.ts";

// What a recall audit reads: each dated line a closed filter kept from being an item, under the filter
// that kept it, and nothing else. Every line here is invented.
const NOW = new Date("2026-11-03T18:00:00.000Z");
const owner = { id: `ent_${"0".repeat(26)}`, kind: "owner", name: null, address: null } as unknown as Who;
const plan = (n: number, what: string, over: Partial<PlanInput> = {}): PlanInput => ({
  key: `key-${n}`,
  match: `match-${n}`,
  what,
  when: "2026-11-08",
  at: n,
  ownMail: false,
  bulk: true,
  sender: "fingerprint-of-a-sender",
  authed: true,
  refs: {},
  ...over,
});
const compose = (plans: PlanInput[]) =>
  composeOpenItems({ owner, commitments: [], nextSteps: [], plans, events: [], closes: [] }, NOW, "UTC");

describe("a line a closed filter dropped", () => {
  it("is named with its filter, and a deadline worded outside the list is among them", () => {
    const { items, dropped } = compose([
      plan(1, "Your tuition balance must be settled before Friday"),
      plan(2, "Your rent has been received."),
      plan(3, "Apply by Friday"),
      plan(4, "Lab report is due", { bulk: false }),
      plan(5, "If requested, send the transcript"),
      plan(6, "Tuition payment is due"),
    ]);
    expect(dropped).toEqual([
      { key: "key-1", filter: "mail_no_deadline_word" },
      { key: "key-2", filter: "mail_says_done" },
      { key: "key-3", filter: "mail_advertises" },
      { key: "key-5", filter: "mail_no_deadline_word" },
    ]);
    expect(items.map((one) => one.source.id).sort()).toEqual(["key-4", "key-6"]);
  });

  it("from a person's mail is dropped by the conditional rule alone", () => {
    const { dropped } = compose([plan(1, "If requested, send the transcript", { bulk: false })]);
    expect(dropped).toEqual([{ key: "key-1", filter: "says_conditional" }]);
  });

  it("with no date is no item, and no filter is named for it", () => {
    expect(compose([plan(1, "Tuition balance settled", { when: null })]).dropped).toEqual([]);
  });

  it("said again and more fully by its sender is dropped as restated", () => {
    const { dropped, items } = compose([
      plan(2, "Your transcript and form are due"),
      plan(1, "Your transcript is due"),
    ]);
    expect(dropped).toEqual([{ key: "key-1", filter: "mail_restated" }]);
    expect(items.map((one) => one.source.id)).toEqual(["key-2"]);
  });
});
