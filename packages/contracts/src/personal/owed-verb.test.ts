import { describe, expect, it } from "vitest";
import { owedVerb, owedWords } from "./owed-verb.ts";

describe("owedWords", () => {
  it("keeps the rest inside { untrusted }, and held wording is Do with no rest", () => {
    expect(owedWords({ untrusted: "sign the lease" })).toEqual({ verb: "Sign", rest: { untrusted: "the lease" } });
    expect(owedWords(null)).toEqual({ verb: "Do", rest: null });
  });
});

describe("owedVerb", () => {
  it("takes a listed verb from the front of the wording, in any case", () => {
    expect(owedVerb("send the deck to Dana Example")).toEqual({ verb: "Send", rest: "the deck to Dana Example" });
    expect(owedVerb("  Review   the draft ")).toEqual({ verb: "Review", rest: "the draft" });
    expect(owedVerb("PAY the invoice")).toEqual({ verb: "Pay", rest: "the invoice" });
  });

  it("passes over a leading 'to'", () => {
    expect(owedVerb("to book a room")).toEqual({ verb: "Book", rest: "a room" });
  });

  it("is Do, with the whole wording, when the first word is no listed verb", () => {
    expect(owedVerb("the deck for Friday")).toEqual({ verb: "Do", rest: "the deck for Friday" });
    expect(owedVerb("sending notes")).toEqual({ verb: "Do", rest: "sending notes" });
    expect(owedVerb("to")).toEqual({ verb: "Do", rest: "to" });
    expect(owedVerb("")).toEqual({ verb: "Do", rest: "" });
  });

  it("reads a verb with punctuation after it, and one standing alone", () => {
    expect(owedVerb("Call: the venue")).toEqual({ verb: "Call", rest: "the venue" });
    expect(owedVerb("reply")).toEqual({ verb: "Reply", rest: "" });
    expect(owedVerb("do the taxes")).toEqual({ verb: "Do", rest: "the taxes" });
  });
});
