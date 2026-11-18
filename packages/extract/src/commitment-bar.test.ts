import { describe, expect, it } from "vitest";
import { commitmentRefusal } from "./commitment-bar.ts";

const SPEAKER = "ent_speaker";
const OTHER = "ent_other";
const spoken = (what: string, subject = SPEAKER, counterparty = OTHER) =>
  commitmentRefusal({ what, subject, counterparty, speaker: SPEAKER });

describe("the substance bar", () => {
  it("keeps an action with its own object", () => {
    for (const what of [
      "I'll send you the signed lease by May 8",
      "I will send you the deck",
      "send Rhea the budget",
      "pay the deposit",
      "call Rhea back",
      "get you the deck",
      "I'll pick you up at the airport",
      "look into the invoice",
      "write a thank you note",
      "let you know what the board decides",
      "Ich schicke dir den Vertrag",
      "我明天把签好的合同发给你",
      "Thanks, I'll send the signed lease Friday",
      "Sorry, I'll wire the deposit tomorrow",
      "Please note I'll send the signed lease Friday",
      "I'd love to send you the deck",
      "I'll pay 500",
    ])
      expect(spoken(what), what).toBeNull();
  });

  it("refuses a remark with no object of its own", () => {
    for (const what of [
      "I'll be there",
      "be there at 5",
      "see you Friday",
      "calling back in a second",
      "I'll call you back",
      "I'll get back to you",
      "will do",
      "I'll let you know",
      "I'll cover the rest",
      "on my way",
      "soon",
    ])
      expect(spoken(what), what).toEqual({ reason: "not_a_promise", issue: "no_object" });
  });

  it("refuses a promise its own words hedge, and keeps one that only hedges the date", () => {
    for (const what of [
      "I will prob get the invoice tmrw",
      "I can probably do the budget and the schedule, but I doubt the rest",
      "I'll maybe send the deck",
      "will probably wire the deposit",
    ])
      expect(spoken(what), what).toEqual({ reason: "not_a_promise", issue: "hedged" });
    for (const what of [
      "I'll send the deck, probably Friday",
      "I will send the deck, maybe with the budget",
      "Probably overdue, but I'll send the deck",
      "I'll definitely send the deck",
      "I'll pay maybe 200 on Friday",
    ])
      expect(spoken(what), what).toBeNull();
  });

  it("refuses a standby that waits on a need, and keeps a promise with a real condition", () => {
    for (const what of [
      "we'll write to you if changes are necessary",
      "I'll call Rhea if needed",
      "If required, I'll send a new copy",
    ])
      expect(spoken(what), what).toEqual({ reason: "not_a_promise", issue: "conditional" });
    for (const what of [
      "I'll send the deck if the board approves",
      "I'll pay the deposit once the lease is signed",
      "I'll send what is needed if you share the file",
      "I'll send everything the bank required",
      "I'll send the deck Friday, let me know if anything else is needed",
      "I'll send the signed lease by Friday and tell you if a notary is required",
    ])
      expect(spoken(what), what).toBeNull();
  });

  it("judges a promise by its own clause: the talk after it, or its reason, is no object", () => {
    for (const what of [
      "I'll do that. Fair enough",
      "Ok I should check that again\nI'll do that. Good call",
      "I'll take a look when I'm back",
      "I'm at the gym right now. I'll take a look when I get back",
      "Sure I'll go take a look\nSend me the link you meant",
      "I'll have a look",
      "We'll see what we can get done by then",
      "I'll see what I can do",
    ])
      expect(spoken(what), what).toEqual({ reason: "not_a_promise", issue: "no_object" });
    for (const what of [
      "I'll take a look at the contract",
      "I'll have a look at the invoice when I get home",
      "I'll do it. The deck is due",
      "I'll do that today. Good point",
      "I'll send the form when I'm back",
      "I'll send it. Friday works",
      "I'll make the edits\nAre you free to go over them?",
      "I'll see what I can do about the invoice",
      "I'll see if I can get you the deck",
      "I'll call you. Re the lease",
      "Will do. I'll send the deck Friday",
      "Yes I can. I'll send the lease tomorrow",
      "I'll do it once the contract is signed",
      "I'll do that when the invoice arrives",
      "I'll look after the kids Friday",
      "I'll take a look at it tomorrow",
      "I'll have a look at them Friday",
      "Yes! We're drafting the plan and will get back to you when the vendors are chosen",
    ])
      expect(spoken(what), what).toBeNull();
  });

  it("a look at it stands on a date or on the thing named just before", () => {
    const with_before = (what: string, before: string) =>
      commitmentRefusal({ what, subject: SPEAKER, counterparty: OTHER, speaker: SPEAKER, before });
    expect(with_before("I'll look at it tonight", "The signed lease is attached.")).toBeNull();
    expect(with_before("I'll take a look at it", "Please review the signed lease.")).toBeNull();
    expect(with_before("I'll take a look at it", "Hi Rhea.")).toEqual({ reason: "not_a_promise", issue: "no_object" });
  });

  it("refuses thanks, apologies and regards, carried or not", () => {
    for (const what of ["Tell her I apologize", "apologize to Rhea for the delay", "say thanks", "tell Rhea thanks"])
      expect(spoken(what), what).toEqual({ reason: "not_a_promise", issue: "remark" });
  });

  it("refuses an ask, whoever the model named: an ask is no promise", () => {
    for (const what of ["Can you send me the form?", "could you review the budget", "please sign the lease"]) {
      expect(spoken(what), what).toEqual({ reason: "not_a_promise", issue: "ask" });
      expect(spoken(what, OTHER, SPEAKER), what).toEqual({ reason: "not_a_promise", issue: "ask" });
    }
  });
});

describe("the direction check", () => {
  it("I'll said by the speaker is the speaker's, however it opens", () => {
    expect(spoken("I'll send you the deck")).toBeNull();
    expect(spoken("Sure, I'll send you the deck")).toBeNull();
    expect(spoken("I’ll send you the deck", OTHER, SPEAKER)).toEqual({
      reason: "wrong_direction",
      issue: "speaker_says_i",
    });
    expect(spoken("let me send you the deck", OTHER, SPEAKER)).toEqual({
      reason: "wrong_direction",
      issue: "speaker_says_i",
    });
  });

  it("you will said by the speaker is not the speaker's", () => {
    expect(spoken("you will send me the deck", OTHER, SPEAKER)).toBeNull();
    expect(spoken("you'll send me the deck")).toEqual({ reason: "wrong_direction", issue: "speaker_says_you" });
  });

  it("no one promises themselves", () => {
    expect(spoken("send the deck", SPEAKER, SPEAKER)).toEqual({ reason: "wrong_direction", issue: "own_counterparty" });
  });

  it("with no words of person, or no speaker known, says nothing of direction", () => {
    expect(spoken("send Rhea the deck", OTHER, SPEAKER)).toBeNull();
    expect(
      commitmentRefusal({ what: "I'll send you the deck", subject: OTHER, counterparty: SPEAKER, speaker: undefined }),
    ).toBeNull();
  });
});

// The near misses, so the line is read where it falls. A pronoun is an object when the promise says
// when, says to whom, or follows words that name the thing; anything else stays a remark.
const CHICAGO = "America/Chicago";
const PARIS = "Europe/Paris";

describe("a promise whose object is a pronoun", () => {
  const judged = (what: string, more: { due?: string; before?: string; said?: string; zone?: string } = {}) =>
    commitmentRefusal({ what, subject: SPEAKER, counterparty: OTHER, speaker: SPEAKER, ...more })?.issue ?? "kept";

  const NEAR_MISSES: [string, { due?: string; before?: string; said?: string; zone?: string }, string][] = [
    // A stated date.
    ["I'll send it", { due: "2026-05-08" }, "kept"],
    ["I'll send it Friday", {}, "kept"],
    ["I'll send it tomorrow", {}, "kept"],
    ["I'll do it by Monday", {}, "kept"],
    ["I'll take care of it", { due: "2026-05-08" }, "kept"],
    // The counterparty named in the claim.
    ["I'll send it to Rhea", {}, "kept"],
    ["I'll get that to Rhea", {}, "kept"],
    // The object named just before it.
    ["I'll send it", { before: "The signed lease is ready." }, "kept"],
    ["I'll review them", { before: "Rhea asked about the budget drafts." }, "kept"],
    // None of those: a pronoun with nothing to stand for.
    ["I'll send it", {}, "no_object"],
    ["I'll send it", { before: "Thanks!" }, "no_object"],
    ["I'll send it", { before: "Sounds good, thanks." }, "no_object"],
    ["I'll send it", { before: "Hi Rhea," }, "no_object"],
    ["I'll send it to you", {}, "no_object"],
    ["I'll handle that", {}, "no_object"],
    ["I'll take care of it", {}, "no_object"],
    ["I'll send it soon", {}, "no_object"],
    // A person for an object, with a date.
    ["I'll pay you back", { due: "2026-05-08" }, "kept"],
    ["I'll call you tomorrow", {}, "kept"],
    ["I'll pay him Friday", {}, "kept"],
    ["I'll pay you back", {}, "no_object"],
    // A person stands on a date after the line's own day, never the day it was said.
    ["I'll call you in a sec", { due: "2026-05-08", said: "2026-05-08T15:04:00.000Z" }, "no_object"],
    ["I'll get back to you", { due: "2026-05-08", said: "2026-05-08T09:00:00.000Z" }, "no_object"],
    ["I'll call you in a sec", { due: "2026-05-07", said: "2026-05-08T00:30:00.000Z" }, "no_object"],
    ["I'll pay you back", { due: "2026-05-09", said: "2026-05-08T15:04:00.000Z" }, "kept"],
    ["I'll get back to you", { due: "2026-05-11", said: "2026-05-08T09:00:00.000Z" }, "kept"],
    // 8pm in Chicago (02:00 UTC the next day): "in a sec" dated the owner's day is refused, and
    // "tomorrow" dated the owner's next day, which is the UTC day, is kept; with no zone set, the
    // UTC day reads that "tomorrow" as the same day.
    ["I'll call you in a sec", { due: "2026-05-08", said: "2026-05-09T02:00:00.000Z", zone: CHICAGO }, "no_object"],
    ["I'll call you tomorrow", { due: "2026-05-09", said: "2026-05-09T02:00:00.000Z", zone: CHICAGO }, "kept"],
    ["I'll call you tomorrow", { due: "2026-05-10", said: "2026-05-09T02:00:00.000Z", zone: CHICAGO }, "kept"],
    ["I'll call you tomorrow", { due: "2026-05-09", said: "2026-05-09T02:00:00.000Z" }, "no_object"],
    // 10:00 in Paris (08:00 UTC): "in a sec" dated that day is refused; the next day is kept.
    ["I'll call you in a sec", { due: "2026-05-08", said: "2026-05-08T08:00:00.000Z", zone: PARIS }, "no_object"],
    ["I'll call you in a sec", { due: "2026-05-09", said: "2026-05-08T08:00:00.000Z", zone: PARIS }, "kept"],
    // Just past midnight in Paris (23:30 UTC the day before): the earlier day, UTC's, is the line's.
    ["I'll call you in a sec", { due: "2026-05-08", said: "2026-05-07T23:30:00.000Z", zone: PARIS }, "kept"],
    ["I'll call you in a sec", { due: "2026-05-07", said: "2026-05-07T23:30:00.000Z", zone: PARIS }, "no_object"],
    // A promise to get back to someone counts once it has a date of its own, and not before.
    ["I'll get back to you", { due: "2026-05-08" }, "kept"],
    ["I'll get back to you by Friday", {}, "kept"],
    ["I'll get back to you tomorrow", {}, "kept"],
    ["I'll get back to you", {}, "no_object"],
    ["I'll get back to you soon", {}, "no_object"],
    ["see you Friday", {}, "no_object"],
    // The words before must name something: not a remark or a sentence's first word.
    ["I'll handle that", { before: "Love you both. Happy birthday!" }, "no_object"],
    ["I'll handle that", { before: "Running late" }, "no_object"],
    ["I'll handle that", { before: "Calling back in 20 min" }, "no_object"],
    ["I'll handle that", { before: "Have a great day." }, "no_object"],
    ["I'll handle that", { before: "That works." }, "no_object"],
    ["I'll handle that", { before: "Thanks for the help." }, "no_object"],
    ["I'll handle that", { before: "From: Robin Vale <robin@example.org>\nTo: owner@example.org\n\nHi," }, "no_object"],
    ["I'll handle that", { before: "Rhea needs an answer." }, "kept"],
    ["I'll handle that", { before: "Ask Rhea." }, "kept"],
    // Remarks and asks stay refused, whatever comes with them.
    ["I'll be there", { due: "2026-05-08" }, "no_object"],
    ["I'll be there", { before: "The offsite dinner is on Friday." }, "no_object"],
    ["I'll cover the rest", { due: "2026-05-08" }, "no_object"],
    ["calling back in a second", { before: "The signed lease is ready." }, "no_object"],
    ["Tell her I apologize", { due: "2026-05-08" }, "remark"],
    ["Can you send it?", { due: "2026-05-08" }, "ask"],
    ["please send it", { before: "The signed lease is ready." }, "ask"],
  ];

  for (const [what, more, expected] of NEAR_MISSES)
    it(`${JSON.stringify(what)} ${JSON.stringify(more)} is ${expected}`, () => {
      expect(judged(what, more)).toBe(expected);
    });
});

describe("a promise past a courtesy", () => {
  it("is judged from the promise, however it opens", () => {
    for (const what of [
      "Thanks for the intro, will send the deck Friday",
      "Sorry, we'll wire the deposit Friday",
      "Thanks, we will wire the deposit Friday",
      "Thanks, I can send the deck Friday",
    ])
      expect(spoken(what), what).toBeNull();
  });

  it("a courtesy with no promise in it stays a remark, and I can't is no promise", () => {
    expect(spoken("Thanks for the intro")).toEqual({ reason: "not_a_promise", issue: "remark" });
    expect(spoken("Sorry, I can't make the dinner")).toEqual({ reason: "not_a_promise", issue: "remark" });
  });

  it("an ask stays an ask, whatever follows it", () => {
    expect(spoken("Can you send the form so I can file the claim")).toEqual({ reason: "not_a_promise", issue: "ask" });
    expect(spoken("Please send the form so I can file the claim")).toEqual({ reason: "not_a_promise", issue: "ask" });
  });
});

describe("what the speaker says the other will receive", () => {
  it("is the speaker's promise, and what the other must do is not", () => {
    for (const what of [
      "You'll have the draft by Friday",
      "You will get the signed lease tomorrow",
      "You'll receive the invoice Monday",
      "You'll hear the board's answer Friday",
    ])
      expect(spoken(what), what).toBeNull();
    expect(spoken("You'll have to send the draft")).toEqual({ reason: "wrong_direction", issue: "speaker_says_you" });
    expect(spoken("You'll send the draft")).toEqual({ reason: "wrong_direction", issue: "speaker_says_you" });
  });
});
