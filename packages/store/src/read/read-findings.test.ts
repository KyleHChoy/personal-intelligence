import { describe, expect, it } from "vitest";
import { namesTest, readsFindings } from "./read-findings.ts";

// Which sentence names a person, and who is given findings. Synthetic values only.

describe("a person's name in a finding", () => {
  const names = namesTest(["Robin", "Robin Vale", "will"], ["robin@vale.example"]);

  it("takes a full name or an address in any case", () => {
    expect(names("robin vale wrote back.")).toBe(true);
    expect(names("Sent to ROBIN@vale.example.")).toBe(true);
  });

  it("takes one word only with a capital, however it is held", () => {
    expect(names("Robin moved the call.")).toBe(true);
    expect(names("the robin sang.")).toBe(false);
    expect(names("It will rain.")).toBe(false);
    expect(names("Will moved the call.")).toBe(true);
  });

  it("leaves someone else of that first name, and keeps their own surname", () => {
    expect(names("Robin Stone moved the call.")).toBe(false);
    expect(names("Robin Vale moved the call.")).toBe(true);
  });
});

describe("who is given findings", () => {
  it("a client that could read them already: the Self view and a tool that serves them", () => {
    expect(readsFindings(["self"], ["get_self", "build_context_pack"])).toBe(true);
    expect(readsFindings(["self"], ["read_record"])).toBe(true);
    expect(readsFindings(["self"], ["get_self"])).toBe(false);
    expect(readsFindings(["people"], ["find_records"])).toBe(false);
  });
});

describe("a one-word name opening a sentence", () => {
  const names = namesTest(["Mark"], []);
  it("is a verb until it does what a person does", () => {
    expect(names("Mark the card as done.")).toBe(false);
    expect(names("Mark said the call moved.")).toBe(true);
    expect(names("Mark's call moved.")).toBe(true);
    expect(names("The call with Mark moved.")).toBe(true);
  });
});

describe("a sentence about someone else", () => {
  const names = namesTest(["Robin Vale"], ["robin@vale.example"]);
  const firstName = namesTest(["Robin", "Robin Vale"], []);

  it("that another person opens, naming this one only after a preposition, is not theirs", () => {
    expect(
      names("Sam Hart holds a student address and appears on class mail, including a message from Robin Vale."),
    ).toBe(false);
    expect(names("Sam Hart wrote to Robin Vale about the deck.")).toBe(false);
  });

  it("that names a second person is theirs when this one is said directly", () => {
    expect(firstName("Sam Hart emailed on Nov 4: Robin has a family emergency, ask to move the call.")).toBe(true);
    expect(
      names("The Nov 5 Robin Vale call was rescheduled after Sam Hart reported an emergency for Robin Vale."),
    ).toBe(true);
    expect(names("Sam Hart and Robin Vale met on Tuesday.")).toBe(true);
    expect(names("Sam Hart reported that the call with Robin Vale moved to Friday.")).toBe(true);
    expect(names("Robin Vale wrote to Sam Hart.")).toBe(true);
  });

  it("that a thing, not a person, opens stays theirs", () => {
    expect(names("Weekly Update from Robin Vale says teams report twice a week.")).toBe(true);
    expect(names("HIS 2200 (Robin Vale, class mail, 10:15 AM CT, to the section): groups must now meet often.")).toBe(
      true,
    );
  });

  it("that names several others is theirs to none", () => {
    expect(names("Sam Hart, Mina Rao and Theo Lund all copied Robin Vale on the plan.")).toBe(false);
    expect(names("Robin Vale saw it on Thu Nov 5 and Fri Nov 6 and Sat Nov 7.")).toBe(true);
    // Capitals that name nobody are not counted: time zones, a shouted label.
    expect(names("Call prep, Robin Vale (Water Policy), 2:00 PM CST on Zoom, his noon PT, TEAM NAME update.")).toBe(
      true,
    );
  });

  it("short clauses, a time's colon and a subject before the colon are no list", () => {
    expect(names("Robin Vale moved the call, asked for Friday, confirmed noon, sent notes.")).toBe(true);
    expect(names("Robin Vale moved the call to 10:30, Friday, room 2, on Zoom.")).toBe(true);
    expect(names("Robin Vale wants four things: the deck, the budget, the plan, the dates.")).toBe(true);
  });

  it("that reads as a list is no one's", () => {
    expect(
      names(
        "Already sent today and not repeated here: Robin Vale test comments, a login notice, Red team notes, a price snapshot.",
      ),
    ).toBe(false);
    expect(
      names(
        "Robin Vale asked for the deck, the budget, the plan, the dates and the slides by Friday morning next week please.",
      ),
    ).toBe(true);
  });
});
