import { CardsWithLines, neutralWords, ShownWork, UntrustedString } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { AS_WRITTEN, inOwnerWords, type Named, type NamesOf, PROSE, PROSE_LISTS } from "./web-names.ts";

// Names, not ids: ids an agent wrote into text are put in the owner's words, one batch a read, only
// where the text is text.

const PERSON = "ent_01HZZZZZZZZZZZZZZZZZZZZZZA";
const HIDDEN = "ent_01HZZZZZZZZZZZZZZZZZZZZZZB";
const RECORD = "rec_01HZZZZZZZZZZZZZZZZZZZZZZC";
const WORK = "opp_01HZZZZZZZZZZZZZZZZZZZZZZD";
const MESSAGE = "msg_01HZZZZZZZZZZZZZZZZZZZZZZE";
const FACT = "a".repeat(64);
const CARD = "crd_01HZZZZZZZZZZZZZZZZZZZZZZF";

const NAMED: Record<string, Named> = {
  [PERSON]: { words: "Ada Example", open: { kind: "person", id: PERSON } },
  [RECORD]: { words: 'the finding "Ada leads research"', open: null },
  [WORK]: { words: "Find who leads research at Example Org", open: null },
  [MESSAGE]: { words: "Lunch next week", open: { kind: "message", id: MESSAGE } },
  [FACT]: { words: "Head of research at Example Org", open: { kind: "fact", id: FACT } },
};
function names(): { calls: string[][]; namesOf: NamesOf } {
  const calls: string[][] = [];
  return {
    calls,
    namesOf: async (tokens) => {
      calls.push([...tokens]);
      return new Map(tokens.map((token) => [token, NAMED[token] ?? { words: neutralWords(token), open: null }]));
    },
  };
}

const card = (lines: { text: string; from: string; refs?: unknown[]; key?: string; value?: unknown[] }[]) => ({
  id: CARD,
  kind: "outcome",
  state: "pending",
  author: "system:outcomes",
  createdAt: "2026-10-30T10:00:00.000Z",
  expiresAt: null,
  options: ["keep", "dismiss"],
  target: { kind: "opportunity", id: WORK },
  refs: [{ kind: "entity", id: PERSON }],
  lines,
});

describe("R-ids in agent text become the owner's words", () => {
  // A line is known by the contract's own fields, so a field added there leaves its words named.
  it("names the words of a line holding every field the contract gives one", async () => {
    const { namesOf } = names();
    const line = {
      text: `Ask ${PERSON}`,
      from: "agent",
      key: "says_you_said",
      value: [{ kind: "text", text: `Ask ${PERSON}` }],
    };
    const out = await inOwnerWords({ cards: [card([line])], next: null }, namesOf);
    expect(out.cards[0]?.lines[0]).toMatchObject({ text: "Ask Ada Example", value: [{ text: "Ask Ada Example" }] });
  });

  it("names every id of a card's agent lines in one batch, keeps code's lines and the fields that are ids, and lists what opens", async () => {
    const { calls, namesOf } = names();
    const read = {
      cards: [
        card([
          { text: `source: entity ${PERSON}`, from: "code", refs: [{ kind: "entity", id: PERSON }] },
          { text: "found:", from: "code" },
          { text: `${PERSON} leads research; see ${RECORD} and ${MESSAGE}. ${HIDDEN} too.`, from: "agent" },
          { text: `Next: ask about ${FACT} under ${WORK}`, from: "agent" },
        ]),
      ],
      next: null,
    };
    const out = await inOwnerWords(read, namesOf);
    expect(calls).toHaveLength(1);
    expect(new Set(calls[0])).toEqual(new Set([PERSON, RECORD, MESSAGE, HIDDEN, FACT, WORK]));
    const [shown] = out.cards;
    expect(shown?.lines.map((line) => line.text)).toEqual([
      `source: entity ${PERSON}`,
      "found:",
      'Ada Example leads research; see the finding "Ada leads research" and Lunch next week. someone too.',
      "Next: ask about Head of research at Example Org under Find who leads research at Example Org",
    ]);
    // Fields that are ids stay ids: the page opens by them.
    expect(shown?.target).toEqual({ kind: "opportunity", id: WORK });
    expect(shown?.refs).toEqual([{ kind: "entity", id: PERSON }]);
    expect(shown?.lines[0]?.refs).toEqual([{ kind: "entity", id: PERSON }]);
    expect((shown as { mentions?: unknown }).mentions).toEqual([
      { words: "Ada Example", open: { kind: "person", id: PERSON } },
      { words: "Lunch next week", open: { kind: "message", id: MESSAGE } },
      { words: "Head of research at Example Org", open: { kind: "fact", id: FACT } },
    ]);
    expect(CardsWithLines.safeParse(out).success).toBe(true);
  });

  it("names the ids in a keyed line's words and in its parts' words alike, never in a code line's parts", async () => {
    const { namesOf } = names();
    const field = {
      text: `organization: ${PERSON}`,
      from: "agent",
      key: "field",
      value: [
        { kind: "code", code: "organization" },
        { kind: "text", text: PERSON },
      ],
    };
    const subject = {
      text: `subject: person ${PERSON}`,
      from: "code",
      refs: [{ kind: "entity", id: PERSON }],
      key: "subject",
      value: [
        { kind: "code", code: "person" },
        { kind: "id", of: "entity", id: PERSON },
      ],
    };
    const out = await inOwnerWords({ cards: [card([subject, field])], next: null }, namesOf);
    const [code, named] = out.cards[0]?.lines ?? [];
    expect(code).toEqual(subject);
    expect(named).toEqual({
      ...field,
      text: "organization: Ada Example",
      value: [field.value[0], { kind: "text", text: "Ada Example" }],
    });
    expect(CardsWithLines.safeParse(out).success).toBe(true);
  });

  it("an id the owner cannot see and one with no name read the same neutral words, with nothing to open", async () => {
    const { namesOf } = names();
    const out = await inOwnerWords(
      { cards: [card([{ text: `Met ${HIDDEN} at lunch`, from: "agent" }])], next: null },
      namesOf,
    );
    expect(out.cards[0]?.lines[0]?.text).toBe("Met someone at lunch");
    expect((out.cards[0] as { mentions?: unknown }).mentions).toBeUndefined();
  });

  it("names ids inside { untrusted } and a work sheet's report words, never a cursor or a code", async () => {
    const { namesOf } = names();
    const read = {
      summary: { untrusted: `About ${PERSON}` },
      next: `cursor_${PERSON}`,
      reports: [
        {
          at: "2026-10-30T10:00:00.000Z",
          summary: `Found ${RECORD}`,
          report: {
            deliverable: `${PERSON} leads it`,
            next: `Ask ${PERSON}`,
            sources: [{ kind: "entity", id: PERSON }, `page about ${WORK}`],
          },
        },
      ],
    };
    const out = await inOwnerWords(read, namesOf);
    expect(out.summary.untrusted).toBe("About Ada Example");
    expect(out.next).toBe(`cursor_${PERSON}`);
    expect(out.reports[0]?.summary).toBe('Found the finding "Ada leads research"');
    expect(out.reports[0]?.report.deliverable).toBe("Ada Example leads it");
    expect(out.reports[0]?.report.next).toBe("Ask Ada Example");
    expect(out.reports[0]?.report.sources).toEqual([
      { kind: "entity", id: PERSON },
      "page about Find who leads research at Example Org",
    ]);
  });

  it("serves a message and a draft as they are written, and names a lesson's text", async () => {
    expect([...AS_WRITTEN].sort()).toEqual(["draft", "message"]);
    const { namesOf } = names();
    const out = await inOwnerWords({ lessons: [{ text: { untrusted: `Ask ${PERSON} first` } }] }, namesOf);
    expect(out.lessons[0]?.text.untrusted).toBe("Ask Ada Example first");
  });

  it("starts a line with neutral words in a capital, and a name as its source wrote it", async () => {
    const out = await inOwnerWords(
      { untrusted: `${HIDDEN} wrote.\n${PERSON} answered` },
      async (tokens) =>
        new Map(
          tokens.map((token) => [
            token,
            token === PERSON ? { words: "de Vries", open: null } : { words: neutralWords(token), open: null },
          ]),
        ),
    );
    expect(out.untrusted).toBe("Someone wrote.\nde Vries answered");
  });

  it("asks nothing for an answer that holds no id", async () => {
    const { calls, namesOf } = names();
    const read = { cards: [card([{ text: "Nothing named here", from: "agent" }])], next: null };
    expect(await inOwnerWords(read, namesOf)).toEqual(read);
    expect(calls).toHaveLength(0);
  });

  it("a move's work sheet still parses after its words are named", async () => {
    const { namesOf } = names();
    const move = {
      kind: "move",
      id: "mov_01HZZZZZZZZZZZZZZZZZZZZZZG",
      opportunity: WORK,
      stage: "investigate",
      by: "client:scout",
      at: "2026-10-30T10:00:00.000Z",
      intent: "research",
      events: [],
      reports: [
        { at: "2026-10-30T10:00:00.000Z", summary: `Found ${PERSON}`, report: { deliverable: `${PERSON} at ${FACT}` } },
      ],
    };
    const out = await inOwnerWords(move, namesOf);
    expect(ShownWork.safeParse(out).success).toBe(true);
    expect(out.reports[0]?.report.deliverable).toBe("Ada Example at Head of research at Example Org");
  });
});

// Every string a person wrote or a model wrote in agent work, by the contract: an UntrustedString
// field of ShownWork, at any depth, either is a field the names pass reads, or a heading it leaves.
describe("the fields of ShownWork the names pass reads", () => {
  // Who a thing came from, and a message's subject: a source's own words, never an id to name.
  const LEFT_AS_WRITTEN = new Set(["subject", "from", "name", "address"]);

  const untrustedFields = (schema: unknown, into: Set<string>, key?: string): void => {
    const def = (schema as { def?: Record<string, unknown> }).def;
    if (schema === UntrustedString && key !== undefined) into.add(key);
    if (def === undefined) return;
    for (const inner of [def.innerType, def.element, def.in, def.out]) if (inner) untrustedFields(inner, into, key);
    for (const option of (def.options as unknown[] | undefined) ?? []) untrustedFields(option, into, key);
    const shape = (schema as { shape?: Record<string, unknown> }).shape;
    if (shape !== undefined) for (const [name, field] of Object.entries(shape)) untrustedFields(field, into, name);
  };

  it("names every untrusted prose field, or says why it does not", () => {
    const found = new Set<string>();
    untrustedFields(ShownWork, found);
    expect(found.size).toBeGreaterThan(0);
    expect([...found].filter((key) => !PROSE.has(key) && !PROSE_LISTS.has(key) && !LEFT_AS_WRITTEN.has(key))).toEqual(
      [],
    );
  });
});
