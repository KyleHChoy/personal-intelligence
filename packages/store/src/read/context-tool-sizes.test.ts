import {
  CONTEXT_CODE_POINTS,
  CONTEXT_COMMITMENTS,
  CONTEXT_EVIDENCE,
  CONTEXT_GOALS,
  CONTEXT_PASSAGE,
  CONTEXT_PERSON_LINES,
  ContextView,
  compactResult,
  EntityView,
  LIFE_DOMAINS,
} from "@intelligence/contracts/personal";
import { buildSections, rankLines } from "@intelligence/personal-core/views";
import { describe, expect, it } from "vitest";
import { at, belief, cite, fp, OWNER, person } from "../test-support/card-fixtures.ts";
import {
  CARD_CODE_POINTS,
  cardLines,
  fitCard,
  HEAD_LIST,
  LINKS_FLOOR,
  linesOf,
  OWNER_WORDS_FLOOR,
} from "./read-card.ts";
import { fit } from "./read-context.ts";
import { boundNotice, SELF_LINE_CODE_POINTS } from "./read-self.ts";

// The bounds of get_entity's card and of context, on the sizing profile of context-sizes.test.ts:
// beliefs whose phrases are as long as a real store serves, each citing a fact, with the card's
// other parts full. Sizes are code points of the wire form's JSON text (compactResult), about four
// to a token. Every name, address and text is made up.

const size = (value: unknown): number => [...JSON.stringify(value)].length;
const TOKEN = 4;
const words = (n: number): string =>
  `Wants to keep Fridays clear for writing and to spend more time on hardware research, note ${n}; prefers short calls before noon.`;
const ada = person(1);
const meeting = (n: number) => ({
  id: `evt_${String(900 + n).padStart(26, "0")}`,
  title: { untrusted: `Planning call ${n}` },
  startsAt: at(n),
  endsAt: at(n + 1),
  allDay: false,
  cancelled: false,
  participants: [OWNER, person(n), person(n + 1)],
});
const KINDS = ["need", "capability", "goal", "constraint", "situation"] as const;

// Forty beliefs about one person over every life domain, its role, its employer and its tie to the
// owner: more than a card holds.
const theirs = [
  ...Array.from({ length: 40 }, (_, n) => {
    const kind = KINDS[n % KINDS.length] as (typeof KINDS)[number];
    const domain = LIFE_DOMAINS[n % LIFE_DOMAINS.length] as string;
    return belief(
      kind,
      100 + n,
      { domain },
      [cite(kind, { what: { untrusted: words(n) }, domain }, { day: n, subject: ada })],
      { subject: ada },
    );
  }),
  belief(
    "role",
    1,
    {},
    [
      cite(
        "role",
        { title: { untrusted: "Head of Hardware Research" }, organization_name: { untrusted: "Example Co" } },
        { subject: ada },
      ),
    ],
    { subject: ada },
  ),
  belief(
    "affiliation",
    2,
    { relation: "employee" },
    [cite("affiliation", { relation: "employee", organization_name: { untrusted: "Example Co" } }, { subject: ada })],
    { subject: ada },
  ),
  belief(
    "relationship",
    3,
    { counterparty: OWNER, relation: "friend" },
    [cite("relationship", { counterparty: OWNER, relation: "friend" }, { subject: ada })],
    { subject: ada },
  ),
];

const head = {
  id: ada.id,
  kind: "person",
  names: [ada.name, { untrusted: "Ada P. Example" }],
  addresses: [ada.address, { untrusted: "ada@example.com" }],
  organization: {
    id: person(50).id,
    kind: "organization",
    name: { untrusted: "Example Co" },
    address: { untrusted: "example.com" },
  },
  people: [],
  mail: { inbound: 30, outbound: 12, firstAt: at(1), lastAt: at(90) },
  lastMeeting: meeting(1),
  nextMeeting: meeting(2),
  details: [],
  shared: false,
  current: {
    role: {
      title: { untrusted: "Head of Hardware Research" },
      organization: null,
      organizationName: { untrusted: "Example Co" },
      since: at(0),
    },
    affiliation: {
      relation: "employee",
      organization: null,
      organizationName: { untrusted: "Example Co" },
      since: at(0),
    },
  },
  // A warmth line with every field at its longest.
  warmth: {
    tier: "regular",
    tierSource: "inferred",
    dormant: true,
    warmth: 12.75,
    active: 12.75,
    depth: 25.5,
    firstTwoWayAt: at(400),
    lastTwoWayAt: at(1),
    replyRate: 0.83,
    replyHours: 10.25,
    theyStart: 0.42,
    channels: ["email", "calendar", "chat"],
    stale: false,
    rebuilding: false,
  },
  knownVia: {
    firstThread: { at: at(1), message: `msg_${"1".padStart(26, "0")}` },
    meetings: { count: 4, firstAt: at(3), first: meeting(3).id },
    sharedMailDomain: null,
    coRecipients: [0, 1, 2].map((n) => ({
      who: person(10 + n),
      messages: 5,
      lastAt: at(n),
      message: `msg_${String(10 + n).padStart(26, "0")}`,
    })),
  },
};

describe("the card and context within their bounds", () => {
  it("get_entity's card is about 3 000 tokens or less: thirty lines of short phrases, fewer of long ones, the head's lines always", () => {
    const parsed = EntityView.omit({ lines: true, more: true, facts: true }).parse(head);
    const thirty = cardLines(theirs, false);
    const before = size(
      compactResult(
        "get_entity",
        EntityView.parse({ ...parsed, lines: thirty.lines.map((one) => one.line), more: true }),
      ),
    );
    const { view } = fitCard(parsed, thirty);
    const sent = size(compactResult("get_entity", EntityView.parse(view)));
    process.stdout.write(
      `\nget_entity card: ${sent} code points sent, about ${Math.round(sent / TOKEN)} tokens, ${view.lines?.length} lines (thirty lines: ${before})\n`,
    );
    expect(sent).toBeLessThanOrEqual(CARD_CODE_POINTS);
    expect(CARD_CODE_POINTS).toBe(3_000 * TOKEN);
    expect(view.lines?.length).toBeGreaterThanOrEqual(20);
    expect(view.lines?.slice(0, 3).map((one) => one.kind)).toEqual(["role", "affiliation", "relationship"]);
    expect(view.more).toBe(true);
    // Key phrases: every line fits.
    const short = theirs.slice(0, 30).map(
      (one, n) =>
        ({
          ...one,
          cites: [
            cite(
              one.kind,
              { what: { untrusted: `phrase ${n} of a goal` }, domain: "career" },
              { day: n, subject: ada },
            ),
          ],
        }) as typeof one,
    );
    const fitted = fitCard(parsed, cardLines(short, false));
    expect(fitted.view.lines).toHaveLength(30);
    expect(fitted.view.more).toBe(false);
  });

  // Long notes and many links are cut to their floors before a belief
  // line goes, so the owner's words never push the person's beliefs out of the card.
  it("a person with long notes and many links still shows the card's belief lines; the notes and links are cut to their floors", () => {
    const parsed = EntityView.omit({ lines: true, more: true, facts: true }).parse({
      ...head,
      links: Array.from({ length: 20 }, (_, n) => ({
        disclosure: "use_only",
        url: { untrusted: `https://ada-example.example/page-${n}` },
        kind: "other",
        label: null,
      })),
      ownerWords: Array.from({ length: 8 }, (_, n) => ({
        by: "owner",
        kind: "note",
        key: { untrusted: `Note ${n}` },
        value: { untrusted: words(n).repeat(8).slice(0, 1_000) },
      })),
    });
    const short = theirs.slice(0, 30).map(
      (one, n) =>
        ({
          ...one,
          cites: [
            cite(
              one.kind,
              { what: { untrusted: `phrase ${n} of a goal` }, domain: "career" },
              { day: n, subject: ada },
            ),
          ],
        }) as typeof one,
    );
    const { view } = fitCard(parsed, cardLines(short, false));
    expect(size(compactResult("get_entity", EntityView.parse(view)))).toBeLessThanOrEqual(CARD_CODE_POINTS);
    // The floors hold room for most lines: at least 25 of the 30 fit beside them.
    expect(view.lines?.length).toBeGreaterThanOrEqual(25);
    expect(view.links?.length).toBeGreaterThanOrEqual(LINKS_FLOOR);
    const points = (view.ownerWords ?? []).reduce(
      (sum, one) => sum + [...one.value.untrusted].length + [...(one.key?.untrusted ?? "")].length,
      0,
    );
    expect(points).toBeLessThanOrEqual(OWNER_WORDS_FLOOR);
    expect(points).toBeGreaterThan(0);
    expect(view.more).toBe(true);
  });

  // One entry past the floor is cut to fit it, never dropped whole.
  it("one owner word longer than the floor is cut to fit it, not dropped with every other", () => {
    const parsed = EntityView.omit({ lines: true, more: true, facts: true }).parse({
      ...head,
      ownerWords: [
        { by: "owner", kind: "note", key: { untrusted: "K".repeat(600) }, value: { untrusted: "v".repeat(1_000) } },
      ],
    });
    const { view } = fitCard(parsed, cardLines(theirs, false));
    expect(view.ownerWords).toHaveLength(1);
    expect(view.ownerWords?.[0]?.cut).toBe(true);
    expect([...(view.ownerWords?.[0]?.value.untrusted ?? "")].length).toBe(OWNER_WORDS_FLOOR - 600);
  });

  // The third review: words that already fit the floor are kept whole while the links and lines are cut.
  it("owner words within the floor are never cut while the card is fitted", () => {
    const words = [
      {
        by: "owner" as const,
        kind: "note" as const,
        key: { untrusted: "Focus" },
        value: { untrusted: "A short synthetic note." },
      },
    ];
    const parsed = EntityView.omit({ lines: true, more: true, facts: true }).parse({ ...head, ownerWords: words });
    const { view } = fitCard(parsed, cardLines(theirs, false));
    expect(view.ownerWords).toEqual(words);
  });

  it("context with every part at its cap is about 8 000 tokens or less, and fit holds it there", () => {
    const owners = Array.from({ length: 102 }, (_, n) => {
      const kind = KINDS[n % KINDS.length] as (typeof KINDS)[number];
      const domain = (["career", "ventures", "health"] as const)[n % 3];
      return belief(kind, 1_000 + n, { domain }, [cite(kind, { what: { untrusted: words(n) }, domain }, { day: n })]);
    });
    const lines = linesOf(owners);
    const ranked = rankLines(lines.map((one) => one.line)).map((line) => lines.find((one) => one.line === line)!);
    const sections = buildSections({
      lines: ranked,
      people: new Map([["career", [0, 1, 2, 3, 4].map((n) => ({ who: person(n), claims: 5 - n }))]]),
    });
    const card = cardLines(theirs, false);
    const people = [0, 1, 2].map(() => ({
      who: ada,
      current: head.current,
      warmth: head.warmth,
      lastAt: at(90),
      nextMeeting: meeting(2),
      lines: card.lines.slice(0, CONTEXT_PERSON_LINES).map((one) => one.line),
      more: true,
    }));
    const commitment = (n: number) => ({
      belief: {
        fact: fp(400 + n),
        state: fp(500 + n),
        kind: "commitment",
        type: "commitment",
        status: "active",
        disputed: false,
        provenance: "source",
        confirmedAt: at(n),
        reviewAfter: null,
      },
      direction: "owed_by_owner",
      counterparty: person(n),
      due: null,
      what: { untrusted: `Send the draft of the hardware research plan ${n}` },
      message: `msg_${String(4000 + n).padStart(26, "0")}`,
      capture: null,
      segment: null,
    });
    const view = ContextView.parse({
      domains: ["career", "ventures", "health"],
      sections: sections.slice(0, 3),
      people,
      commitments: Array.from({ length: CONTEXT_COMMITMENTS }, (_, n) => commitment(n)),
      goals: Array.from({ length: CONTEXT_GOALS }, (_, n) => ({
        id: `gol_${String(n).padStart(26, "0")}`,
        statement: { untrusted: words(n) },
        status: "active",
        setAt: at(n),
      })),
      evidence: Array.from({ length: CONTEXT_EVIDENCE }, (_, n) => ({
        fact: fp(1_000 + n),
        claim: fp(60_000 + n),
        source: { kind: "message", id: `msg_${String(n).padStart(26, "0")}` },
        passage: { untrusted: "z".repeat(CONTEXT_PASSAGE) },
        cut: true,
      })),
      more: true,
    });
    const sent = size(compactResult("context", view));
    process.stdout.write(
      `context at its caps: ${size(view)} code points strict, ${sent} sent, about ${Math.round(sent / TOKEN)} tokens\n`,
    );
    expect(sent).toBeLessThanOrEqual(CONTEXT_CODE_POINTS);
    expect(fit(view)).toEqual(view);
    // A view past the bound (long goals) is cut to it, for every client.
    const over = ContextView.parse({
      ...view,
      goals: view.goals.map((goal) => ({ ...goal, statement: { untrusted: "w".repeat(6_000) } })),
    });
    expect(size(compactResult("context", over))).toBeGreaterThan(CONTEXT_CODE_POINTS);
    expect(size(compactResult("context", fit(over)))).toBeLessThanOrEqual(CONTEXT_CODE_POINTS);
  });

  // Context's sections with every line a system notice's, its sender
  // address and subject line a thousand code points each, filled as context fills them (read-self's
  // boundNotice) before `fit`: the whole still fits CONTEXT_CODE_POINTS, and every line kept keeps
  // its notice.
  it("context whose lines are all system notices with long headers stays within CONTEXT_CODE_POINTS", () => {
    const owners = Array.from({ length: 102 }, (_, n) => {
      const domain = (["career", "ventures", "health"] as const)[n % 3];
      return belief("situation", 2_000 + n, { domain }, [
        cite("situation", { what: { untrusted: words(n) }, domain }, { day: n }),
      ]);
    });
    const long = { untrusted: "n".repeat(1_000) };
    const lines = linesOf(owners).map((one) => ({
      ...one,
      line: {
        ...one.line,
        tier: "system_notice" as const,
        notice: boundNotice({ from: null, subject: null, sentAt: at(1) }, long, long),
      },
    }));
    const ranked = rankLines(lines.map((one) => one.line)).map((line) => lines.find((one) => one.line === line)!);
    const sections = buildSections({ lines: ranked, people: new Map() });
    const view = ContextView.parse({
      domains: ["career", "ventures", "health"],
      sections: sections.slice(0, 3),
      people: [],
      commitments: [],
      goals: [],
      evidence: [],
      more: false,
    });
    const fitted = fit(view);
    const sent = size(compactResult("context", fitted));
    process.stdout.write(
      `context of notices alone: ${size(compactResult("context", view))} before fit, ${sent} sent\n`,
    );
    expect(sent).toBeLessThanOrEqual(CONTEXT_CODE_POINTS);
    const kept = fitted.sections.flatMap((one) => one.lines);
    expect(kept.length).toBeGreaterThan(0);
    for (const line of kept) expect([...(line.notice?.from?.untrusted ?? "")].length).toBe(SELF_LINE_CODE_POINTS);
  });

  // The worst case a source can give. Two hundred attendees on each
  // meeting, sixty names and addresses, fifty people, long titles: both bounds still hold.
  const crowd = (n: number) => ({
    ...meeting(n),
    title: { untrusted: "t".repeat(3_000) },
    participants: Array.from({ length: 200 }, (_, i) => person(1_000 + i)),
  });
  const worst = {
    ...head,
    names: Array.from({ length: 60 }, (_, n) => ({ untrusted: `Ada Example the ${n}th of a long line of names` })),
    addresses: Array.from({ length: 60 }, (_, n) => ({ untrusted: `ada.example.${n}@example.com` })),
    people: Array.from({ length: 50 }, (_, n) => person(300 + n)),
    lastMeeting: crowd(1),
    nextMeeting: crowd(2),
    current: { ...head.current, role: { ...head.current.role, title: { untrusted: "r".repeat(3_000) } } },
  };

  it("a card stays within CARD_CODE_POINTS however many attendees, names and people its head has, its participants cut to HEAD_LIST", () => {
    const parsed = EntityView.omit({ lines: true, more: true, facts: true }).parse(worst);
    const { view, lines } = fitCard(parsed, cardLines(theirs, false));
    expect(size(compactResult("get_entity", EntityView.parse(view)))).toBeLessThanOrEqual(CARD_CODE_POINTS);
    expect(view.nextMeeting === null || view.nextMeeting.participants.length <= HEAD_LIST).toBe(true);
    expect(view.more).toBe(true);
    expect(view.lines).toEqual(lines.map((one) => one.line));
    // A tighter bound than any head allows is still held: the head's parts go whole.
    const tight = fitCard(parsed, cardLines(theirs, false), 600);
    expect(size(compactResult("get_entity", EntityView.parse(tight.view)))).toBeLessThanOrEqual(600);
    expect(tight.lines).toEqual([]);
  });

  it("context stays within CONTEXT_CODE_POINTS with three such people, cutting head lists, then whole people, then sections", () => {
    const card = fitCard(
      EntityView.omit({ lines: true, more: true, facts: true }).parse(worst),
      cardLines(theirs, false),
    );
    const one = {
      who: ada,
      current: worst.current,
      warmth: head.warmth,
      lastAt: at(90),
      nextMeeting: crowd(2),
      lines: card.lines.slice(0, CONTEXT_PERSON_LINES).map((line) => line.line),
      more: true,
    };
    const view = ContextView.parse({
      domains: ["career"],
      sections: [],
      people: [one, { ...one, who: person(2) }, { ...one, who: person(3) }],
      commitments: [],
      goals: [],
      evidence: [],
      more: false,
    });
    expect(size(compactResult("context", view))).toBeGreaterThan(CONTEXT_CODE_POINTS);
    const fitted = fit(view);
    expect(size(compactResult("context", fitted))).toBeLessThanOrEqual(CONTEXT_CODE_POINTS);
    expect(fitted.more).toBe(true);
    const bare = fit(view, 200);
    expect(bare.people).toEqual([]);
    expect(size(compactResult("context", bare))).toBeLessThanOrEqual(200);
  });
});
