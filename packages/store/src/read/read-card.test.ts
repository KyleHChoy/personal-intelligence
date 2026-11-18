import { BeliefLine, ENTITY_LINES } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { at, belief, cite, fp, OWNER, ownerSide, person } from "../test-support/card-fixtures.ts";
import { boundLine, bySection, cardLines, LINE_CODE_POINTS, linesOf } from "./read-card.ts";

// The card's lines, pure. Synthetic values only.

const ada = person(1);
const role = (n: number, title: string, day: number) =>
  belief(
    "role",
    n,
    {},
    [
      cite(
        "role",
        { title: { untrusted: title }, organization_name: { untrusted: "Example Co" } },
        { day, subject: ada },
      ),
    ],
    { subject: ada },
  );
const job = (n: number, day: number) =>
  belief(
    "affiliation",
    n,
    { relation: "employee" },
    [
      cite(
        "affiliation",
        { relation: "employee", organization_name: { untrusted: "Example Co" } },
        { day, subject: ada },
      ),
    ],
    { subject: ada },
  );
const friend = (n: number, day: number) =>
  belief(
    "relationship",
    n,
    { counterparty: OWNER, relation: "friend" },
    [cite("relationship", { counterparty: OWNER, relation: "friend" }, { day, subject: ada })],
    { subject: ada },
  );
const need = (n: number, domain: string, day: number) =>
  belief("need", n, { domain }, [cite("need", { what: { untrusted: `need ${n}` }, domain }, { day, subject: ada })], {
    subject: ada,
  });

describe("the card's lines", () => {
  it("puts the current role and affiliation and the relationship to the owner first, then each section by its newest line, unsorted last", () => {
    const beliefs = [
      need(1, "health", 1),
      need(2, "career", 5),
      need(3, "health", 9),
      role(4, "Head of Finance", 2),
      job(5, 3),
      friend(6, 4),
      belief("need", 7, {}, [cite("need", { what: { untrusted: "no domain" } }, { day: 20, subject: ada })], {
        subject: ada,
      }),
    ];
    const { lines, more } = cardLines(beliefs, false);
    expect(more).toBe(false);
    expect(lines.map((one) => one.line.fact)).toEqual([fp(4), fp(5), fp(6), fp(3), fp(1), fp(2), fp(7)]);
    expect(lines.map((one) => one.section)).toEqual([
      "career",
      "career",
      "relationships",
      "health",
      "health",
      "career",
      "unsorted",
    ]);
    expect(lines[0]?.line.line.untrusted).toBe(`Head of Finance at Example Co, since ${at(2).slice(0, 10)}`);
    for (const one of lines) expect(BeliefLine.safeParse(one.line).success).toBe(true);
  });

  it("cuts at ENTITY_LINES with the head kept, and says more; more also when the beliefs read were cut", () => {
    const beliefs = [
      ...Array.from({ length: 40 }, (_, n) => need(100 + n, "career", n)),
      role(4, "Head of Finance", 0),
      job(5, 0),
    ];
    const { lines, more } = cardLines(beliefs, false);
    expect(lines).toHaveLength(ENTITY_LINES);
    expect(more).toBe(true);
    expect(lines.slice(0, 2).map((one) => one.line.fact)).toEqual([fp(4), fp(5)]);
    expect(lines[2]?.line.fact).toBe(fp(139));
    expect(cardLines([need(1, "career", 0)], true).more).toBe(true);
  });

  it("orders a section by tier first, then the newest cite", () => {
    const low = need(1, "career", 9);
    const high = { ...need(2, "career", 1), tier: "owner" as const };
    expect(bySection(linesOf([low, high])).map((one) => one.line.fact)).toEqual([fp(2), fp(1)]);
  });

  it("collapses the beliefs of one group to the higher tier", () => {
    const group = fp(999);
    const source = { ...need(1, "career", 1), group };
    const own = { ...need(2, "career", 1), group, tier: "owner" as const };
    expect(linesOf([source, own]).map((one) => one.line.fact)).toEqual([fp(2)]);
  });

  it("renders a held cite's phrase as held, and keeps the cite it rendered from", () => {
    const heldNeed = belief("need", 1, { domain: "career" }, [cite("need", {}, { held: true })]);
    const [one] = linesOf([heldNeed]);
    expect(one?.line.line.untrusted).toBe("Need: (held)");
    expect(one?.cite).toEqual(heldNeed.cites[0]);
  });

  it("bounds a line's words at LINE_CODE_POINTS, never inside a character", () => {
    const long = ownerSide("goal", 1, "career", "😀".repeat(400));
    const [one] = linesOf([long]);
    const points = Array.from(one?.line.line.untrusted ?? "");
    expect(points).toHaveLength(LINE_CODE_POINTS);
    expect(points.every((point) => point === "😀" || "Goal: ".includes(point))).toBe(true);
    const short = linesOf([ownerSide("goal", 2, "career", "ship it")])[0]?.line;
    expect(short === undefined ? undefined : boundLine(short)).toBe(short);
  });

  // A system notice's line is cut as any other; its mark is its tier and `notice`, which no cut
  // of its words reaches.
  it("bounds a system notice's line as any other, its tier and notice kept", () => {
    const base = ownerSide("situation", 3, "travel", "x".repeat(400));
    const [one] = linesOf([
      { ...base, cites: base.cites.map((one) => ({ ...one, tier: "system_notice" })), tier: "system_notice" } as never,
    ]);
    expect(Array.from(one?.line.line.untrusted ?? "")).toHaveLength(LINE_CODE_POINTS);
    expect(one?.line.line.untrusted.endsWith("x")).toBe(true);
    expect(one?.line.tier).toBe("system_notice");
    expect(one?.line.notice).toBeDefined();
  });

  // The headers are read from the notice cite, never from a newer person's cite.
  it("keeps a notice line's notice cite beside the cite it rendered from; no other line has one", () => {
    const notice = {
      ...(cite("situation", { what: { untrusted: "in process" }, domain: "travel" }, { day: 1 }) as object),
      tier: "system_notice",
    };
    const person = {
      ...(cite("situation", { what: { untrusted: "in process" }, domain: "travel" }, { day: 2 }) as object),
      tier: "source",
    };
    const mixed = {
      ...ownerSide("situation", 4, "travel", "in process"),
      cites: [person, notice],
      tier: "system_notice",
    } as never;
    const [one] = linesOf([mixed]);
    expect(one?.cite).toBe(person);
    expect(one?.notice).toBe(notice);
    expect(one?.line.notice?.sentAt).toBe(at(1));
    expect(linesOf([ownerSide("goal", 5, "career", "ship it")])[0]?.notice).toBeUndefined();
  });
});
