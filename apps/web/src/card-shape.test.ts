import {
  type CardLine,
  type CardLineKey,
  type CardLinePart,
  keyedLine,
  linePart,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { SEALED } from "./card-lines.ts";
import { cardShape } from "./cards.ts";
import { RAW_CARDS } from "./test-support/raw-cards.ts";
import { whenWords } from "./time-words.ts";
import { capital } from "./words.ts";

// How cardShape reads each line key the raw cards do not carry: one card, its own lines replaced.
const AT = "2026-10-20T10:00:00.000Z";
const { text, code, time, id } = linePart;
const shapeOf = (kind: string, lines: CardLine[]) => {
  const base = RAW_CARDS.find((one) => one.kind === kind)!;
  return cardShape({ ...base, lines });
};
const ofCode = (key: CardLineKey, ...value: CardLinePart[]): CardLine => keyedLine("code", key, value);
const ofAgent = (key: CardLineKey, ...value: CardLinePart[]): CardLine => keyedLine("agent", key, value);

describe("a time card whose time has gone", () => {
  it("says so rather than asking about nothing, and a notice says what became of the yes", () => {
    const blank = shapeOf("time_effort", [
      ofCode("time_effort", code("40"), code("1")),
      { text: "", from: "source" },
      ofCode("time_effort_note"),
    ]);
    expect(blank.title).toBe("This time is gone");
    const told = shapeOf("notice", [ofCode("kind", code("notice")), ofCode("time_yes_lost")]);
    expect(told.title).toMatch(/your yes on a time card made no project/i);
    expect(told.title).toMatch(/asked again/);
  });
});

describe("a line an agent or a source wrote under a key", () => {
  it("names a person to add as its title, and who knows them as a row", () => {
    const shape = shapeOf("reminder", [ofAgent("add_person", text("Ann Example"), text("Bo Example"))]);
    expect(shape.title).toBe("Add Ann Example to the people you know");
    expect(shape.rows).toEqual([{ k: "Known through", v: "Bo Example" }]);
    expect(shapeOf("reminder", [ofAgent("add_person")]).title).toBe("Add a person to the people you know");
  });

  it("says each of its keyed words as a row under the title", () => {
    const shape = shapeOf("reminder", [
      ofAgent("statement", text("Ann chairs the garden club")),
      ofAgent("to_you", text("a friend"), text("close")),
      ofAgent("link", text("works with Bo"), code("inferred")),
      ofAgent("link", text("knows Cy")),
      ofAgent("proposal_basis", text("She said so in March")),
      ofAgent("meeting_title", text("Garden board")),
      ofAgent("calendar_title", text("Board call")),
      ofAgent("start", time(AT)),
      ofAgent("says_you_said", text("I like it")),
    ]);
    expect(shape.title).toBe("Ann chairs the garden club");
    expect(shape.rows).toEqual([
      { k: "To you", v: "a friend, closeness: close" },
      { k: "Link", v: "works with Bo (inferred, no source states it)" },
      { k: "Link", v: "knows Cy" },
      { k: "Why", v: "She said so in March" },
      { k: "Meeting", v: "Garden board" },
      { k: "Calendar title", v: "Board call" },
      { k: "When", v: capital(whenWords(AT)) },
      { k: "You said", v: "I like it" },
    ]);
  });
});

describe("a line code wrote", () => {
  it("says a sealed body, a gone fact and a goal kept apart as notes", () => {
    const shape = shapeOf("reminder", [
      ofCode("body_none"),
      ofCode("gone", code("from")),
      ofCode("compartment_proposed"),
    ]);
    expect(shape.notes).toEqual([
      SEALED,
      "The first statement has since been removed.",
      "It asks to keep this goal apart from your others.",
    ]);
  });

  it("puts the agent's reading, a link, a project and where a link was found in rows", () => {
    const shape = shapeOf("reminder", [
      ofCode("interpretation"),
      { text: "It means she leads it", from: "agent" },
      ofCode("url", text("garden.example/about")),
      ofCode("project", text("Spring fair")),
      ofCode("link_message", id("message", "msg_1"), time(AT), text("Bo Example")),
      ofCode("link_message", id("message", "msg_2"), text("no time"), text("Cy Example")),
    ]);
    expect(shape.rows).toEqual([
      { k: "The agent's reading", v: "It means she leads it" },
      { k: "Link", v: "garden.example/about" },
      { k: "Project", v: "Spring fair" },
      { k: "Found in", v: `A message from Bo Example, ${whenWords(AT)}` },
      { k: "Found in", v: "A message from Cy Example, at an unknown time" },
    ]);
  });

  it("names who a card is about by the source's words after a subject id", () => {
    const shape = shapeOf("reminder", [
      ofCode("subject", id("entity", "ent_1")),
      { text: "Ann Example", from: "source" },
    ]);
    expect(shape.sub.startsWith("About Ann Example")).toBe(true);
    expect(shapeOf("reminder", [ofCode("subject", text("Bo Example"))]).sub.startsWith("About Bo Example")).toBe(true);
  });

  it("sends a run that stopped for another reason to the terminal to see why", () => {
    const stopped = shapeOf("reminder", [ofCode("run_failed", code("timeout"))]);
    expect(stopped.notes).toEqual(["The run stopped: it ran out of time.", "See why in the terminal."]);
    expect([stopped.command, stopped.commandWhy, stopped.ack]).toEqual([
      "pia work status",
      "To see why, in the terminal:",
      null,
    ]);
    expect(shapeOf("reminder", [ofCode("run_failed", code("none"))]).notes[0]).toBe(
      "The run stopped without saying why.",
    );
  });

  it("shows what a card other than a drifted step asks to see as one command", () => {
    const shape = shapeOf("reminder", [ofCode("see_it", code("work status"))]);
    expect(shape.notes).toContain("See it in the terminal.");
    expect([shape.command, shape.commandWhy, shape.then]).toEqual([
      "pia work status",
      "To see it, in the terminal:",
      undefined,
    ]);
    // A point outside a drifted step is hidden.
    expect(shapeOf("reminder", [ofCode("point", code("opportunity_go"))]).rows).toEqual([]);
  });

  it("lets a ruling with no fact left go, and sends a join with one fact to the terminal", () => {
    const lost = (verdict: string, ...claims: string[]) =>
      ofCode(
        "ruling_lost",
        id("ruling", "rul_1"),
        code(verdict),
        linePart.count(1),
        linePart.count(0),
        ...claims.map((one) => id("fact", one)),
      );
    const none = shapeOf("ruling_carry", [lost("veto")]);
    expect(none.notes).toContain("No fact is left for it: mark this seen.");
    expect([none.command, none.resolve, none.fact]).toEqual([null, null, null]);
    const join = shapeOf("ruling_carry", [lost("join", "a".repeat(64))]);
    expect(join.resolve).toBeNull();
    expect(join.fact).toEqual({ id: "a".repeat(64), lead: "Rule again on" });
    expect(join.command).toBe("pia review --kind ruling_carry");
    expect(join.notes.join(" ")).toContain("rule on it again in the terminal");
  });
});
