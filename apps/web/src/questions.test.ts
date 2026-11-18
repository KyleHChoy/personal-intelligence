// @vitest-environment jsdom
import { type CardDetail, keyedLine, linePart, TARGET_NO_NAME } from "@intelligence/contracts/personal";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardBody, draftQuestion } from "./card-parts.tsx";
import { cardShape } from "./cards.ts";
import { handedQuestion } from "./questions.ts";
import { internalsIn, internalsOn } from "./test-support/internals.ts";
import { RAW_CARDS } from "./test-support/raw-cards.ts";
import { ToastProvider } from "./toast.tsx";

// An agent's field, under the name code gives it.
const field_ = (name: string, value: string) =>
  keyedLine("agent", "field", [linePart.code(name), linePart.text(value)]);

// Every card asks one crisp question in plain English, its
// answers plain replies that say what they do, the message it came from cited beneath, and nothing
// else until the owner asks for the evidence. Held on the raw shapes the store really sends, every kind.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const byKind = (kind: string, index = 0): CardDetail => {
  const found = RAW_CARDS.filter((one) => one.kind === kind)[index];
  if (found === undefined) throw new Error(`no ${kind} card`);
  return found;
};
const question = (card: CardDetail): string => cardShape(card).question;

describe("every kind's question", () => {
  it("a rule card says what the owner is confirming, and a pair's rule that it makes rulings", () => {
    const rule = byKind("question_rule");
    const as = (pattern: string, answer: string) =>
      JSON.parse(JSON.stringify(rule).replaceAll("about_you:situation", pattern).replaceAll('"reject"', `"${answer}"`));
    expect(question(rule)).toBe(
      'Your last 10 answers on facts an agent says about you, of the kind "situation" were all "no". Stop asking about these?',
    );
    expect(question(as("same_person:local_part:2", "same"))).toContain("Rule every such pair one person from now on");
    expect(question(as("same_person:local_part:2", "same"))).toContain(
      "one's address spells the other's name and you know both",
    );
    expect(question(as("same_person:name:1", "different"))).toContain("two people");
    expect(question(as("idea:idea", "no"))).toContain("the planner's ideas");
  });
  it("asks each kind one plain question from its content", () => {
    expect(question(byKind("about_you"))).toBe("Do you prefer window seats?");
    expect(question(byKind("about_you", 1))).toBe("Do you need a quieter place to work in the mornings?");
    expect(question(byKind("agent_claim"))).toBe("Is Dana Example Head of Events at Example Works?");
    expect(question(byKind("agent_claim", 1))).toBe("The fact this asked about has since been removed. Clear it?");
    expect(question(byKind("client_preference"))).toBe("Should your agents work this way: short replies?");
    expect(question(byKind("same_person"))).toBe("Are Dana Example and D. Example the same person?");
    expect(question(byKind("shared_address"))).toBe("Is desk@example.com shared by more than one person?");
    expect(question(byKind("same_fact"))).toBe('Do "window seats" and "a seat by the window" say the same thing?');
    expect(question(byKind("relation_audit"))).toBe('Does "window seats" support "a seat by the window"?');
    // The fixture's proposal is one no agent can carry out yet: going ahead is the owner's to do.
    expect(question(byKind("opportunity_decision"))).toBe(
      "Go ahead and write back to Dana about the venue for the offsite yourself?",
    );
    const agentCan = byKind("opportunity_decision");
    expect(
      question({ ...agentCan, lines: agentCan.lines.filter((line) => !line.text.startsWith("no registered agent")) }),
    ).toBe("Should an agent write back to Dana about the venue for the offsite?");
    expect(question(byKind("owner_question"))).toBe("Do you still want to run the spring half marathon?");
    expect(question(byKind("idea"))).toBe("Worth doing: plan the spring offsite before the venue books up?");
    expect(question(byKind("lesson"))).toBe("Is this right: Replies to Dana land best in the morning?");
    expect(question(byKind("reminder"))).toBe("Have you done this yet: check whether Dana answered about the venue?");
    expect(question(byKind("goal_proposal"))).toBe(
      'Reword your goal "Run a half marathon" as "Run the spring half marathon in under two hours"?',
    );
    expect(question(byKind("goal_proposal", 1))).toBe(
      'Is your goal "Find a role in clinic operations" after Northwind Clinics?',
    );
    // Code's words for someone with no name read as the middle of a sentence.
    const unnamed = byKind("goal_proposal", 1);
    const lines = (unnamed.lines ?? []).map((line) =>
      line.text === "Northwind Clinics" ? { ...line, text: TARGET_NO_NAME } : line,
    );
    expect(question({ ...unnamed, lines })).toBe(
      'Is your goal "Find a role in clinic operations" after someone you have no name for?',
    );
    expect(question(byKind("draft_waiting"))).toBe(
      'Keep the draft "Re: the spring residency" to marta@college.example for you to send?',
    );
    expect(question(byKind("outcome"))).toBe("Did you find the venue's spring prices?");
    expect(question(byKind("outcome", 1))).toBe(
      'Was this useful: "Two people run it: Dana Example and a volunteer board"?',
    );
    expect(question(byKind("research_request"))).toBe("Let an agent search the web about Dana Example?");
    expect(question(byKind("tier_proposal"))).toBe("Move Sam Example to Close, like others who work at Example Org?");
    expect(question(byKind("grant_suggestion"))).toBe(
      "Finch was right about your preferences 28 of the last 30 times. Keep what it quotes you saying without asking you?",
    );
    expect(question(byKind("grant_lift_suggestion"))).toBe(
      "Finch was right about rules you live by only 24 of the last 31 times. Ask you again about each?",
    );
    // A lift proposed for what the owner marked not true says so.
    const lift = byKind("grant_lift_suggestion");
    const notTrue = keyedLine("code", "not_true", [linePart.count(3), linePart.count(10)]);
    expect(question({ ...lift, lines: [...lift.lines, notTrue] })).toBe(
      "You marked 3 of the 10 facts kept from Finch about rules you live by not true. Ask you again about each?",
    );
    // Its answer never grants: the card shows the exact command that does.
    expect(cardShape(byKind("grant_suggestion")).command).toBe("pia facts grant finch preference");
    expect(cardShape(byKind("grant_lift_suggestion")).command).toBe("pia facts grant-lift finch constraint");
    expect(question(byKind("notice"))).toBe("A run stopped because it reached its spending cap");
    expect(question(byKind("ignore_narrowed"))).toBe("Others at alder.example are no longer ignored");
    // Asked as a question its one reply answers.
    expect(question(byKind("calibration_drift"))).toBe(
      "A model's answers drifted from yours. Keep deciding yourself about whether proposed work goes ahead?",
    );
    expect(question(byKind("stale_restatement"))).toBe("Tell Agent-one that a fact it repeats is out of date");
    expect(question(byKind("ruling_carry"))).toBe("Still never use this fact?");
    expect(cardShape(byKind("ruling_carry")).factAsk).toEqual({ before: "Still never use", after: "" });
  });

  it("asks a box health card to be looked at, by what went wrong", () => {
    const notice = byKind("notice");
    const card = {
      ...notice,
      kind: "box_health",
      options: ["acknowledge"],
      lines: [
        keyedLine("code", "health", [linePart.code("hold")]),
        keyedLine("code", "about", [linePart.code("sync_hold")]),
      ],
    } as CardDetail;
    const asked = question(card);
    expect(asked).toBe("The sync hold has been on for over an hour");
    expect(asked).not.toBe("Is this right?");
    expect(internalsIn([asked])).toEqual([]);
  });

  // An account by the owner's label and a Mac's kind of capture by the Mac's name,
  // as Settings › Health names them.
  it("names the account or the Mac a box health card is about", () => {
    const notice = byKind("notice");
    const quiet = (about: string): CardDetail =>
      ({
        ...notice,
        kind: "box_health",
        options: ["seen"],
        lines: [
          keyedLine("code", "health", [linePart.code("silent")]),
          keyedLine("code", "about", [linePart.code(about)]),
        ],
      }) as CardDetail;
    const names = {
      account: (id: string) => (id === "acc_1" ? "school mail" : undefined),
      device: (id: string) => (id === "cli_9" ? "Studio-mac" : undefined),
    };
    expect(cardShape(quiet("account/acc_1"), names).question).toBe("School mail has gone quiet");
    expect(cardShape(quiet("capture_class/cli_9:meeting"), names).question).toBe(
      "Meetings from Studio-mac have stopped arriving",
    );
    expect(cardShape(quiet("capture_class/cli_9:moment"), names).question).toBe(
      "Screen reading from Studio-mac has stopped arriving",
    );
    // Not yet known to the page: still the kind, never an id.
    expect(cardShape(quiet("capture_class/cli_8:task")).question).toBe("Tasks from a Mac have stopped arriving");
    expect(cardShape(quiet("account/acc_2")).question).toBe("A connected account has gone quiet");
  });

  // Whatever the store says went quiet, the card says what: a job, a lane, a Mac, an agent, and
  // one this page has no word for yet. Never "something".
  it("says what went quiet for every kind of row the store raises one about", () => {
    const notice = byKind("notice");
    const quiet = (about: string): CardDetail =>
      ({
        ...notice,
        kind: "box_health",
        options: ["seen"],
        lines: [
          keyedLine("code", "health", [linePart.code("silent")]),
          keyedLine("code", "about", [linePart.code(about)]),
        ],
      }) as CardDetail;
    const names = { device: (id: string) => (id === "cli_9" ? "Studio-mac" : undefined) };
    const said = (about: string) => cardShape(quiet(about), names).question;
    expect(said("job/sync")).toBe("Syncing your accounts has stopped running");
    expect(said("job/dream")).toBe("The nightly pass over what is known has stopped running");
    expect(said("job/erase_settle")).toBe("Applying what you forgot on your Mac has stopped running");
    expect(said("job/work_tick")).toBe("Checking for work has stopped running");
    expect(said("job/a_new_job")).toBe("A job of the box has stopped running");
    expect(said("lane/email")).toBe("Reading your mail for facts has stopped");
    expect(said("lane/a_new_lane")).toBe("Reading one kind of item for facts has stopped");
    expect(said("device/cli_9")).toBe("Studio-mac has stopped sending");
    expect(said("device/cli_8")).toBe("A Mac has stopped sending");
    expect(said("client/cli_7")).toBe("An agent let work lapse without reporting");
    // A kind this page does not know, and one cut to its kind for want of a name.
    expect(said("a_new_kind/x")).toBe("Part of the box has gone quiet");
    expect(said("account")).toBe("A connected account has gone quiet");
    expect(said("job")).toBe("A job of the box has stopped running");
    for (const about of ["job/sync", "lane/email", "a_new_kind/x", "client/cli_7"])
      expect(said(about)).not.toMatch(/something/i);
  });

  // Work handed to the owner asked as whether they did it.
  it("asks work handed to the owner whether they did it", () => {
    expect(handedQuestion("Intro to Ada Whitfield through Marta")).toBe(
      "Did you make the intro to Ada Whitfield through Marta?",
    );
    expect(handedQuestion("Write back to Dana about the venue")).toBe("Did you write back to Dana about the venue?");
    // A title spliced after "Follow up on" is said as what it is about.
    expect(handedQuestion("Follow up on Find out who runs the community garden with Example Garden Club")).toBe(
      "Did you follow up with Example Garden Club about who runs the community garden?",
    );
    expect(handedQuestion("Follow up on Plan the spring reading")).toBe(
      'Did you follow up on "Plan the spring reading"?',
    );
    expect(handedQuestion("Follow up on Meet with Ada about the lease with Dana")).toBe(
      'Did you follow up with Dana about "Meet with Ada about the lease"?',
    );
    // A title of one verb is never split from its own "with": the title is the whole.
    expect(handedQuestion("Follow up on Meet with Ada")).toBe('Did you follow up on "Meet with Ada"?');
    expect(handedQuestion("The venue shortlist")).toBe("Have you done this yet: The venue shortlist?");
    expect(handedQuestion(null)).toBe("Have you done this yet?");
  });

  it("asks about the owner by the kind of fact, in the second person", () => {
    const about = byKind("about_you");
    const asking = (type: string, field: string, value: string, extra: Record<string, string> = {}) =>
      question({
        ...about,
        lines: [
          ...about.lines.filter((line) => line.from === "code"),
          keyedLine("agent", "type", [linePart.code(type)]),
          field_(field, value),
          ...Object.entries(extra).map(([k, v]) => field_(k, v)),
        ],
      });
    expect(asking("situation", "state", "moving flats")).toBe("Are you currently moving flats?");
    expect(asking("situation", "state", "On parental leave")).toBe("Are you currently on parental leave?");
    expect(asking("situation", "state", "The landlord raised the rent")).toBe(
      "Is this your situation now: The landlord raised the rent?",
    );
    expect(asking("preference", "object", "aisle seats", { polarity: "avoids" })).toBe("Do you avoid aisle seats?");
    expect(asking("goal", "objective", "run a half marathon")).toBe("Is this one of your goals: run a half marathon?");
    expect(asking("constraint", "rule", "no flights before 8am")).toBe(
      "Is this a rule you keep: no flights before 8am?",
    );
  });

  it("never lowers a name, reads a noun in -ing as no state, and asks a clause as Is this right", () => {
    const opp = byKind("opportunity_decision");
    const said = (kind: string, card: CardDetail, text: string, from: "model" | "agent") =>
      question({
        ...card,
        kind,
        lines: [...card.lines.filter((line) => line.from === "code" && line.key !== "handed"), { text, from }],
      });
    expect(said("opportunity_decision", opp, "Dana asked about the venue; reply to her", "model")).toBe(
      "Should an agent take this on: Dana asked about the venue; reply to her?",
    );
    expect(said("idea", byKind("idea"), "Remy should start a newsletter", "model")).toBe(
      "Worth doing: Remy should start a newsletter?",
    );
    const about = byKind("about_you");
    const state = (value: string) =>
      question({
        ...about,
        lines: [
          ...about.lines.filter((line) => line.from === "code"),
          keyedLine("agent", "type", [linePart.code("situation")]),
          field_("state", value),
        ],
      });
    expect(state("Spring break in Mexico")).toBe("Is this your situation now: Spring break in Mexico?");
    expect(state("Something urgent at home")).toBe("Is this your situation now: Something urgent at home?");
    const claim = byKind("agent_claim");
    const told = (text: string) =>
      question({
        ...claim,
        lines: [...claim.lines.filter((line) => line.from !== "agent" && line.key !== "type"), { text, from: "agent" }],
      });
    expect(told("Dana Example, who is the treasurer, works at Acme")).toBe(
      "Is this right: Dana Example, who is the treasurer, works at Acme?",
    );
    expect(told("The garden Dana runs is closing")).toBe("Is the garden Dana runs closing?");
  });

  it("names every recipient of a draft by name", () => {
    expect(draftQuestion('Keep the draft "Venue" to a@x.example, b@y.example for you to send?', "Dana, Ada")).toBe(
      'Keep the draft "Venue" to Dana, Ada for you to send?',
    );
    expect(draftQuestion("Keep this draft for you to send?", "Dana")).toBe("Keep this draft to Dana for you to send?");
  });

  it("asks about someone else by name", () => {
    const claim = byKind("agent_claim");
    const lines = claim.lines
      .map((line) =>
        line.key === "field" && line.value?.[0]?.kind === "code" && line.value[0].code === "title"
          ? field_("title", "the chair of the community garden")
          : line,
      )
      .filter((line) => !(line.key === "field" && line.text.startsWith("organization_name")));
    expect(question({ ...claim, lines })).toBe("Is Dana Example the chair of the community garden?");
  });

  it("says no field name, code or raw shape in any kind's question, citation or reply", () => {
    for (const card of RAW_CARDS) {
      const shape = cardShape(card);
      const texts = [
        shape.question,
        ...shape.cites.flatMap((one) => [one.subject, one.from ?? ""]),
        ...Object.values(shape.replies).map((one) => one.label),
        shape.commandWhy ?? "",
      ].filter((one) => one !== "");
      expect(internalsIn(texts), card.kind).toEqual([]);
      // A card with one answer says what happened; every other asks.
      expect(shape.question.endsWith("?"), card.kind).toBe(
        card.options.length > 1 || card.kind === "ruling_carry" || card.kind === "calibration_drift" || shape.gone,
      );
    }
  });

  it("cites the message a card came from by its subject and sender, opening by its id", () => {
    const cites = cardShape(byKind("owner_question")).cites;
    expect(cites).toEqual([
      {
        kind: "message",
        id: expect.stringMatching(/^msg_/),
        subject: "Spring race: your entry is confirmed",
        from: "Race Office",
      },
    ]);
    expect(cardShape(byKind("outcome", 1)).cites).toEqual([
      { kind: "message", id: expect.stringMatching(/^msg_/), subject: "Garden open day", from: "Dana Example" },
    ]);
    // A subject holding the mark that sets off its sender stays whole: the sender is what follows the last.
    const outcome = byKind("outcome", 1);
    const held = {
      ...outcome,
      lines: outcome.lines.map((line) =>
        line.text === "Garden open day · from Dana Example"
          ? { ...line, text: "Notes · from the board · from Dana Example" }
          : line,
      ),
    };
    expect(cardShape(held).cites).toEqual([
      {
        kind: "message",
        id: expect.stringMatching(/^msg_/),
        subject: "Notes · from the board",
        from: "Dana Example",
      },
    ]);
    // A message an agent's words named, which `pi web` named, is cited too.
    const about = {
      ...byKind("about_you"),
      mentions: [
        {
          words: "Booking the spring flights",
          open: { kind: "message" as const, id: "msg_01J00000000000000000000077" },
        },
      ],
    };
    expect(cardShape(about).cites).toEqual([
      { kind: "message", id: "msg_01J00000000000000000000077", subject: "Booking the spring flights", from: null },
    ]);
  });
});

let root: Root | undefined;
let host: HTMLElement | undefined;
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    async () => ({ ok: false, status: 404, json: async () => ({ refused: "not_here" }) }) as Response,
  );
});
afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});
async function render(card: CardDetail): Promise<HTMLElement> {
  const into = document.createElement("div");
  document.body.append(into);
  host = into;
  const made = createRoot(into);
  root = made;
  await act(async () =>
    made.render(createElement(ToastProvider, null, createElement(CardBody, { card, onAnswered: () => {} }))),
  );
  return into;
}

describe("a card opened", () => {
  for (const card of RAW_CARDS)
    it(`${card.kind} shows its citation and replies, its details folded, one action bar last`, async () => {
      const into = await render(card);
      expect(internalsOn(into)).toEqual([]);
      // The evidence, rows, sources and any terminal command, is folded under Details, closed.
      const fold = into.querySelector<HTMLDetailsElement>("details.fold");
      expect(fold?.open).toBe(false);
      expect(into.querySelectorAll(".actbar")).toHaveLength(1);
      expect(into.querySelector(".actbar ~ :not(.toast)")).toBeNull();
    });

  it("a cited message is one tap to open, and the replies say what they do", async () => {
    const into = await render(byKind("owner_question"));
    const cite = into.querySelector<HTMLButtonElement>("button.cite");
    expect(cite?.getAttribute("aria-label")).toBe("Read the message: Spring race: your entry is confirmed");
    expect(cite?.textContent).toBe("Spring race: your entry is confirmedRace Office");
    // The main answer is primary; the declines are quiet links at the right.
    expect([...into.querySelectorAll(".actbar .btn")].map((one) => one.textContent)).toEqual(["Yes"]);
    expect([...into.querySelectorAll(".actbar .lnk")].map((one) => one.textContent)).toEqual([
      "No",
      "Ask me later",
      "Ask an agent",
      "Add a note",
    ]);
  });

  it("an about-you card answers Yes, Not quite (its Edit) and No", async () => {
    const into = await render(byKind("about_you"));
    expect([...into.querySelectorAll(".actbar .btn")].map((one) => one.textContent)).toEqual([
      "Yes",
      "Not quite",
      "No",
    ]);
  });
});

it("reads a structured cited message without splitting subject or sender text", () => {
  const outcome = byKind("outcome", 1);
  for (const [subject, from] of [
    ["Notes · from the board", null],
    ["Notes · from the board", "Dana · from Example"],
  ] as const) {
    const held = {
      ...outcome,
      lines: outcome.lines.map((line) =>
        line.text === "Garden open day · from Dana Example"
          ? {
              from: "source" as const,
              key: "cited_message" as const,
              text: from === null ? subject : `${subject} · from ${from}`,
              value: [
                { kind: "text" as const, text: subject },
                ...(from === null ? [] : [{ kind: "text" as const, text: from }]),
              ],
            }
          : line,
      ),
    };
    expect(cardShape(held).cites).toEqual([{ kind: "message", id: expect.stringMatching(/^msg_/), subject, from }]);
  }
});
