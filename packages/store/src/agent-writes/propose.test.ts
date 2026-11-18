import type { StoredAboutYouKind } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { parseAnswerArgs } from "../cards/answer.ts";
import { intakeRefusal, parseProposeArgs } from "./propose.ts";

// The proposal's own checks before any statement. The kind's key phrase is the field the quote holds.
// The claim intake at write time, its refusal a fixed code.

// The intake on a kind and its fields is the guard a client-scoped preference passes at write,
// and the pipeline's on what the model typed; a statement proposal's fields are never the agent's
// to give.
const k2b = <
  T extends { kind: string; fields: Record<string, unknown>; quote?: string | undefined; [key: string]: unknown },
>(
  args: T,
): T | { refusal: string } => {
  const refusal = intakeRefusal(args.kind as StoredAboutYouKind, args.fields, args.quote);
  return refusal === null ? args : { refusal };
};

const BASE = {
  kind: "preference",
  fields: { domain: "career", object: "morning meetings", polarity: "avoids" },
  scope: "all",
  requestId: "propose-unit-000001",
};

describe("parseProposeArgs", () => {
  it("a key phrase uses the quote's words in the quote's order, case, spacing and plurals folded; a word the quote lacks, or a reordering, is not_in_quote", () => {
    expect(k2b({ ...BASE, quote: "I like evening calls." })).toEqual({ refusal: "not_in_quote" });
    expect(k2b({ ...BASE, quote: "I hate  Morning\nMeetings." })).toMatchObject({ kind: "preference" });
    expect(k2b({ ...BASE, quote: "Meetings in the morning are the worst." })).toEqual({ refusal: "not_in_quote" });
    expect(
      k2b({
        ...BASE,
        fields: { domain: "career", object: "don’t book Fridays", polarity: "prefers" },
        quote: "Please don't book Fridays.",
      }),
    ).toMatchObject({ kind: "preference" });
    // Without a quote there is nothing to match.
    expect(k2b(BASE)).toMatchObject({ kind: "preference" });
  });

  it("each kind's own key phrase is the one matched against the quote", () => {
    const quote = "I want to learn to sail, I need a quiet desk, and I cannot fly before May.";
    for (const [kind, fields] of [
      ["goal", { domain: "interests", objective: "learn to sail" }],
      ["need", { domain: "home", object: "a quiet desk" }],
      ["constraint", { domain: "travel", rule: "cannot fly before May" }],
    ] as const) {
      expect(k2b({ kind, fields, scope: "all", quote, requestId: "propose-unit-000003" }), kind).toMatchObject({
        kind,
      });
      const wrong = Object.fromEntries(
        Object.entries(fields).map(([name, value]) => [name, name === "domain" ? value : `${value} in Lisbon`]),
      );
      expect(k2b({ kind, fields: wrong, scope: "all", quote, requestId: "propose-unit-000003" }), kind).toEqual({
        refusal: "not_in_quote",
      });
    }
  });

  it("the owner's failing phrases are refused with their codes", () => {
    const goal = (objective: string, quote: string) =>
      k2b({
        kind: "goal",
        fields: { domain: "career", objective },
        scope: "all",
        quote,
        requestId: "propose-unit-000004",
      });
    expect(goal("reach out to them instead of apply", "I'd reach out to them instead of apply.")).toEqual({
      refusal: "not_standalone",
    });
    expect(
      k2b({
        kind: "situation",
        fields: { domain: "travel", state: "I've been to seattle new york new orleans, sf, and la" },
        scope: "all",
        requestId: "propose-unit-000005",
      }),
    ).toEqual({ refusal: "multi_fact" });
    expect(
      k2b({
        kind: "preference",
        fields: { domain: "career", object: "no em dashes", polarity: "avoids" },
        scope: "all",
        requestId: "propose-unit-000006",
      }),
    ).toEqual({ refusal: "negated_object" });
    expect(
      goal("reach out to founders directly", "I'd rather reach out to the founders directly than apply."),
    ).toMatchObject({ kind: "goal" });
  });

  it("a role and an affiliation take their typed fields, word-grounded, with no domain", () => {
    const quote = "I interned at Alder Labs as a research and ops intern, and left in May.";
    expect(
      parseProposeArgs({
        kind: "role",
        fields: { title: "research and ops intern", organization_name: "Alder Labs" },
        scope: "all",
        quote,
        requestId: "propose-unit-000007",
      }),
    ).toMatchObject({ kind: "role" });
    expect(
      parseProposeArgs({
        kind: "affiliation",
        fields: { relation: "employee", organization_name: "Alder Labs" },
        scope: "all",
        quote,
        requestId: "propose-unit-000008",
      }),
    ).toMatchObject({ kind: "affiliation" });
    expect(
      k2b({
        kind: "role",
        fields: { title: "intern", organization_name: "Birch Labs" },
        scope: "all",
        quote,
        requestId: "propose-unit-000009",
      }),
    ).toEqual({ refusal: "not_in_quote" });
    expect(
      parseProposeArgs({
        kind: "role",
        fields: { title: "intern", organization_name: "Alder Labs", domain: "career" },
        scope: "all",
        quote,
        requestId: "propose-unit-000010",
      }),
    ).toBeNull();
    expect(
      parseProposeArgs({
        kind: "affiliation",
        fields: { relation: "employee" },
        scope: "all",
        quote,
        requestId: "propose-unit-000011",
      }),
    ).toBeNull();
  });

  it("this_client with any kind but preference is refused", () => {
    expect(
      parseProposeArgs({
        kind: "need",
        fields: { domain: "career", object: "a new laptop" },
        scope: "this_client",
        requestId: "propose-unit-000002",
      }),
    ).toBeNull();
    expect(parseProposeArgs({ ...BASE, scope: "this_client" })).toMatchObject({ kind: "preference" });
  });

  it("echoes-and-proposals, invariant 5: a subject, a label, a channel, a tier or any other argument is refused, and so is a legacy what", () => {
    expect(parseProposeArgs({ ...BASE, subject: "ent_x" })).toBeNull();
    expect(parseProposeArgs({ ...BASE, compartments: ["own"] })).toBeNull();
    expect(parseProposeArgs({ ...BASE, tier: "owner" })).toBeNull();
    expect(parseProposeArgs({ ...BASE, channel: "alpha" })).toBeNull();
    expect(parseProposeArgs({ ...BASE, fields: { what: "morning meetings", polarity: "avoids" } })).toBeNull();
    expect(parseProposeArgs({ ...BASE, refusal: "not_standalone" })).toBeNull();
  });
});

describe("parseAnswerArgs", () => {
  const ARGS = {
    opportunity: "opp_01JABCDEFGHJKMNPQRSTVWXYZ0",
    answer: {
      quote: "I want to visit the lab in April.",
      facts: [{ kind: "goal", fields: { domain: "career", objective: "visit the lab in April" } }],
    },
    requestId: "answer-unit-000001",
  };
  // The agent's facts still parse but are dropped; the owner's words and their
  // effect alone are kept, and the agent lane's model types them.
  it("keeps the owner's quote and its effect, and drops any facts the agent sent, whatever their shape", () => {
    expect(parseAnswerArgs({ ...ARGS, answer: { ...ARGS.answer, about: "supports" } })).toEqual({
      opportunity: ARGS.opportunity,
      answer: { quote: ARGS.answer.quote, about: "supports" },
      requestId: ARGS.requestId,
    });
    expect(
      parseAnswerArgs({
        ...ARGS,
        answer: { ...ARGS.answer, facts: [{ kind: "goal", fields: { domain: "career", objective: "move to Leeds" } }] },
      }),
    ).toEqual({
      opportunity: ARGS.opportunity,
      answer: { quote: ARGS.answer.quote },
      requestId: ARGS.requestId,
    });
    expect(
      parseAnswerArgs({ ...ARGS, answer: { ...ARGS.answer, facts: [{ ...ARGS.answer.facts[0], tier: "owner" }] } }),
    ).toEqual({ opportunity: ARGS.opportunity, answer: { quote: ARGS.answer.quote }, requestId: ARGS.requestId });
    expect(parseAnswerArgs({ ...ARGS, answer: { ...ARGS.answer, tier: "owner" } })).toBeNull();
  });
});

// An interpretation in the agent's own words, beside the owner's quotes.
describe("parseProposeArgs: interpretations", () => {
  const interpretation = (kind: string, fields: Record<string, unknown>, statement: string, quotes: string[]) => ({
    kind,
    fields,
    scope: "all",
    interpretation: true,
    statement,
    quotes,
    requestId: "propose-unit-000168",
  });
  // Six career statements in the style another assistant wrote them: goals,
  // preferences and a situation, several sentences each, in its own words, each with one or two
  // verbatim quotes. Synthetic: no real person's words.
  const SIX = [
    interpretation(
      "goal",
      { domain: "career", objective: "found a company within two years" },
      "You want to found a company of your own within about two years. You see a job at a large firm as a detour, not a destination, and you would trade salary for ownership.",
      [
        "I'd rather own a small piece of something I built than a big salary somewhere else",
        "two years, tops, before I start my own thing",
      ],
    ),
    interpretation(
      "goal",
      { domain: "career", objective: "become an expert in pricing" },
      "You are aiming to become the person others ask about pricing. You read about it every week and want a role where pricing decisions are yours.",
      ["I keep coming back to pricing, it's the lever nobody pulls"],
    ),
    interpretation(
      "preference",
      { domain: "career", object: "small teams", polarity: "prefers" },
      "You do your best work in teams of five to ten people, where everyone ships. Large meetings drain you, and you say so openly.",
      ["give me eight people who ship over eighty who meet"],
    ),
    interpretation(
      "preference",
      { domain: "career", object: "client services work", polarity: "avoids" },
      "You steer away from client services work. You find billing by the hour at odds with how you want to spend your time, and you have turned down two such offers.",
      ["I'm not doing hourly client work again", "billing hours felt like renting myself out"],
    ),
    interpretation(
      "preference",
      { domain: "career", object: "mentors with operating experience", polarity: "prefers" },
      "When you pick mentors you look for people who have run something, not advisors who only advise. Credentials matter less to you than a record of building.",
      ["I want advice from people who've actually run a business"],
    ),
    interpretation(
      "situation",
      { domain: "career", state: "working part time at a startup while studying" },
      "You currently split your week between a startup role and your studies. The arrangement is deliberate: it keeps your options open while you decide where to commit.",
      ["right now it's half the week at the startup and half on classes"],
    ),
  ];

  it("the six-statement style passes as interpretations", () => {
    for (const [n, one] of SIX.entries())
      expect(parseProposeArgs(one), String(n)).toMatchObject({ kind: one.kind, interpretation: true });
  });

  it("the same statements were refused before, as quoted phrases or unquoted first-person text", () => {
    const first = SIX[5];
    if (first === undefined) throw new Error("no statement");
    expect(
      k2b({
        kind: first.kind,
        fields: first.fields,
        scope: "all",
        quote: first.quotes[0],
        requestId: "propose-unit-000168",
      }),
    ).toEqual({ refusal: "not_in_quote" });
  });

  it("an interpretation with an empty list of quotes is refused; with none it is a statement proposal", () => {
    const first = SIX[5];
    if (first === undefined) throw new Error("no statement");
    expect(parseProposeArgs({ ...first, quotes: [] })).toBeNull();
    expect(parseProposeArgs({ ...first, quotes: undefined })).toMatchObject({ statement: first.statement });
    expect(parseProposeArgs({ ...first, interpretation: undefined, quotes: undefined })).toMatchObject({
      statement: first.statement,
    });
  });

  it("a quote that is the agent's statement, or holds it whole, is not the owner's words", () => {
    const first = SIX[5];
    if (first === undefined) throw new Error("no statement");
    expect(parseProposeArgs({ ...first, quotes: [first.statement] })).toEqual({ refusal: "not_owner_words" });
    expect(parseProposeArgs({ ...first, quotes: [`As I said: ${first.statement}`] })).toEqual({
      refusal: "not_owner_words",
    });
    expect(parseProposeArgs({ ...first, quotes: [first.quotes[0] ?? "", first.statement.toUpperCase()] })).toEqual({
      refusal: "not_owner_words",
    });
    // A statement may hold a quote of the owner's.
    expect(
      parseProposeArgs({ ...first, statement: `You said "${first.quotes[0] ?? ""}", and you mean it.` }),
    ).toMatchObject({ interpretation: true });
  });

  it("the statement's stand-alone rules: no relative time word without a date, no opening pointer", () => {
    const first = SIX[5];
    if (first === undefined) throw new Error("no statement");
    expect(parseProposeArgs({ ...first, statement: "You want to start a company soon." })).toEqual({
      refusal: "not_standalone",
    });
    expect(
      parseProposeArgs({
        ...first,
        fields: { ...first.fields, until: "2028-10-01" },
        statement: "You want to start a company soon.",
      }),
    ).toMatchObject({ interpretation: true });
    expect(parseProposeArgs({ ...first, statement: "This is what you want most." })).toEqual({
      refusal: "not_standalone",
    });
    // First-person and second-person words are the agent's to use.
    expect(
      parseProposeArgs({ ...first, statement: "I think you want your own company; we discussed it at length." }),
    ).toMatchObject({ interpretation: true });
  });

  it("the key fields' guard still refuses: one fact, a negated preference, a pointer in the phrase (the pipeline's guard, never intake's)", () => {
    const [, , third] = SIX;
    if (third === undefined) throw new Error("no statement");
    expect(
      k2b({
        ...third,
        fields: { domain: "career", object: "small teams, remote work, flexible hours", polarity: "prefers" },
      }),
    ).toEqual({ refusal: "multi_fact" });
    expect(
      parseProposeArgs({
        ...third,
        fields: { domain: "career", object: "small teams, remote work, flexible hours", polarity: "prefers" },
      }),
    ).toMatchObject({ statement: third.statement });
    expect(k2b({ ...third, fields: { domain: "career", object: "not large teams", polarity: "avoids" } })).toEqual({
      refusal: "negated_object",
    });
    expect(k2b({ ...third, fields: { domain: "career", object: "them", polarity: "prefers" } })).toEqual({
      refusal: "not_standalone",
    });
  });
});
