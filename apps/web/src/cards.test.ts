import { CARD_LIFTS, CARD_OPTIONS, CardDetail, keyedLine, linePart } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { CARD_KINDS } from "./card-kinds.ts";
import { cardGroup, waitingOrder } from "./card-order.ts";
import { cardHead, cardShape } from "./cards.ts";
import { internalsIn } from "./test-support/internals.ts";
import { RAW_CARDS } from "./test-support/raw-cards.ts";

// A card as the owner reads it, from the lines the store's renderers really write: its content as its
// title, no code line, id, field name or ISO time anywhere in what the page shows.

const shown = (card: (typeof RAW_CARDS)[number]): string[] => {
  const shape = cardShape(card);
  return [
    shape.title,
    shape.sub,
    ...cardHead(card, shape).flatMap((row) => [row.k, row.v]),
    ...shape.rows.flatMap((row) => [row.k, row.v]),
    ...shape.notes,
  ];
};

it("holds one card of each kind, each a CardDetail as the read answers it", () => {
  for (const one of RAW_CARDS) expect(CardDetail.safeParse(one).success, one.kind).toBe(true);
});

describe("every kind's card", () => {
  for (const card of RAW_CARDS)
    it(`${card.kind} reads in words`, () => {
      expect(internalsIn(shown(card))).toEqual([]);
    });
});

it("says a proposal's terminal line as words, keeping a lead that is not a polarity", () => {
  const about = RAW_CARDS.find((one) => one.kind === "about_you")!;
  const titled = (text: string) =>
    cardShape({ ...about, lines: [{ text, from: "agent" }, ...about.lines.filter((line) => line.from === "code")] })
      .title;
  expect(titled("Goal (health): run a half marathon")).toBe("Goal: run a half marathon");
  expect(titled("Avoids (food): peanuts")).toBe("Avoids peanuts");
});

it("leads with the card's content, and says who it is about by name", () => {
  const byKind = (kind: string, index = 0) =>
    cardShape(RAW_CARDS.filter((one) => one.kind === kind)[index] ?? RAW_CARDS[0]!);
  expect(byKind("opportunity_decision").title).toBe("Write back to Dana about the venue for the offsite");
  expect(byKind("opportunity_decision").rows).toEqual(
    expect.arrayContaining([
      { k: "Why now", v: "She asked on Tuesday and the venue holds the date until Friday", by: "From an agent" },
      { k: "Cites", v: "Offsite venue, from Dana Example" },
      { k: "Follows from", v: "The offsite needs a venue soon" },
    ]),
  );
  expect(byKind("opportunity_decision").notes).toContain(
    "No agent can carry this out yet: going ahead means you do it yourself.",
  );
  expect(byKind("agent_claim").title).toBe("Dana Example: Head of Events at Example Works");
  expect(byKind("agent_claim").sub).toContain("About Dana Example");
  expect(byKind("agent_claim", 1).notes).toContain("The fact it was about has since been removed.");
  // A proposal's terminal line is said as a sentence, its part of life dropped.
  expect(byKind("about_you").title).toBe("Prefers window seats");
  expect(byKind("about_you", 1).title).toBe("A quieter place to work in the mornings");
  // A title has no full stop; a question or a lesson of the planner's says why it asks,
  // and a question what it was drawn from.
  expect(byKind("notice").title).toBe("The run stopped: it reached its spending cap");
  expect(byKind("owner_question").rows).toEqual(
    expect.arrayContaining([
      { k: "Cites", v: "Spring race: your entry is confirmed, from Race Office" },
      { k: "Why it asks", v: expect.stringContaining("The planner asks") },
    ]),
  );
  expect(byKind("lesson").rows).toContainEqual({ k: "Why it asks", v: expect.stringContaining("earlier answers") });
  // The draft is shown in its card (opened.tsx), not sent to a terminal to read.
  expect(byKind("draft_waiting").command).toBeNull();
  expect(byKind("draft_waiting").notes.join(" ")).not.toContain("terminal");
  // A draft is named by its subject and to whom, as the agent wrote them.
  expect(byKind("draft_waiting").title).toBe("Re: the spring residency");
  expect(byKind("draft_waiting").sub).toBe("To marta@college.example · From an agent");
  expect(byKind("draft_waiting").rows).toEqual([]);
  expect(byKind("goal_proposal").title).toBe("Reword your goal: Run the spring half marathon in under two hours");
  expect(byKind("goal_proposal", 1).title).toBe("Set who your goal is after: Northwind Clinics");
  // Holders share the name: when each was last seen tells them apart, and no id is shown but in the
  // one command the owner runs, whose name is the card's to read, never pasted from an agent.
  const held = byKind("goal_proposal", 1);
  const rows = held.rows.filter((one) => one.k === "Holds that name").map((one) => one.v);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatch(/^Northwind Clinics Ltd, last seen /);
  expect(rows[1]).toBe("Northwind Clinics, not seen yet");
  expect(JSON.stringify(held.rows)).not.toContain("ent_");
  expect(held.command).toBe('pia goal target ID --name "NAME"');
  expect(byKind("same_fact").rows).toEqual([
    { k: "First", v: "window seats" },
    { k: "Second", v: "a seat by the window" },
  ]);
  // An agent by its name, capitalised, as Settings lists it.
  expect(byKind("stale_restatement").rows[0]).toEqual({ k: "Agent", v: "Agent-one" });
  // Where a model decides, in words, never its decision point's code.
  expect(byKind("calibration_drift").rows).toContainEqual({ k: "Where", v: "Whether proposed work goes ahead" });
});

it("gives every notice the terminal command that resolves it, and names a question code asks by what it is about", () => {
  const byKind = (kind: string) => cardShape(RAW_CARDS.find((one) => one.kind === kind) ?? RAW_CARDS[0]!);
  // A run that hit its cap, an ignore that narrowed, a ruling with no home, an agent repeating itself.
  expect(byKind("notice").command).toBe("pia work budget --usd N");
  expect(byKind("notice").ack).toBe("Keep the cap");
  // The card names its ignore (by its ruling, which the opened card names by
  // whom it covers) and the new domain, and the add is that exact command.
  expect(byKind("ignore_narrowed").command).toBe("pia ignore add domain alder.example");
  expect(byKind("ignore_narrowed").then).toBeUndefined();
  expect(byKind("ignore_narrowed").ignore).toMatch(/^rul_/);
  // One plain sentence, never "ignore" as a noun, and nothing it contradicts.
  expect(byKind("ignore_narrowed").title).toBe("Others at alder.example are no longer ignored");
  expect(byKind("ignore_narrowed").rows).toEqual([]);
  expect(byKind("ignore_narrowed").notes.join(" ")).not.toMatch(/\b(an|the|your|this) ignore\b/i);
  // Each answer says what it does.
  expect(byKind("ignore_narrowed").ack).toBe("Keep only those ignored");
  // A card raised before it carried its domain lists the ignores, then adds the one the owner finds.
  const old = RAW_CARDS.find((one) => one.kind === "ignore_narrowed")!;
  const before = cardShape({ ...old, lines: old.lines.filter((line) => line.from !== "source") });
  expect([before.command, before.then]).toEqual(["pia ignore list", "pia ignore add domain DOMAIN"]);
  // A ruling with one fact left to apply to is ruled again here, by the page's own write; no id is shown.
  expect(byKind("ruling_carry").resolve).toEqual({
    write: "vetoFact",
    body: { fact: "913".padStart(64, "0") },
    words: "Never use it again",
  });
  // The notice names the fact it is about, by its claim, which the page reads.
  expect(byKind("ruling_carry").fact).toEqual({ id: "913".padStart(64, "0"), lead: "Rule again on" });
  const stale = RAW_CARDS.find((one) => one.kind === "stale_restatement")!;
  const named = {
    ...stale,
    lines: [...stale.lines, keyedLine("code", "claim", [linePart.id("fact", "c".repeat(64))])],
  };
  expect(cardShape(named).fact).toEqual({ id: "c".repeat(64), lead: "Agent-one keeps repeating, out of date" });
  expect(byKind("ruling_carry").command).toBeNull();
  expect(byKind("stale_restatement").command).toBe("pia memory status --client agent-one");
  expect(byKind("calibration_drift").command).toBe("pia ladder calibrate");
  // The card says to resume it, so it gives the exact command, by the step's name.
  expect(byKind("calibration_drift").then).toBe("pia ladder resume opportunity_go");
  expect(byKind("calibration_drift").ack).toBe("Keep deciding it myself");
  expect(byKind("ruling_carry").ack).toBe("Let the ruling go");
  expect(byKind("draft_waiting").ack).toBe("Keep the draft");
  // The cap's sentence reads as a sentence.
  expect(byKind("notice").notes.join(" ")).toContain("putting the dollars a day you allow in place of N");
  expect(byKind("stale_restatement").ack).toBe("Done: I told it");
  // The store's own wording of a carry question names the ruling's verdict in brackets.
  const carry = RAW_CARDS.find((one) => one.kind === "ruling_carry")!;
  const lost = (verdict: string, ...claims: string[]) =>
    keyedLine("code", "ruling_lost", [
      linePart.id("ruling", `rul_${"0".repeat(26)}`),
      linePart.code(verdict),
      linePart.count(4),
      linePart.count(0),
      ...claims.map((claim) => linePart.id("fact", claim)),
    ]);
  const asked = { ...carry, lines: [lost("retire", "a".repeat(64))] };
  expect(cardShape(asked).resolve?.write).toBe("retireFact");
  const two = { ...carry, lines: [lost("veto", "a".repeat(64), "b".repeat(64))] };
  expect(cardShape(two).command).toBe("pia review --kind ruling_carry");
  // No command any card shows holds an id.
  for (const one of RAW_CARDS)
    expect(cardShape(one).command ?? "", one.kind).not.toMatch(/[0-9a-f]{64}|\b[a-z]{3}_[0-9A-Z]{26}\b/);
  // A tier proposal says what is proposed, for whom, in words.
  const tier = byKind("tier_proposal");
  // The trait in plain words from a fixed map per relation, never the schema's.
  expect(tier.title).toBe("Move Sam Example to Close, like others who work at Example Org?");
  expect(tier.rows).toEqual(expect.arrayContaining([{ k: "Who", v: "People who work at Example Org" }]));
  expect(tier.rows).toEqual(expect.arrayContaining([{ k: "Already close", v: "Dana Example, Lee Example" }]));
  // A card whose claim is gone says so, and leaves nothing to confirm.
  expect(cardShape(RAW_CARDS.filter((one) => one.kind === "agent_claim")[1]!).gone).toBe(true);

  // Questions code asks lead with whom or what they are about, never "Are these the same person?".
  expect(byKind("same_person").title).toBe("Dana Example and D. Example: the same person?");
  expect(byKind("same_person").sub).toBe("From your contacts and mail");
  expect(byKind("same_person").rows[0]).toEqual({
    k: "Person 1",
    v: "Dana Example · dana@example.com · 1 contact, 3 sent, 5 received, 2 meetings",
  });
  expect(byKind("shared_address").title).toBe("Is desk@example.com shared by more than one person?");
  expect(byKind("same_fact").title).toBe('"window seats" and "a seat by the window": the same?');
  expect(byKind("research_request").title).toBe(
    "Search the web about Dana Example: who this person is and what they work on",
  );
  expect(byKind("relation_audit").title).toBe('Does "window seats" support "a seat by the window"?');
  for (const kind of ["same_person", "shared_address", "same_fact", "research_request", "relation_audit"])
    expect(byKind(kind).sub, kind).not.toContain("A notice");

  // Every card here waits for an answer from the owner: the opened card says only a deadline.
  const card = RAW_CARDS[0]!;
  // The opened card does not repeat its title as a row.
  // Who and when, never where it came from again (the line under its title).
  expect(cardHead(card, cardShape(card)).map((row) => row.k)).toEqual(["When"]);
  expect(cardHead({ ...card, author: "reasoner" }, cardShape(card))[0]?.v).toMatch(/^The planner · /);
  // An agent's card says so in its head, the one place an opened card shows it, never by its id.
  const research = RAW_CARDS.find((one) => one.kind === "research_request")!;
  expect(cardHead(research, cardShape(research))).toEqual([{ k: "Said by", v: expect.stringMatching(/^An agent · /) }]);
  for (const one of RAW_CARDS) {
    const shape = cardShape(one);
    const head = cardHead(one, shape)[0]?.v ?? "";
    expect(head, one.kind).not.toContain(shape.from);
    expect(internalsIn([head]), one.kind).toEqual([]);
  }
});

// No jargon on a reword, a tier proposal or a research request.
it("says a reword without its goal's status, and a tier or a search in plain words", () => {
  const byKind = (kind: string) => cardShape(RAW_CARDS.find((one) => one.kind === kind)!);
  const goal = RAW_CARDS.find((one) => one.kind === "goal_proposal")!;
  const reword = cardShape({
    ...goal,
    lines: goal.lines.map((line) => (line.text.startsWith("change: ") ? { ...line, text: "change: reword" } : line)),
  });
  expect(reword.rows.some((one) => one.k === "Your goal now")).toBe(false);
  expect(byKind("tier_proposal").notes.join(" ")).not.toContain("ruling");
  expect(byKind("research_request").notes.join(" ")).not.toContain("allowed public facts");
});

it("ends a cited item's words at the next line that is not a source's, and reads an agent's own words as written", () => {
  const idea = RAW_CARDS.find((one) => one.kind === "idea");
  if (idea === undefined) throw new Error("no idea card");
  // admin-queue.ts appends the card's body last, here an agent's words that start like a field.
  const shape = cardShape({ ...idea, lines: [...idea.lines, { text: "re: the venue quote", from: "agent" }] });
  expect(shape.rows).toEqual([
    { k: "Cites", v: "Offsite venue, from Dana Example" },
    { k: "In the agent's words", v: "re: the venue quote" },
  ]);
});

it("says of lifts only what the contract's CARD_LIFTS holds: about you, one person, one fact", () => {
  expect(Object.keys(CARD_LIFTS).sort()).toEqual(["about_you", "same_fact", "same_person"]);
});

// Which kind goes before which within a group, whole: nothing else pins the kinds a test names no card of.
it("ranks every kind within its group, those with no rank together, newest first", () => {
  const kinds = [...Object.keys(CARD_OPTIONS), "a_kind_this_page_does_not_know"];
  const ordered = waitingOrder(kinds.map((kind) => ({ kind, createdAt: "2026-10-20T10:00:00.000Z" })));
  expect(ordered.map((one) => one.kind)).toEqual([
    "about_you",
    "owner_question",
    "client_preference",
    "opportunity_decision",
    "research_request",
    "goal_proposal",
    "draft_waiting",
    "idea",
    "tier_proposal",
    "time_effort",
    "grant_lift_suggestion",
    "grant_suggestion",
    "same_person_batch",
    "question_rule",
    "same_person",
    "shared_address",
    "same_fact",
    "agent_claim",
    "relation_audit",
    "lesson",
    "outcome",
    "reminder",
    "a_kind_this_page_does_not_know",
    "box_health",
    "notice",
    "ignore_narrowed",
    "ruling_carry",
    "calibration_drift",
    "stale_restatement",
  ]);
});

// A person's parts are read as their lines give them, never by splitting the row they are joined in.
it("reads a person from their own lines, whatever a name holds", () => {
  const card = RAW_CARDS.find((one) => one.kind === "same_person");
  const person = (n: number, ...words: string[]) => [
    keyedLine("code", "person", [linePart.count(n), linePart.id("entity", `ent_${"0".repeat(26)}`)]),
    ...words.map((text) => ({ text, from: "source" as const })),
  ];
  const lines = [...person(1, "Ada · Lovelace", "ada@example.org"), ...person(2, "A. Lovelace")];
  const shape = cardShape({ ...card, lines } as never);
  expect(shape.question).toBe("Are Ada · Lovelace and A. Lovelace the same person?");
  const shared = cardShape({ ...card, kind: "shared_address", lines } as never);
  expect(shared.question).toBe("Is ada@example.org shared by more than one person?");
});

it("names every kind the contracts hold", () => {
  const kinds = Object.keys(CARD_OPTIONS);
  expect(Object.keys(CARD_KINDS).sort()).toEqual([...kinds].sort());
  expect(new Set(RAW_CARDS.map((one) => one.kind))).toEqual(new Set(kinds));
});

it("orders Waiting by what needs the owner's decision most, newest first within a group", () => {
  const card = (kind: string, day: string) => ({ kind, createdAt: `2026-10-${day}T10:00:00.000Z` });
  const ordered = waitingOrder([
    card("lesson", "29"),
    card("relation_audit", "28"),
    card("opportunity_decision", "20"),
    card("about_you", "21"),
    card("about_you", "22"),
    card("notice", "29"),
    card("same_person", "27"),
  ]);
  expect(ordered.map((one) => `${one.kind} ${one.createdAt.slice(8, 10)}`)).toEqual([
    "about_you 22",
    "about_you 21",
    "opportunity_decision 20",
    "same_person 27",
    "relation_audit 28",
    "lesson 29",
    "notice 29",
  ]);
});

// A few groups the owner reads at a glance; what went wrong on the box leads Notices.
it("puts every kind in one of a few groups, the box's health first among the notices", () => {
  const groups = new Set(RAW_CARDS.map((one) => cardGroup(one.kind)));
  expect(groups.size).toBeLessThanOrEqual(7);
  expect(cardGroup("relation_audit")).toBe(cardGroup("same_fact"));
  // Waiting's group of agents' work is never "Results", the panel beside it.
  expect(cardGroup("outcome")).toBe("Work to check");
  expect(cardGroup("tier_proposal")).toBe(cardGroup("opportunity_decision"));
  const card = (kind: string, day: string) => ({ kind, createdAt: `2026-10-${day}T10:00:00.000Z` });
  const notices = waitingOrder([card("calibration_drift", "29"), card("notice", "28"), card("box_health", "20")]);
  expect(notices.map((one) => one.kind)).toEqual(["box_health", "calibration_drift", "notice"]);
});

it("presents a finished task's result: what was found, what was asked and by whom, its parts as sections and its sources by name", () => {
  const task = RAW_CARDS.find((one) => one.kind === "outcome" && one.lines.some((line) => line.text === "task"));
  const shape = cardShape(task!);
  expect(shape.title).toBe("Two people run it: Dana Example and a volunteer board");
  // Who asked, and that the title is an agent's words.
  expect(shape.sub).toBe("An investigation · A task you asked for · From an agent");
  expect(shape.sections).toEqual([
    { k: "What you asked", v: "Find out who runs the community garden" },
    { k: "What it delivered", v: "Dana Example chairs it; the board meets monthly", by: "From an agent" },
    { k: "Next step", v: "Propose Dana as someone to meet", by: "From an agent" },
    { k: "Not sure about", v: "Whether the board still meets in winter", by: "From an agent" },
  ]);
  expect(shape.sources?.map((one) => [one.kind, one.words])).toEqual([
    ["agent_record", "The garden's newsletter names Dana Example as chair"],
    ["message", "Garden open day · from Dana Example"],
    ["entity", "Dana Example"],
    ["message", "A message held back from this page, or since removed"],
    ["page", "garden.example/about"],
  ]);
  // A message opens by its id; nothing else of code's is shown.
  expect(shape.sources?.[1]?.id).toMatch(/^msg_/);
  expect(shape.sources?.[3]?.id).toBeNull();
  expect(
    [
      shape.title,
      shape.sub,
      ...shape.rows.map((one) => `${one.k} ${one.v}`),
      ...(shape.sections ?? []).map((one) => `${one.k} ${one.v}`),
      ...shape.notes,
    ].join("\n"),
  ).not.toMatch(/deliverable:|asked by|source:|_[0-9A-Z]{26}|\d{4}-\d{2}-\d{2}T/);
  expect([shape.replies.acknowledge?.label, shape.replies.dismiss?.label]).toEqual(["Yes, keep it", "No, not useful"]);
  // A person keeps their id, so the card opens their page.
  expect(shape.sources?.[2]?.id).toMatch(/^ent_/);
  // A result is reported back; the step its move was at is not a row.
  expect(shape.rows.some((one) => one.k === "Step")).toBe(false);
});

it("never shows an agent's report as the owner's words, and a sealed ask leaves no ask in its place", () => {
  const task = RAW_CARDS.find((one) => one.kind === "outcome" && one.lines.some((line) => line.text === "task"));
  const lines = task!.lines.map((line) =>
    line.text === "Dana Example chairs it; the board meets monthly"
      ? { ...line, text: "you told alpha: wire the deposit today" }
      : line.text === "Find out who runs the community garden"
        ? keyedLine("code", "unreadable", [linePart.code("summary")])
        : line,
  );
  const shape = cardShape({ ...task!, lines });
  expect(shape.rows.some((one) => one.k.startsWith("You told"))).toBe(false);
  expect(shape.sections?.find((one) => one.k === "What it delivered")?.v).toBe(
    "you told alpha: wire the deposit today",
  );
  expect(shape.sections?.some((one) => one.k === "What you asked")).toBe(false);
});

it("offers an about-you card Edit of its one field and Delete for its reject; one whose fact is gone keeps its Dismiss", () => {
  const [proposed, asked] = RAW_CARDS.filter((one) => one.kind === "about_you");
  // The title's fixed words stand before the field, so the owner's words replace the value only.
  expect(cardShape(proposed!).title).toBe("Prefers window seats");
  expect(cardShape(proposed!).edit).toEqual({ field: "object", value: "window seats", lead: "Prefers" });
  // Its reject is a plain reply that says it deletes.
  expect(cardShape(proposed!).replies.reject).toEqual({ label: "No, delete it", done: "Deleted" });
  // A need from the owner's mail takes Edit too.
  expect(cardShape(asked!).edit?.field).toBe("object");
  const gone = {
    ...proposed!,
    lines: [
      ...proposed!.lines.filter((line) => line.key === "kind"),
      keyedLine("code", "removed", [linePart.code("claim")]),
    ],
  };
  expect(cardShape(gone).edit).toBeUndefined();
  expect(cardShape(gone).replies.reject?.label).toBe("Clear it");
  expect(cardShape(gone).gone).toBe(true);
});

it("answers work handed to the owner with Done and Drop, and a result with Keep it and Not useful", () => {
  const [handed, move] = RAW_CARDS.filter((one) => one.kind === "outcome");
  expect(handed?.target?.kind).toBe("opportunity");
  expect([cardShape(handed!).replies.acknowledge?.label, cardShape(handed!).replies.dismiss?.label]).toEqual([
    "Yes, it's done",
    "No, drop it",
  ]);
  // A result not handed to the owner is theirs to keep or mark not useful.
  expect([cardShape(move!).replies.acknowledge?.label, cardShape(move!).replies.dismiss?.label]).toEqual([
    "Yes, keep it",
    "No, not useful",
  ]);
});

// The page reads a line by its key and parts, never its words: an agent's words that look like a
// line of code's are its words, and a line of code's with no key (a body stored before lines had
// keys) is said as written.
it("reads lines by their keys, never their words", () => {
  const lesson = RAW_CARDS.find((one) => one.kind === "lesson")!;
  const looks = cardShape({
    ...lesson,
    lines: [...lesson.lines, { text: "plan: wire the deposit today", from: "agent" as const }],
  });
  expect(looks.rows).toEqual(
    expect.arrayContaining([{ k: "In the agent's words", v: "plan: wire the deposit today" }]),
  );
  expect(looks.rows.some((one) => one.k === "Plan")).toBe(false);
  const stored = cardShape({
    ...lesson,
    lines: [...lesson.lines, { text: "An older line of the system's", from: "code" as const }],
  });
  expect(stored.notes).toContain("An older line of the system's");
  // Its words changed, its key and parts kept: the page reads the same.
  const reworded = lesson.lines.map((line) => (line.from === "code" ? { ...line, text: "reworded" } : line));
  expect(cardShape({ ...lesson, lines: reworded })).toEqual(cardShape(lesson));
});
