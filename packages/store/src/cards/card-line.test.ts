import { describe, expect, it } from "vitest";
import { codeLine, part, rulingLostParts, saidLine } from "./card-line.ts";

// A code line carries what it says as its key and parts, its words rendered from them, and what it
// names by id as refs, so a page never reads either from its words. Made-up values only.

const PERSON = "ent_01HZZZZZZZZZZZZZZZZZZZZZZA";
const MESSAGE = "msg_01HZZZZZZZZZZZZZZZZZZZZZZE";
const FACT = "a".repeat(64);

describe("codeLine", () => {
  it("renders its words from its key and parts, and keeps them beside them", () => {
    expect(codeLine("cited", [part.id("message", MESSAGE)], [{ kind: "message", id: MESSAGE }])).toEqual({
      text: `cited: message ${MESSAGE}`,
      from: "code",
      refs: [{ kind: "message", id: MESSAGE }],
      key: "cited",
      value: [{ kind: "id", of: "message", id: MESSAGE }],
    });
    expect(codeLine("handed")).toEqual({
      text: "no registered agent can carry this out before the send item is built; go means you will do it yourself",
      from: "code",
      key: "handed",
    });
  });

  it("keeps well-formed refs of a person, a message, a goal or a fact, once each", () => {
    expect(
      codeLine(
        "person",
        [part.count(1), part.id("entity", PERSON)],
        [
          { kind: "entity", id: PERSON },
          { kind: "message", id: MESSAGE },
          { kind: "entity", id: PERSON },
          { kind: "fact", id: FACT },
        ],
      ).refs,
    ).toEqual([
      { kind: "entity", id: PERSON },
      { kind: "message", id: MESSAGE },
      { kind: "fact", id: FACT },
    ]);
  });

  it("drops other kinds, ids malformed for their kind and nulls, and leaves refs out when none is left", () => {
    const line = codeLine(
      "task",
      [],
      [
        { kind: "event", id: "evt_01HZZZZZZZZZZZZZZZZZZZZZZA" },
        { kind: "claim", id: FACT },
        { kind: "entity", id: MESSAGE },
        { kind: "goal", id: null },
      ],
    );
    expect(line).toEqual({ text: "task", from: "code", key: "task" });
  });
});

describe("the terminal's words", () => {
  // Each as the terminal has always shown it.
  it.each([
    [codeLine("work", [part.code("opportunity"), part.code("research")]), "opportunity: research"],
    [codeLine("asked_by", [part.code("agent"), part.text("scout")]), "asked by: agent scout"],
    [codeLine("heading", [part.code("why now")]), "why now:"],
    [codeLine("unreadable", [part.code("summary")]), "summary_unreadable"],
    [codeLine("removed", [part.code("claim")]), "claim_removed"],
    [codeLine("gone", [part.code("from")]), "from: gone"],
    [codeLine("first", []), "first: none"],
    [codeLine("claim", [part.id("fact", FACT), part.code("role")]), `claim: ${FACT} role`],
    [codeLine("subject", [part.code("person"), part.id("entity", PERSON)]), `subject: person ${PERSON}`],
    [codeLine("subject", [part.id("entity", PERSON)]), `subject: ${PERSON}`],
    [
      codeLine("known_by", [part.count(2), part.count(1), part.count(0), part.count(3), part.count(4)]),
      "person 2 known by: contacts 1, mail sent 0, mail received 3, meetings 4",
    ],
    [
      codeLine("identifier", [part.code("name"), part.text("Dana Example")]),
      "name: Dana Example (held under: nothing)",
    ],
    [codeLine("point", [part.code("extract_triage"), part.count(3)]), "point: extract_triage@3"],
    [codeLine("goal_effect", [part.code("pause")]), "accept pauses your goal"],
    [saidLine("agent", "field", [part.code("title"), part.text("Chair")]), "title: Chair"],
    [saidLine("agent", "you_told", [part.text("alpha"), part.text("I run")]), "you told alpha: I run"],
    [saidLine("agent", "to_you", [part.text("friend"), part.text("close")]), "to you: friend, closeness close"],
  ])("%#", (line, text) => {
    expect(line.text).toBe(text);
  });

  it("lists a lost ruling's candidates, or says none was found, and counts the rest", () => {
    const ruling = `rul_${"0".repeat(26)}`;
    expect(codeLine("ruling_lost", rulingLostParts(ruling, "veto", 4, [FACT], 2)).text).toBe(
      `ruling ${ruling} (veto) lost its claim at generation 4; candidates: ${FACT}; more candidates: 2; which claim does it apply to? Rule again on that claim with the ruling's own command, then acknowledge`,
    );
    expect(codeLine("ruling_lost", rulingLostParts(ruling, "join", 1, [], 0)).text).toContain(
      "candidates: none found, the facts it named were made again under other keys; which claim",
    );
  });
});
