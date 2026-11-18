// The meeting evaluation's synthetic set: the expected-fact types, the owner and the people on
// reserved domains, the builders that write each meeting and its facts by hand, the fragmented,
// garbled and long scenarios generated from them, and the set itself. The builders stay beside the
// set because each meeting's id comes from the order they are called in.
import { createHash } from "node:crypto";
import type {
  AffiliationRelation,
  LifeDomain,
  MeetingItem,
  MeetingSegment,
  MeetingSpeaker,
  OwnerSideKind,
  RelationshipRelation,
} from "@intelligence/contracts/personal";

// Commitments and plans, by their statement. The person-fact types, each by the words a model
// copies: an owner-side kind's key phrase (with the other phrasings and domains it accepts), a
// role's title, an affiliation's organization, and a relationship's sentence, which it copies none
// of. Subjects and counterparties are addresses; the owner's is EVAL_MEETING_OWNER.
export type EvalStated = {
  type: "commitment" | "plan";
  subject: string;
  counterparty: string;
  what: string;
  due?: string;
  when?: string;
};
export type EvalSideFact = {
  type: OwnerSideKind;
  subject: string;
  domain: LifeDomain;
  phrase: string;
  polarity?: "prefers" | "avoids";
  also?: string[];
  domains?: LifeDomain[];
};
type EvalRoleFact = { type: "role"; subject: string; title: string; organization?: string };
type EvalAffiliationFact = {
  type: "affiliation";
  subject: string;
  relation: AffiliationRelation;
  organization: string;
};
type EvalRelationshipFact = {
  type: "relationship";
  subject: string;
  counterparty: string;
  relation: RelationshipRelation;
  said: string;
};
export type EvalMeetingFact = EvalStated | EvalSideFact | EvalRoleFact | EvalAffiliationFact | EvalRelationshipFact;

// The words of the meeting that state a fact: a passage holds them, or a run of passages does.
export function saidOf(fact: EvalMeetingFact): string {
  switch (fact.type) {
    case "commitment":
    case "plan":
      return fact.what;
    case "role":
      return fact.title;
    case "affiliation":
      return fact.organization;
    case "relationship":
      return fact.said;
    default:
      return fact.phrase;
  }
}
// `speakers` gives each label's address, the owner's first as S1. `fragmented` says the set cut its
// sentences across labels, so the lane must find its labels unreliable; `bound` names a speaker
// known by name alone and the person a binding resolves the name to (the owner's own binding).
// `scenario` names the failure mode of the diagnosed meeting a case reproduces, gated on its own.
// `unreliable` says the lane must find the labels unreliable though the set did not cut them (a
// transcript too sparsely punctuated to measure), so nothing is credited; `allowed` are facts a
// meeting states that no cue in its words ties to a speaker, so a model that finds one with its
// true subject is neither right nor wrong, and one found with another subject is an extra; `paired`
// ties each expected fact to the same fact of the meeting titled `title`, by its index there, so
// the recall of the two may be compared fact by fact. `remote`: the call whose facts on the remote
// stream rest on the lane's remote mark, gated on its own so a lane that loses the mark fails.
// `context`: a room whose labels flip and whose lines name nobody, each fact's subject plain only
// from what each speaker said before; gated on its own recall and on its extras, where a wrong
// attribution shows.
export type EvalScenario = "fragmented" | "garble" | "named" | "long" | "realism" | "remote" | "context";
export type EvalMeeting = {
  id: string;
  item: MeetingItem;
  expected: EvalMeetingFact[];
  ownWord?: true;
  fragmented?: true;
  unreliable?: true;
  bound?: Record<string, string>;
  scenario?: EvalScenario;
  allowed?: EvalMeetingFact[];
  paired?: { title: string; facts: number[] };
};

export const EVAL_MEETING_OWNER = "sam@harbor.example";
// The owner's name, as Lens labels the speaker the owner marked as themselves, so the slot shows it
// and a line that calls the owner by it ties its speaker.
export const EVAL_MEETING_OWNER_NAME = "Sam Ashby";
const OWNER_MENTION = { name: EVAL_MEETING_OWNER_NAME, address: EVAL_MEETING_OWNER };
const START = "2026-03-02T15:00:00.000Z";
export const DECK_LINE = "I will send the deck by Friday.";
// The day `n` days after START, a Monday. FRIDAY is the day the meeting prompt's example reads
// "by Friday" said that Monday as.
const dayAfter = (n: number): string => new Date(Date.parse(START) + n * 86_400_000).toISOString().slice(0, 10);
export const FRIDAY = dayAfter(4);

const LENA = "lena.park@north.example";
const OMAR = "omar.reyes@field.example";
const THEO = "theo.marsh@lake.example";
const NINA = "nina.cole@ridge.example";
const FRANK = "frank.hart@cove.example";
const INES = "ines.ward@stone.example";
export const ROBIN = "robin.vale@example.org";
const MAYA = "maya.lund@birch.example";
const JONAS = "jonas.berg@fern.example";
const PRIYA = "priya.shah@glen.example";
const ARLO = "arlo.fenn@moss.example";
const BEA = "bea.lowe@quill.example";
const CAL = "cal.reed@vale.example";
const DORA = "dora.finch@wren.example";
const EVAN = "evan.marsh@pond.example";
const GWEN = "gwen.hale@cliff.example";
// People of the failure-mode cases.
const KAI = "kai.dunn@heath.example";
const NOOR = "noor.vance@reed.example";
const IVO = "ivo.brandt@heath.example";
const LIV = "liv.hart@brook.example";
// The context case's person.
const TOVE = "tove.ash@pine.example";
export const NAMES: Record<string, string> = {
  [KAI]: "Kai Dunn",
  [NOOR]: "Noor Vance",
  [IVO]: "Ivo Brandt",
  [LIV]: "Liv Hart",
  [TOVE]: "Tove Ash",
  [LENA]: "Lena Park",
  [OMAR]: "Omar Reyes",
  [THEO]: "Theo Marsh",
  [NINA]: "Nina Cole",
  [FRANK]: "Frank Hart",
  [INES]: "Ines Ward",
  [ROBIN]: "Robin Vale",
  [MAYA]: "Maya Lund",
  [JONAS]: "Jonas Berg",
  [PRIYA]: "Priya Shah",
  [ARLO]: "Arlo Fenn",
  [BEA]: "Bea Lowe",
  [CAL]: "Cal Reed",
  [DORA]: "Dora Finch",
  [EVAN]: "Evan Marsh",
  [GWEN]: "Gwen Hale",
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// A ULID-shaped id made from a text: the same text, the same id.
export const ulidOf = (text: string): string => {
  const digest = createHash("sha256").update(text, "utf8").digest();
  return Array.from({ length: 26 }, (_, n) => CROCKFORD[(digest[n] ?? 0) % 32]).join("");
};

const commitment = (subject: string, counterparty: string, what: string, due?: string): EvalMeetingFact => ({
  type: "commitment",
  subject,
  counterparty,
  what,
  ...(due === undefined ? {} : { due }),
});
const plan = (subject: string, counterparty: string, what: string, when: string): EvalMeetingFact => ({
  type: "plan",
  subject,
  counterparty,
  what,
  when,
});
const side =
  (type: OwnerSideKind) =>
  (subject: string, domain: LifeDomain, phrase: string, more: Partial<EvalSideFact> = {}): EvalMeetingFact => ({
    type,
    subject,
    domain,
    phrase,
    ...more,
  });
const need = side("need");
const capability = side("capability");
const goal = side("goal");
const constraint = side("constraint");
const situation = side("situation");
const prefers = (
  subject: string,
  domain: LifeDomain,
  phrase: string,
  more: Partial<EvalSideFact> = {},
): EvalMeetingFact => side("preference")(subject, domain, phrase, { polarity: "prefers", ...more });
const avoids = (
  subject: string,
  domain: LifeDomain,
  phrase: string,
  more: Partial<EvalSideFact> = {},
): EvalMeetingFact => side("preference")(subject, domain, phrase, { polarity: "avoids", ...more });
const role = (subject: string, title: string, organization?: string): EvalMeetingFact => ({
  type: "role",
  subject,
  title,
  ...(organization === undefined ? {} : { organization }),
});
export const affiliation = (subject: string, relation: AffiliationRelation, organization: string): EvalMeetingFact => ({
  type: "affiliation",
  subject,
  relation,
  organization,
});
const relationship = (
  subject: string,
  counterparty: string,
  relation: RelationshipRelation,
  said: string,
): EvalMeetingFact => ({ type: "relationship", subject, counterparty, relation, said });

// A consented call of the owner, S1 on input, and one other person, S2 on output: the lines in
// order, each a segment of its speaker, twenty seconds apart.
let serial = 0;
function meet(title: string, other: string, lines: ["S1" | "S2", string][], expected: EvalMeetingFact[]): EvalMeeting {
  serial += 1;
  const n = String(serial).padStart(2, "0");
  const minutes = Math.max(10, lines.length);
  return {
    id: `meeting-${n}`,
    item: {
      kind: "meeting",
      key: `meeting:${ulidOf(`evaluation meeting ${n}`)}`,
      revision: 0,
      startedAt: START,
      endedAt: new Date(Date.parse(START) + minutes * 60_000).toISOString(),
      app: { bundle: "test.example.meet", name: "Meet" },
      title,
      consent: true,
      mode: "call",
      speakers: [
        { label: "S1", owner: true, mention: OWNER_MENTION },
        { label: "S2", owner: false, mention: { name: NAMES[other] ?? "Guest", address: other } },
      ],
      segments: lines.map(([speaker, text], index) => ({
        speaker,
        fromMs: index * 20_000,
        toMs: index * 20_000 + 19_000,
        channel: speaker === "S1" ? "input" : "output",
        text,
      })),
    },
    expected,
  };
}

// A consented recording in a room, every segment on the one input channel. The owner is S1, marked, as
// Lens marks the owner; `others` are S2 and on, each with a name and an address as the owner labelled
// them, or none (null), so nobody knows who that speaker is; with `unmarked` no speaker is marked the
// owner either. A line's label null is a passage nobody knows the speaker of. Lines are ten seconds
// apart, so a sentence cut in two stays close.
function room(
  title: string,
  others: (string | null)[],
  lines: [string | null, string][],
  expected: EvalMeetingFact[],
  options: { unmarked?: true } = {},
): EvalMeeting {
  serial += 1;
  const n = String(serial).padStart(2, "0");
  const speakers: MeetingSpeaker[] = [
    { label: "S1", owner: options.unmarked !== true, ...(options.unmarked === true ? {} : { mention: OWNER_MENTION }) },
    ...others.map(
      (other, index): MeetingSpeaker => ({
        label: `S${index + 2}`,
        owner: false,
        ...(other === null ? {} : { mention: { name: NAMES[other] ?? "Guest", address: other } }),
      }),
    ),
  ];
  const segments = lines.map(
    ([speaker, text], index): MeetingSegment => ({
      speaker,
      fromMs: index * 10_000,
      toMs: index * 10_000 + 9_000,
      channel: "input",
      text,
    }),
  );
  return {
    id: `meeting-${n}`,
    item: {
      kind: "meeting",
      key: `meeting:${ulidOf(`evaluation meeting ${n}`)}`,
      revision: 0,
      startedAt: START,
      endedAt: new Date(Date.parse(START) + Math.max(10, lines.length) * 60_000).toISOString(),
      app: { bundle: "test.example.recorder", name: "Recorder" },
      title,
      consent: true,
      mode: "room",
      speakers,
      segments,
    },
    expected,
  };
}

const O = EVAL_MEETING_OWNER;
const ownWord = (...args: Parameters<typeof meet>): EvalMeeting => ({ ...meet(...args), ownWord: true });

// A seeded fragmenter, shaped like a diagnosed real room (354 rows, 59 of 74 sentences mixed). Each
// sentence of its true speaker is cut into pieces of two to six words, and each piece is labelled
// its speaker or, at even odds, another label of the meeting, as a diarizer's labels flip. The
// generator is seeded (mulberry32), so the set is the same on every run.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const FLIP_ODDS = 0.5;
function fragmentLines(
  sentences: readonly [string, string][],
  labels: readonly string[],
  seed: number,
): { speaker: string; label: string; text: string }[] {
  const next = seeded(seed);
  return sentences.flatMap(([speaker, text]) => {
    const words = text.split(" ");
    const pieces: string[] = [];
    let at = 0;
    while (at < words.length) {
      const left = words.length - at;
      let take = Math.min(left, 2 + Math.floor(next() * 5));
      // No piece of one word: the last takes it.
      if (left - take === 1) take = take === 6 ? 5 : take + 1;
      pieces.push(words.slice(at, at + take).join(" "));
      at += take;
    }
    const others = labels.filter((one) => one !== speaker);
    return pieces.map((piece) => ({
      speaker,
      label: next() < FLIP_ODDS ? (others[Math.floor(next() * others.length)] ?? speaker) : speaker,
      text: piece,
    }));
  });
}
// The meeting's calendar entry, its attendees the owner and `others`.
const invited = (others: string[]): MeetingItem["calendar"] => ({
  start: START,
  end: new Date(Date.parse(START) + 30 * 60_000).toISOString(),
  attendees: [{ address: EVAL_MEETING_OWNER }, ...others.map((address) => ({ address }))],
});

// Each piece is on its true speaker's stream, as Lens sets a segment's channel from the device its
// transcript came from (S2's lines on output, the rest on the owner's microphone), while its label
// flips on its own among the meeting's labels. `third` adds an unnamed S3, a second voice at the
// microphone. The lane must find the labels unreliable and credit nothing to anyone. Pieces are
// three seconds apart, as diarized fragments are.
function fragmentedCall(
  title: string,
  other: string,
  sentences: ["S1" | "S2" | "S3", string][],
  expected: EvalMeetingFact[],
  allowed: EvalMeetingFact[],
  seed: number,
  options: { invite?: string[]; third?: true; scenario?: EvalScenario } = {},
): EvalMeeting {
  const meeting = meet(title, other, [], expected);
  const labels = options.third === true ? ["S1", "S2", "S3"] : ["S1", "S2"];
  const segments = fragmentLines(sentences, labels, seed).map(
    ({ speaker, label, text }, index): MeetingSegment => ({
      speaker: label,
      fromMs: index * 3_000,
      toMs: index * 3_000 + 2_500,
      channel: speaker === "S2" ? "output" : "input",
      text,
    }),
  );
  const speakers: MeetingSpeaker[] =
    options.third === true ? [...meeting.item.speakers, { label: "S3", owner: false }] : meeting.item.speakers;
  return {
    ...meeting,
    item: { ...meeting.item, segments, speakers, calendar: invited(options.invite ?? [other]) },
    ownWord: true,
    fragmented: true,
    scenario: options.scenario ?? "fragmented",
    allowed,
  };
}

// A room cut by the fragmenter, its pieces on the one input channel: what the diagnosed room was.
// Rooms with fragmented labels are credited to nobody.
function fragmentedRoom(
  title: string,
  other: string,
  sentences: ["S1" | "S2", string][],
  expected: EvalMeetingFact[],
  allowed: EvalMeetingFact[],
  paired: EvalMeeting["paired"],
  seed: number,
): EvalMeeting {
  const meeting = room(title, [other], sentences, expected);
  const segments = fragmentLines(sentences, ["S1", "S2"], seed).map(
    ({ label, text }, index): MeetingSegment => ({
      speaker: label,
      fromMs: index * 3_000,
      toMs: index * 3_000 + 2_500,
      channel: "input",
      text,
    }),
  );
  return {
    ...meeting,
    item: { ...meeting.item, segments, endedAt: new Date(Date.parse(START) + segments.length * 3_000).toISOString() },
    fragmented: true,
    scenario: "fragmented",
    allowed,
    ...(paired === undefined ? {} : { paired }),
  };
}

// A room whose other speaker the owner labelled with a name alone, which a binding resolves to
// `person` (the owner's own binding).
function namedOnly(
  title: string,
  person: string,
  lines: ["S1" | "S2", string][],
  expected: EvalMeetingFact[],
): EvalMeeting {
  const meeting = room(title, [person], lines, expected);
  const name = NAMES[person] ?? "Guest";
  const speakers = meeting.item.speakers.map((one) =>
    one.label === "S2" ? { label: "S2", owner: false, mention: { name } } : one,
  );
  return { ...meeting, item: { ...meeting.item, speakers }, bound: { [name]: person }, scenario: "named" };
}

// A room of ASR garble.
const garbled = (...args: Parameters<typeof room>): EvalMeeting => ({ ...room(...args), scenario: "garble" });

// A fifty-minute room, ten seconds a line: each fact line at its place, and the conversation
// between them from a pool of lines that state no fact, cycled.
const SMALL_TALK = [
  "That makes sense to me.",
  "Sorry, can you say that again?",
  "Right, I see what you mean.",
  "The coffee here has got better.",
  "Did you see the rain this morning?",
  "Let me think about that for a second.",
  "Okay, that is a fair point.",
  "Yes, you mentioned that last time.",
  "Hang on, my phone just buzzed.",
  "Ha, that is very true.",
  "Where were we?",
  "It is busy in here today.",
  "Good question, I am not sure.",
  "Go on, I am listening.",
  "That sounds like a lot of work.",
  "Funny how these things go.",
  "Shall we get another round of tea?",
  "Wait, say more about that.",
  "Sure, that is how it usually goes.",
  "Honestly, I had not thought of it that way.",
  "Interesting, tell me how that went.",
  "We can come back to that one.",
  "Is it always this loud in here?",
  "No, that is fine, carry on.",
];
function longRoom(
  title: string,
  other: string,
  facts: [number, "S1" | "S2", string][],
  expected: EvalMeetingFact[],
  lines = 300,
): EvalMeeting {
  const at = new Map(facts.map(([n, speaker, text]) => [n, [speaker, text] as const]));
  const all: [string, string][] = Array.from({ length: lines }, (_, n) => {
    const fact = at.get(n);
    return fact === undefined
      ? [n % 2 === 0 ? "S1" : "S2", SMALL_TALK[n % SMALL_TALK.length] as string]
      : [fact[0], fact[1]];
  });
  const meeting = room(title, [other], all, expected);
  return {
    ...meeting,
    item: { ...meeting.item, endedAt: new Date(Date.parse(START) + lines * 10_000).toISOString() },
    scenario: "long",
  };
}

// The long room, its fact lines by place and its facts in that order. A fragmented room cuts the
// same lines, and pairs the facts its cues tie.
const LONG_LINES: [number, "S1" | "S2", string][] = [
  [6, "S1", "This year I want to hire a head of sales for the studio."],
  [19, "S2", "I want to write a book about craft brewing."],
  [32, "S1", "I need a bookkeeper who understands small studios."],
  [45, "S2", "I need a co-author who knows the history of brewing."],
  [58, "S2", "I am the head brewer at Brook Ales."],
  [71, "S1", "I am good at pitching to investors."],
  [84, "S2", "I can speak fluent Japanese."],
  [97, "S1", "I prefer working in the mornings."],
  [110, "S2", "I prefer trains to cars."],
  [123, "S1", "I cannot work on Sundays."],
  [136, "S2", "I cannot travel in August."],
  [149, "S1", "I am renovating the old warehouse this winter."],
  [162, "S2", "I am living in Lisbon for the year."],
  [175, "S2", "Sam, you have been my mentor since the brewery opened."],
  [188, "S1", "One idea I want to try is opening the warehouse as a shared workshop."],
  [201, "S2", "Take it from me, I know how to negotiate supplier contracts, so always ask for longer payment terms."],
  [214, "S1", "I will introduce you to my accountant."],
  [227, "S2", "I will send you the brewery's business plan."],
  [240, "S2", "I am a member of the Brook Rowing Club."],
  [253, "S1", "I avoid long phone calls."],
  [266, "S2", "My advice is to hire slowly, I have managed a team of twenty brewers."],
  [279, "S1", "I need a mentor who has sold a company."],
];
const LONG_FACTS: EvalMeetingFact[] = [
  goal(O, "ventures", "hire a head of sales", { also: ["hire a head of sales for the studio"], domains: ["career"] }),
  goal(LIV, "career", "write a book about craft brewing", { domains: ["interests", "ventures"] }),
  need(O, "ventures", "a bookkeeper who understands small studios", { domains: ["money"] }),
  need(LIV, "career", "a co-author who knows the history of brewing", {
    also: ["a co-author"],
    domains: ["ventures", "interests"],
  }),
  role(LIV, "head brewer", "Brook Ales"),
  capability(O, "ventures", "pitching to investors", { domains: ["career"] }),
  capability(LIV, "education", "speak fluent Japanese", { domains: ["career", "interests"] }),
  prefers(O, "career", "working in the mornings"),
  prefers(LIV, "travel", "trains", { also: ["trains to cars"] }),
  constraint(O, "career", "cannot work on Sundays", { domains: ["family"] }),
  constraint(LIV, "travel", "cannot travel in August"),
  situation(O, "ventures", "renovating the old warehouse", { domains: ["home"] }),
  situation(LIV, "home", "living in Lisbon", { also: ["living in Lisbon for the year"] }),
  relationship(LIV, O, "mentor", "Sam, you have been my mentor since the brewery opened."),
  goal(O, "ventures", "opening the warehouse as a shared workshop", {
    also: ["open the warehouse as a shared workshop"],
  }),
  capability(LIV, "ventures", "negotiate supplier contracts", {
    also: ["know how to negotiate supplier contracts"],
    domains: ["career"],
  }),
  commitment(O, LIV, "I will introduce you to my accountant."),
  commitment(LIV, O, "I will send you the brewery's business plan."),
  affiliation(LIV, "member", "Brook Rowing Club"),
  avoids(O, "career", "long phone calls"),
  capability(LIV, "career", "managed a team of twenty brewers", {
    also: ["managing a team of twenty brewers"],
    domains: ["ventures"],
  }),
  need(O, "ventures", "a mentor who has sold a company", { domains: ["career"] }),
];
// The cue each tied line of the fragmented room opens with, by its index in LONG_LINES: the name of
// the one spoken to, which, with two speakers, says who speaks. The mentor line names the owner
// already.
const LONG_CUES: Record<number, string> = {
  0: "Liv",
  1: "Sam",
  3: "Sam",
  5: "Liv",
  8: "Sam",
  9: "Liv",
  12: "Sam",
  13: "",
  16: "Liv",
  18: "Sam",
  21: "Liv",
};
const cued = (cue: string, text: string): string =>
  cue === "" ? text : `${cue}, ${text.startsWith("I ") ? text : `${text[0]?.toLowerCase()}${text.slice(1)}`}`;

// The fragmented room's conversation between its fact lines, longer than the long room's, as a
// room's sentences run on, so that cuts of two to six words leave about five pieces a sentence, as
// the diagnosed room's 354 rows over 74 sentences did. None states a fact.
const RUN_ON = [
  "That makes sense to me, and honestly it is more or less what everyone at the table was saying last time.",
  "Sorry, can you say that again, because the music in here just got louder and I missed the middle bit.",
  "Right, I see what you mean now, it sounds a lot simpler when you put it like that to be fair.",
  "The coffee here has got so much better since they changed the beans and started grinding them fresh every morning.",
  "Did you see the rain this morning, it came down so hard that the whole street was flooded for an hour.",
  "Let me think about that for a second, because there is something about it that does not quite add up yet.",
  "Okay, that is a fair point, and it is not one that anybody raised when we talked about it the other week.",
  "Yes, you mentioned that last time we met, though I think the details were a little different back then.",
  "Hang on, my phone just buzzed, it is only the group chat again, so carry on with what you were saying.",
  "Ha, that is very true, and it is funny how often the same thing comes up whenever we get talking like this.",
  "Where were we before all that, I feel like we wandered a long way off the thing we were talking about.",
  "It is busy in here today, there must be something on nearby because it is usually quiet at this time.",
  "Good question, I am honestly not sure, and I would rather not guess at it when it could easily be wrong.",
  "Go on, I am listening, and take your time with it because there is no rush at all from my side.",
  "That sounds like a lot of work for one person, even if most of it is just waiting around for other people.",
  "Funny how these things go, you spend months planning something and then it all happens in a single afternoon.",
  "Shall we get another round of tea before they close the counter, it looks like the queue is finally gone.",
  "Wait, say more about that, because the way you described it a minute ago was not how I had pictured it.",
  "Sure, that is how it usually goes, and it is never quite as bad as everyone worries it will be beforehand.",
  "Honestly, I had not thought of it that way before, but now that you say it, it seems pretty obvious really.",
  "Interesting, tell me how that went in the end, because last time you were still waiting to hear back from them.",
  "We can come back to that one later if there is time, there is no point getting stuck on it right now.",
  "Is it always this loud in here in the afternoons, or have we just picked a particularly noisy day to come?",
  "No, that is fine, carry on, I only wanted to check that I had followed the first part of the story properly.",
  "It was the same last year as well, if I remember rightly, and nobody seemed to mind it much at the time.",
  "Anyway, that is a story for another day, and I do not want to take us too far off track with it.",
];

// These cases come after the earlier ones so the earlier meetings keep their ids.
function decision0134Meetings(): EvalMeeting[] {
  // (a) The long room's fact lines, two run-on lines of conversation before each and eight after:
  // 74 sentences, cut by the fragmenter into about 300 pieces.
  const sentences: ["S1" | "S2", string][] = [
    ...LONG_LINES.flatMap(([, speaker, text], n): ["S1" | "S2", string][] => [
      [n % 2 === 0 ? "S2" : "S1", RUN_ON[(2 * n) % RUN_ON.length] as string],
      [n % 2 === 0 ? "S1" : "S2", RUN_ON[(2 * n + 1) % RUN_ON.length] as string],
      [speaker, n in LONG_CUES ? cued(LONG_CUES[n] as string, text) : text],
    ]),
    ...Array.from({ length: 8 }, (_, n): ["S1" | "S2", string] => [
      n % 2 === 0 ? "S1" : "S2",
      RUN_ON[(n + 5) % RUN_ON.length] as string,
    ]),
  ];
  const tied = Object.keys(LONG_CUES).map(Number);
  const withCue = (n: number): EvalMeetingFact => {
    const fact = LONG_FACTS[n] as EvalMeetingFact;
    return fact.type === "commitment" ? { ...fact, what: cued(LONG_CUES[n] as string, fact.what) } : fact;
  };
  return [
    fragmentedRoom(
      "Long catch-up, fragmented",
      LIV,
      sentences,
      tied.map(withCue),
      LONG_FACTS.filter((_, n) => !tied.includes(n)),
      { title: "Long catch-up", facts: tied },
      74,
    ),
    ownWord(
      "Training plan",
      PRIYA,
      [
        ["S1", "Priya, thanks for fitting me in before the season starts."],
        ["S2", "Of course, I am the head coach at Glen Running Club."],
        ["S1", "I want to run a marathon next year."],
        ["S1", "I need a physiotherapist who works weekends."],
        ["S1", "I prefer running in the evenings."],
        ["S1", "I cannot run on hills because of my knee."],
        ["S1", "I am training for a half marathon in May."],
        ["S2", "That is a sensible order to do it in."],
      ],
      [
        role(PRIYA, "head coach", "Glen Running Club"),
        goal(O, "health", "run a marathon", { domains: ["interests"] }),
        need(O, "health", "a physiotherapist who works weekends"),
        prefers(O, "health", "running in the evenings", { domains: ["interests"] }),
        constraint(O, "health", "cannot run on hills", {
          also: ["cannot run on hills because of my knee"],
          domains: ["interests"],
        }),
        situation(O, "health", "training for a half marathon", {
          also: ["training for a half marathon in May"],
          domains: ["interests"],
        }),
      ],
    ),
    // (g) Realism: fillers and false starts kept as transcribed, a promise corrected as it is said,
    // and a sentence the owner pauses in for two and a half seconds, which a turn joins.
    paused(
      ownWord(
        "Sailing lessons",
        DORA,
        [
          ["S1", "So, uh, I, I want to, um, learn to sail this summer."],
          ["S2", "Oh nice, I am, um, a sailing instructor at Wren Sailing Club."],
          ["S1", "I need a boat to"],
          ["S1", "borrow on weekends, ideally."],
          ["S2", "I will send, sorry, I will email you the course dates tomorrow."],
          ["S1", "Lovely, that would really help."],
        ],
        [
          goal(O, "interests", "learn to sail", { domains: ["travel"] }),
          role(DORA, "sailing instructor", "Wren Sailing Club"),
          need(O, "interests", "a boat to borrow on weekends"),
          commitment(DORA, O, "I will send, sorry, I will email you the course dates tomorrow.", dayAfter(1)),
        ],
      ),
      2,
      2_500,
    ),
    // (g) Realism: a call transcribed with almost no punctuation, so the lane cannot measure its
    // labels and fails closed; its facts tie a speaker only where a name does.
    {
      ...meet(
        "House painting",
        GWEN,
        [
          ["S1", "hey Gwen so I want to repaint the house this summer"],
          ["S2", "right Sam well I am a painter at Cliff Decorators so I can help"],
          ["S1", "great and I need a ladder that reaches the roof"],
          ["S2", "I prefer working early in the morning before it gets hot"],
          ["S1", "okay Gwen I cannot start before May anyway"],
          ["S2", "fine by me, see you then."],
        ],
        [
          goal(O, "home", "repaint the house"),
          role(GWEN, "painter", "Cliff Decorators"),
          constraint(O, "home", "cannot start before May"),
        ],
      ),
      unreliable: true,
      scenario: "realism",
      allowed: [
        need(O, "home", "a ladder that reaches the roof"),
        prefers(GWEN, "career", "working early in the morning"),
      ],
    },
    // No remote mark where the far end may be more than one person, or a second voice is at the
    // owner's microphone. A colleague beside the owner, a third label on input, whom nobody named:
    // an owner's fact found from their lines is an extra.
    speakerphone(),
    // Two people on the remote stream under one label, the entry inviting both: Ines's lines are
    // S2's, which the owner named Frank.
    fragmentedCall(
      "Board call",
      FRANK,
      [
        ["S2", "Sam, Frank here, I am moving to Oslo in the autumn."],
        ["S2", "I need the accounts before the board meets."],
        ["S1", "Frank and Ines, I want to step down as chair next year."],
        ["S2", "I prefer to keep the meeting short."],
        ["S1", "Fine, let us keep it short then."],
      ],
      [
        situation(FRANK, "home", "moving to Oslo", { also: ["moving to Oslo in the autumn"], domains: ["career"] }),
        goal(O, "career", "step down as chair", { also: ["step down as chair next year"], domains: ["ventures"] }),
      ],
      [],
      53,
      { invite: [FRANK, INES] },
    ),
  ];
}

// The line at `index` and the next one `gapMs` apart, as a pause mid-sentence leaves them; the
// lines after keep their spacing.
function paused(meeting: EvalMeeting, index: number, gapMs: number): EvalMeeting {
  const { segments } = meeting.item;
  const delta = gapMs - ((segments[index + 1] as MeetingSegment).fromMs - (segments[index] as MeetingSegment).toMs);
  const shifted = segments.map((one, n) =>
    n <= index ? one : { ...one, fromMs: one.fromMs + delta, toMs: one.toMs + delta },
  );
  return { ...meeting, item: { ...meeting.item, segments: shifted }, scenario: "realism" };
}

// A supplier call on a speakerphone: the owner S1 and a colleague S3, unnamed and not invited, on
// the owner's microphone, Priya S2 on the remote stream, their labels flipping.
const speakerphone = (): EvalMeeting =>
  fragmentedCall(
    "Speakerphone order",
    PRIYA,
    [
      ["S2", "Sam, it is Priya here, I am the supply manager at Glen Foods."],
      // With a colleague at the same microphone, a name of the one spoken to ties no speaker, so
      // the owner's lines name the owner.
      ["S1", "Priya, it is Sam, I want to switch to weekly deliveries."],
      ["S3", "I need the invoices by the end of the month."],
      ["S2", "I prefer orders by email."],
      ["S3", "I am new to the team, so bear with me."],
      ["S1", "Priya, Sam again, I cannot pay before the invoice arrives."],
    ],
    [
      role(PRIYA, "supply manager", "Glen Foods"),
      goal(O, "ventures", "switch to weekly deliveries"),
      constraint(O, "money", "cannot pay before the invoice arrives", { domains: ["ventures"] }),
    ],
    [prefers(PRIYA, "career", "orders by email", { domains: ["ventures"] })],
    52,
    { third: true },
  );

// A room shaped like a real in-person meeting (two people over coffee), its labels flipping, rich
// in what each says of themselves and with no vocative: no line names Sam or Tove. Who each fact is
// about is plain only from context: Tove's firm, named in Tove's own earlier lines, the question each
// line answers, and who carries a thought on. A room keeps these facts, credited to nobody.
const noCueRoom = (): EvalMeeting => ({
  ...fragmentedRoom(
    "Coffee with a fund partner",
    TOVE,
    [
      ["S1", "Thanks for meeting me here, it is much quieter than my office."],
      ["S2", "Happy to, I needed a break from the desk anyway."],
      ["S1", "So what are you working on these days?"],
      ["S2", "I am a partner at Pine Capital."],
      ["S2", "I want to raise an impact fund of my own."],
      ["S1", "That sounds like a big step."],
      ["S2", "It is, and honestly I dislike B2B sales."],
      ["S1", "I know the feeling."],
      ["S1", "Right now I am building a hiring tool for small clinics."],
      ["S2", "Who are your first customers going to be?"],
      ["S1", "Two clinics nearby, and I need a designer who has worked in health care."],
      ["S2", "I worked with a designer like that at Pine Capital."],
      ["S2", "I will send you her portfolio tonight."],
      ["S1", "That would help, I am good at running sales calls but not at design."],
      ["S2", "I prefer meeting in the mornings, so let us do this again soon."],
      ["S1", "Mornings work for me too."],
    ],
    [
      role(TOVE, "partner", "Pine Capital"),
      goal(TOVE, "ventures", "raise an impact fund", { also: ["raise an impact fund of my own"] }),
      avoids(TOVE, "career", "B2B sales"),
      situation(O, "ventures", "building a hiring tool for small clinics"),
      need(O, "ventures", "a designer who has worked in health care"),
      commitment(TOVE, O, "I will send you her portfolio tonight.", dayAfter(0)),
      capability(O, "career", "running sales calls"),
      prefers(TOVE, "career", "meeting in the mornings"),
    ],
    [],
    undefined,
    137,
  ),
  scenario: "context",
});

export const EVAL_MEETINGS: readonly EvalMeeting[] = Object.freeze([
  // Commitments: seventeen in ten meetings, and two plans. Every "I will" line that promises
  // something is expected, the passing ones too, since any other commitment a model finds is an
  // extra unless it shares an expected one's fact key; the two offers that start "I can" are not
  // expected. A commitment whose line names the one day it is due by or on carries that day as
  // `due`, read from the start, a Monday, as the prompt's own example reads "by Friday"; `due` is
  // part of the fact key and the text is not. A line that names no single day ("this week", "before
  // Friday", "before the end of the week") has none.
  //
  // Each line of meetings 07, 09 and 10 says one thing, so each fact has one reading: the hedge's
  // day is a date it is due by; a plan's day is named only in its proposer's line, and no line
  // confirms it, since the plan type's subject is "who proposed or confirmed it"; the owner's plan
  // in 09 is with Nina alone, not Nina's club; and those meetings' undated promises name no day and
  // hang on nothing that has one.
  meet(
    "Deck check-in",
    ROBIN,
    [
      ["S1", "Thanks for making time today, I know the week has been busy for you."],
      ["S2", "No problem at all, it has been a long week but a good one, and the team is in good spirits."],
      ["S1", "Where are we on the investor deck? The meeting with the partners is coming up soon."],
      ["S2", "The numbers are done and the story is mostly there, I just need to tidy the last few slides."],
      ["S2", DECK_LINE],
      ["S1", "Great, that gives me the weekend to read it before the partners see it."],
      ["S2", "Perfect, and let me know if anything in the appendix looks off to you."],
    ],
    [commitment(ROBIN, O, DECK_LINE, FRIDAY)],
  ),
  meet(
    "Venue shortlist",
    LENA,
    [
      ["S1", "Hi Lena, I wanted to catch up about the spring offsite and where we might hold it."],
      ["S2", "Sure, I have been calling around and three halls are still free in the second half of March."],
      ["S1", "That is good news, the earlier dates were all taken last time we looked."],
      ["S2", "I will send you the venue shortlist tomorrow morning."],
      ["S1", "Thank you, that helps a lot, I can take it to the team on Wednesday."],
      ["S2", "I will add the prices and the capacity for each hall so it is easy to compare."],
    ],
    [
      commitment(LENA, O, "I will send you the venue shortlist tomorrow morning.", dayAfter(1)),
      commitment(LENA, O, "I will add the prices and the capacity for each hall so it is easy to compare."),
    ],
  ),
  ownWord(
    "Grant application",
    OMAR,
    [
      ["S1", "Omar, the grant call closes at the end of the month, so we should split up the sections."],
      ["S2", "Agreed, I read the guidance last night and the budget section looks like the hardest part."],
      ["S1", "I can take the narrative and the timeline if you are happy to look at the money."],
      ["S2", "I will draft the budget section for you this week."],
      ["S1", "I will write the project summary and share it with you before Friday."],
      ["S2", "Sounds like a plan, then we can swap and read each other's parts over the weekend."],
    ],
    [
      commitment(OMAR, O, "I will draft the budget section for you this week."),
      commitment(O, OMAR, "I will write the project summary and share it with you before Friday."),
    ],
  ),
  meet(
    "Kitchen renovation",
    THEO,
    [
      ["S2", "The cabinets are booked to arrive in about two weeks, so we can start the fitting after that."],
      ["S1", "That works for us, the timing suits everyone here."],
      ["S2", "The supplier needs the deposit before they will put the order on the truck."],
      ["S1", "I will pay the deposit to you before the end of the week."],
      ["S2", "Thank you. I will confirm the delivery date once it comes through."],
      ["S1", "Lovely, and let us know if the tiles we picked are still in stock."],
    ],
    [
      commitment(O, THEO, "I will pay the deposit to you before the end of the week."),
      commitment(THEO, O, "I will confirm the delivery date once it comes through."),
    ],
  ),
  meet(
    "Book club",
    NINA,
    [
      ["S1", "Nina, are we still on for the book club next month at your place?"],
      ["S2", "Yes, everyone said they could come, and the first novel is a short one."],
      ["S1", "I have not picked mine yet, so I was hoping to see the list before I buy anything."],
      ["S2", "I will bring the reading list to the next meeting."],
      ["S1", "Perfect. I will bring some snacks and the extra chairs from the hall."],
      ["S2", "That would be great, we ran out of seats last time and two people sat on the floor."],
    ],
    [
      commitment(NINA, O, "I will bring the reading list to the next meeting."),
      commitment(O, NINA, "I will bring some snacks and the extra chairs from the hall."),
    ],
  ),
  meet(
    "Workshop prep",
    INES,
    [
      ["S1", "Ines, the workshop runs for two hours and the middle section still feels weak."],
      ["S2", "I looked at the outline and I think the flow is fine, it is the examples that need work."],
      ["S1", "That is fair, the examples were written in a hurry and some of them are out of date."],
      ["S2", "I will review the slides and leave comments on each example."],
      ["S1", "Thank you so much, that is exactly what I needed from you."],
      ["S2", "Happy to help, the outline is already much stronger than the first draft."],
    ],
    [commitment(INES, O, "I will review the slides and leave comments on each example.")],
  ),
  meet(
    "Garden plans",
    THEO,
    [
      ["S1", "Theo, the hedge at the front has grown right over the path again."],
      ["S2", "I noticed that when I walked past on Sunday, it needs a proper cut this time."],
      ["S1", "Could you fit it in before the neighbours have their party at the weekend?"],
      ["S2", "I will prune the hedge by Thursday, March 5, 2026."],
      ["S1", "Wonderful, thank you, I will leave the side gate open for you."],
      ["S2", "Good, and I will take the cuttings away so you do not have to deal with them."],
    ],
    [
      commitment(THEO, O, "I will prune the hedge by Thursday, March 5, 2026.", dayAfter(3)),
      commitment(O, THEO, "Wonderful, thank you, I will leave the side gate open for you."),
      commitment(THEO, O, "Good, and I will take the cuttings away so you do not have to deal with them."),
    ],
  ),
  meet(
    "Moving day",
    FRANK,
    [
      ["S1", "Frank, the boxes are all packed and sitting in the garage now."],
      ["S2", "Nice work, you were worried you would never finish in time."],
      ["S1", "The sofa is the last thing left to sort out."],
      ["S2", "I will lend you my van for the day of the move."],
      ["S1", "That is so kind, I will fill it up with fuel before I bring it back."],
      ["S2", "No need to rush it back, I will not need it again until the following week."],
    ],
    [
      commitment(FRANK, O, "I will lend you my van for the day of the move."),
      commitment(O, FRANK, "That is so kind, I will fill it up with fuel before I bring it back."),
    ],
  ),
  meet(
    "Running club",
    NINA,
    [
      ["S1", "Nina, it has been a while since my last run."],
      ["S2", "You should join us, we go out every week and nobody is very fast."],
      ["S1", "Nina, let's meet at the park gate on March 12, 2026, just the two of us, for my first run."],
      ["S2", "I will send you the link to the club's group chat."],
      ["S1", "I will need a few weeks before I can keep up with any of you, I suspect."],
      ["S2", "Everyone says that and then they are fine after the second week."],
    ],
    [
      plan(
        O,
        NINA,
        "Nina, let's meet at the park gate on March 12, 2026, just the two of us, for my first run.",
        "2026-03-12",
      ),
      commitment(NINA, O, "I will send you the link to the club's group chat."),
    ],
  ),
  meet(
    "Supplier lunch",
    OMAR,
    [
      ["S2", "It has been ages since we sat down properly, the calls are never long enough."],
      ["S1", "I agree, there is a lot to talk about with the new contracts coming up."],
      ["S2", "Let's have lunch at the harbour cafe on March 18, 2026 and go through them."],
      ["S1", "I will send you the new contract drafts as soon as our lawyer signs them off."],
      ["S2", "Good thinking, the last time we talked contracts it took most of the day."],
      ["S1", "Bring the old terms with you, then we can compare them side by side."],
    ],
    [
      plan(OMAR, O, "Let's have lunch at the harbour cafe on March 18, 2026 and go through them.", "2026-03-18"),
      commitment(O, OMAR, "I will send you the new contract drafts as soon as our lawyer signs them off."),
    ],
  ),
  // No facts: chat, status, questions and plans with no date.
  meet(
    "Weekly catch-up",
    LENA,
    [
      ["S1", "How was the weekend, did you get to the coast in the end?"],
      ["S2", "We did, the weather was cold but clear and the kids loved the beach."],
      ["S1", "That sounds lovely, we stayed home and finally sorted out the attic."],
      ["S2", "Anything interesting up there, or just old boxes of paperwork?"],
      ["S1", "Mostly paperwork, and a box of photos from when we first moved in."],
      ["S2", "Those are the best finds, it is easy to forget how much things have changed."],
    ],
    [],
  ),
  meet(
    "Status update",
    OMAR,
    [
      ["S2", "The report went out on time and the client said they were happy with it."],
      ["S1", "Good to hear, the last one was late and they mentioned it twice."],
      ["S2", "The team worked hard on it, especially on the charts in the second half."],
      ["S1", "The charts were much clearer this time, I noticed that straight away."],
      ["S2", "We used the new template, which made the colours far more consistent."],
      ["S1", "Let us keep using it for the next few reports and see how it goes."],
    ],
    [],
  ),
  meet(
    "Questions about the lease",
    THEO,
    [
      ["S1", "Theo, do you know whether the lease allows us to put up shelves in the hall?"],
      ["S2", "I am not sure, the wording on fixtures has always been a bit vague."],
      ["S1", "The last tenant had shelves, so maybe it was fine for them."],
      ["S2", "Maybe, but they might have asked the landlord first, we do not really know."],
      ["S1", "It would be worth finding out before we drill any holes in the wall."],
      ["S2", "Agreed, nobody wants to lose part of the deposit over a shelf."],
    ],
    [],
  ),
  meet(
    "Film night",
    NINA,
    [
      ["S2", "We watched the documentary about the lighthouse keepers on Friday night."],
      ["S1", "Was it any good? I have heard mixed things about it from friends."],
      ["S2", "The photography was beautiful, but the story dragged in the middle."],
      ["S1", "That is often the problem with those long documentaries, they need an editor."],
      ["S2", "Exactly, an hour would have been plenty for what they had to say."],
      ["S1", "I might still watch it for the pictures one evening when it is raining."],
    ],
    [],
  ),
  meet(
    "Office move",
    FRANK,
    [
      ["S1", "The new office has much better light than the old one, have you seen it yet?"],
      ["S2", "Only the photos, but it does look bright and the kitchen is bigger."],
      ["S1", "The meeting rooms are smaller though, which might be a problem for workshops."],
      ["S2", "We could always book the room downstairs when we need more space."],
      ["S1", "True, the building has a few shared rooms that nobody seems to use."],
      ["S2", "Then it should be fine for most weeks, and we can see how it works out."],
    ],
    [],
  ),
  meet(
    "Recipe swap",
    INES,
    [
      ["S2", "The soup you described last week sounded wonderful, what was in it?"],
      ["S1", "Mostly leeks and potatoes, with a lot of black pepper and a little cream."],
      ["S2", "That is simpler than I expected, I thought it would have more spices."],
      ["S1", "The trick is to cook the leeks slowly so they go sweet before the stock goes in."],
      ["S2", "I always rush that part, which is probably why mine tastes flat."],
      ["S1", "Everyone does, it feels like nothing is happening for the first twenty minutes."],
    ],
    [],
  ),
  meet(
    "Maybe some time",
    ROBIN,
    [
      ["S1", "We should get the families together at some point, it has been far too long."],
      ["S2", "We really should, maybe once the school term settles down a bit."],
      ["S1", "The spring is always busy, but the summer might work better for everyone."],
      ["S2", "Perhaps, we will see what the kids have on by then, it changes every week."],
      ["S1", "Fair enough, there is no rush, it was just a thought that came up."],
      ["S2", "It is a good thought, and we will find a weekend sooner or later."],
    ],
    [],
  ),
  meet(
    "Train trouble",
    LENA,
    [
      ["S2", "Sorry I am a few minutes late, the trains were all delayed again this morning."],
      ["S1", "Do not worry about it, the same thing happened to me on Tuesday."],
      ["S2", "They keep saying the works will finish soon, but nobody believes them anymore."],
      ["S1", "I took the bike on Tuesday instead, it was almost as quick in the end."],
      ["S2", "I have thought about it, but the hill on my side of town is terrible."],
      ["S1", "That is fair, the hill would put anyone off on a cold morning."],
    ],
    [],
  ),
  meet(
    "Past plans",
    OMAR,
    [
      ["S1", "Last year we sent the brochure to the printers far too late, do you remember?"],
      ["S2", "I do, the boxes arrived the morning of the fair and we were still unpacking them."],
      ["S1", "It worked out in the end, but it was much more stressful than it needed to be."],
      ["S2", "The printers were good about it, they knew we were cutting it close."],
      ["S1", "They were, and the brochure itself looked better than the year before."],
      ["S2", "The new photos made the difference, the old ones were very dark."],
    ],
    [],
  ),
  meet(
    "Ideas only",
    INES,
    [
      ["S2", "One idea for the newsletter would be a short interview with a new member each month."],
      ["S1", "I like that, it would help people get to know each other a little better."],
      ["S2", "We would need someone willing to do the interviews and write them up."],
      ["S1", "It is worth raising at the committee and seeing who is interested."],
      ["S2", "Another idea would be a photo of the month from one of the members."],
      ["S1", "Both are good, and neither would take very much space on the page."],
    ],
    [],
  ),
  // The person-fact types, in calls and in rooms. Each line states one fact or none, and its domain
  // is the one DOMAIN_WORDS gives it; where two domains are defensible the fact lists both. A
  // room's sentences are often cut across passages, and a short piece of one is sometimes given to
  // the other speaker. A fact about a speaker nobody named is never expected.
  room(
    "Sailing plans",
    [THEO],
    [
      ["S1", "Theo, this spring I really want to sail across the"],
      ["S1", "bay."],
      ["S2", "You will manage it, you have the patience for long days on the water."],
      ["S2", "I am a sailing instructor at Lake Marina."],
      ["S2", "I prefer dinghies to big boats."],
      ["S1", "I avoid crowded beaches."],
      ["S2", "Then the north shore is the place to start."],
    ],
    [
      goal(O, "interests", "sail across the bay", { domains: ["travel"] }),
      role(THEO, "sailing instructor", "Lake Marina"),
      prefers(THEO, "interests", "dinghies"),
      avoids(O, "interests", "crowded beaches", { domains: ["travel"] }),
    ],
  ),
  room(
    "Flat move",
    [NINA],
    [
      ["S1", "Nina, we are moving to"],
      ["S2", "Lisbon"],
      ["S1", "in the autumn, so the flat is half packed."],
      ["S2", "That is exciting, I grew up near there."],
      // The labels are unreliable here, so each line the set expects a subject of names whom it is
      // spoken to.
      ["S1", "Nina, I need a mover who can take a piano."],
      ["S2", "I'll"],
      ["S1", "send you the mover's number, Nina."],
      ["S2", "Sam, I am a member of the Lisbon Walking Club, so I can show you around."],
      ["S1", "Nina, I prefer old buildings to new ones."],
    ],
    [
      situation(O, "home", "moving to Lisbon"),
      need(O, "home", "a mover who can take a piano"),
      commitment(O, NINA, "I'll send you the mover's number, Nina."),
      affiliation(NINA, "member", "Lisbon Walking Club"),
      prefers(O, "home", "old buildings"),
    ],
  ),
  meet(
    "Studio funding",
    LENA,
    [
      ["S1", "Lena, thanks for joining, I wanted your view on the studio."],
      ["S2", "Happy to. I founded Pine Works, so I have been through a raise myself."],
      ["S1", "This year I want to raise a seed round for the studio."],
      ["S1", "I need a lawyer who knows startup contracts."],
      ["S2", "I am good at negotiating term sheets."],
      ["S2", "I am also an advisor to Birch Labs."],
      ["S1", "Good to know, thank you."],
    ],
    [
      affiliation(LENA, "founder", "Pine Works"),
      goal(O, "ventures", "raise a seed round"),
      need(O, "ventures", "a lawyer who knows startup contracts", { domains: ["career"] }),
      capability(LENA, "ventures", "negotiating term sheets", { domains: ["career"] }),
      affiliation(LENA, "advisor", "Birch Labs"),
    ],
  ),
  room(
    "Language exchange",
    [INES],
    [
      ["S1", "Ines, my plan for this year is to learn"],
      ["S1", "Portuguese properly."],
      ["S2", "I am a Portuguese teacher at Stone Academy."],
      ["S2", "I speak four languages, so grammar is my strong point."],
      ["S1", "I prefer evening lessons."],
      ["S1", "I cannot take lessons on Mondays."],
      ["S2", "Then Tuesdays and Thursdays it is."],
    ],
    [
      goal(O, "education", "learn Portuguese", { also: ["learn Portuguese properly"] }),
      role(INES, "Portuguese teacher", "Stone Academy"),
      capability(INES, "education", "speak four languages"),
      prefers(O, "education", "evening lessons"),
      constraint(O, "education", "cannot take lessons on Mondays"),
    ],
  ),
  ownWord(
    "Hiring round",
    OMAR,
    [
      ["S1", "Omar, I wanted to ask about your team before the hiring round."],
      ["S2", "I am the head of engineering at Field Systems."],
      ["S2", "I need a senior data engineer for the team."],
      ["S1", "I studied at Harbor University, so I know a few people there."],
      ["S2", "I avoid recruiters who cold call."],
      ["S1", "Understood, let us keep it informal."],
    ],
    [
      role(OMAR, "head of engineering", "Field Systems"),
      need(OMAR, "career", "a senior data engineer", { also: ["a senior data engineer for the team"] }),
      affiliation(O, "alumnus", "Harbor University"),
      avoids(OMAR, "career", "recruiters who cold call"),
    ],
  ),
  room(
    "Allotment",
    [FRANK, null],
    [
      ["S3", "I want to grow tomatoes this year."],
      ["S1", "I want to start a vegetable garden."],
      ["S2", "I know how to keep bees."],
      ["S3", "I am a nurse at the city hospital."],
      ["S2", "I am the chair of the Cove Allotment Society."],
      ["S1", "I prefer organic seeds."],
      ["S2", "We share tools on Saturdays."],
    ],
    [
      goal(O, "interests", "start a vegetable garden", { domains: ["home"] }),
      capability(FRANK, "interests", "keep bees"),
      role(FRANK, "chair", "Cove Allotment Society"),
      prefers(O, "interests", "organic seeds", { domains: ["home"] }),
    ],
  ),
  meet(
    "Old colleagues",
    ROBIN,
    [
      ["S2", "Sam, you were my manager for three years, and I learned a lot."],
      ["S1", "Those were good years."],
      ["S2", "I am a product designer at Alder Studio now."],
      ["S2", "I want to start a design agency."],
      ["S1", "You would be great at that."],
      ["S2", "I need a business partner who handles sales."],
    ],
    [
      relationship(ROBIN, O, "manager", "Sam, you were my manager for three years, and I learned a lot."),
      role(ROBIN, "product designer", "Alder Studio"),
      goal(ROBIN, "ventures", "start a design agency", { domains: ["career"] }),
      need(ROBIN, "ventures", "a business partner who handles sales"),
    ],
  ),
  meet(
    "Back to Oslo",
    MAYA,
    [
      ["S2", "Sam, you are my oldest friend, so I wanted to tell you first."],
      ["S2", "I am moving back to Oslo next spring."],
      ["S2", "I avoid long flights with the baby."],
      ["S1", "Then we can visit you there instead."],
      ["S2", "I prefer trains to planes anyway."],
    ],
    [
      relationship(MAYA, O, "friend", "Sam, you are my oldest friend, so I wanted to tell you first."),
      situation(MAYA, "home", "moving back to Oslo"),
      avoids(MAYA, "travel", "long flights", { also: ["long flights with the baby"] }),
      prefers(MAYA, "travel", "trains"),
    ],
  ),
  room(
    "Library visit",
    [PRIYA],
    [
      ["S1", "Priya, I am really into"],
      ["S1", "historical novels at the moment."],
      // As in "Flat move": the labels are unreliable, so each line the set expects a subject of
      // names whom it is spoken to.
      ["S2", "Sam, I am a librarian at Glen Library."],
      ["S2", "Sam, this year I want to write a detective"],
      ["S1", "novel."],
      ["S1", "You should, your reviews are always the best part of the newsletter."],
    ],
    [
      role(PRIYA, "librarian", "Glen Library"),
      prefers(O, "interests", "historical novels"),
      goal(PRIYA, "interests", "write a detective novel", { domains: ["career"] }),
    ],
  ),
  meet(
    "Savings",
    JONAS,
    [
      ["S2", "I am a partner at Fern Capital."],
      ["S1", "I want to buy a flat within two years."],
      ["S1", "I cannot take on more debt."],
      ["S2", "I am also on the board of Glen Trust."],
      ["S2", "I prefer index funds for my own savings."],
      ["S1", "That is what I hear from everyone."],
    ],
    [
      role(JONAS, "partner", "Fern Capital"),
      goal(O, "money", "buy a flat", { domains: ["home"] }),
      constraint(O, "money", "cannot take on more debt"),
      affiliation(JONAS, "board", "Glen Trust"),
      prefers(JONAS, "money", "index funds"),
    ],
  ),
  room(
    "Wedding plans",
    [FRANK],
    [
      ["S1", "Frank, we are getting"],
      ["S1", "married in September."],
      ["S2", "Congratulations! I am a wedding photographer, you know."],
      ["S1", "We need a venue for eighty guests."],
      ["S1", "I cannot spend more than ten thousand on the wedding."],
      ["S2", "I avoid shooting in churches, the light is too dark."],
    ],
    [
      situation(O, "family", "getting married", { domains: ["relationships"] }),
      role(FRANK, "wedding photographer"),
      need(O, "family", "a venue for eighty guests", { domains: ["relationships"] }),
      constraint(O, "money", "cannot spend more than ten thousand on the wedding", {
        also: ["cannot spend more than ten thousand"],
        domains: ["family"],
      }),
      avoids(FRANK, "career", "shooting in churches"),
    ],
  ),
  meet(
    "Mentoring",
    NINA,
    [
      ["S2", "Sam, you have been my mentor since university."],
      ["S2", "I study at Harlow Vale College."],
      ["S2", "I want to become a data scientist."],
      ["S2", "I need an internship for the summer."],
      ["S1", "I know a few teams who take interns."],
      ["S2", "I am good at statistics."],
    ],
    [
      relationship(NINA, O, "mentor", "Sam, you have been my mentor since university."),
      affiliation(NINA, "student", "Harlow Vale College"),
      goal(NINA, "career", "become a data scientist"),
      need(NINA, "career", "an internship", { also: ["an internship for the summer"] }),
      capability(NINA, "education", "statistics", { domains: ["career"] }),
    ],
  ),
  room(
    "Climbing",
    [OMAR],
    [
      ["S2", "I have climbed for twenty years and I can lead routes at grade"],
      ["S2", "seven."],
      ["S1", "I want to climb outdoors this summer."],
      ["S1", "I prefer bouldering to roped climbing."],
      ["S2", "I am a member of the Field Climbing Club."],
      ["S2", "I cannot climb on weekdays."],
      ["S2", "I will lend you my"],
      ["S2", "climbing shoes."],
    ],
    [
      capability(OMAR, "interests", "lead routes at grade seven"),
      goal(O, "interests", "climb outdoors"),
      prefers(O, "interests", "bouldering"),
      affiliation(OMAR, "member", "Field Climbing Club"),
      constraint(OMAR, "interests", "cannot climb on weekdays"),
      commitment(OMAR, O, "I will lend you my climbing shoes."),
    ],
  ),
  ownWord(
    "Sabbatical",
    THEO,
    [
      ["S2", "I am on sabbatical until January 2027."],
      ["S2", "I want to walk the length of the Danube."],
      ["S1", "I work as an analyst at Harbor Bank."],
      ["S1", "I cannot take more than two weeks off at a time."],
      ["S2", "I speak Romanian, which will help on the river."],
      ["S1", "That sounds like the trip of a lifetime."],
    ],
    [
      situation(THEO, "career", "on sabbatical", { also: ["on sabbatical until January 2027"] }),
      goal(THEO, "travel", "walk the length of the Danube"),
      role(O, "analyst", "Harbor Bank"),
      constraint(O, "career", "cannot take more than two weeks off at a time"),
      capability(THEO, "education", "speak Romanian", { domains: ["travel"] }),
    ],
  ),
  room(
    "Neighbours",
    [GWEN],
    [
      ["S2", "Sam, you are my neighbour across the road, so I hear all your building work."],
      ["S1", "We are renovating the"],
      ["S2", "kitchen"],
      ["S1", "this winter."],
      ["S2", "I am a carpenter, so ask me about the cupboards."],
      ["S1", "I need a plumber who works on weekends."],
      ["S2", "I avoid flat-pack furniture."],
      ["S2", "I cannot keep pets in the flat."],
      ["S1", "I will bring the"],
      ["S1", "plans round to you."],
    ],
    [
      relationship(GWEN, O, "neighbor", "Sam, you are my neighbour across the road, so I hear all your building work."),
      situation(O, "home", "renovating the kitchen"),
      role(GWEN, "carpenter"),
      need(O, "home", "a plumber who works on weekends"),
      avoids(GWEN, "home", "flat-pack furniture"),
      constraint(GWEN, "home", "cannot keep pets in the flat"),
      commitment(O, GWEN, "I will bring the plans round to you."),
    ],
  ),
  meet(
    "Family news",
    INES,
    [
      ["S2", "Sam, you are my cousin, so here is the honest version."],
      ["S2", "I am between jobs at the moment."],
      ["S2", "I want to retrain as a nurse."],
      ["S1", "That would suit you, you were always the one who looked after everyone."],
    ],
    [
      relationship(INES, O, "family", "Sam, you are my cousin, so here is the honest version."),
      situation(INES, "career", "between jobs"),
      goal(INES, "career", "retrain as a nurse", { domains: ["education"] }),
    ],
  ),
  meet(
    "Shop accounts",
    ARLO,
    [
      ["S2", "Sam, you are my oldest client, so you get the first call."],
      ["S2", "I am selling the shop."],
      ["S2", "I need a new accountant for the sale."],
      ["S2", "I can play the cello, so retirement will not be dull."],
      ["S1", "I am sorry to hear the shop is going."],
    ],
    [
      relationship(ARLO, O, "client", "Sam, you are my oldest client, so you get the first call."),
      situation(ARLO, "ventures", "selling the shop", { domains: ["career"] }),
      need(ARLO, "money", "a new accountant", { domains: ["ventures"] }),
      capability(ARLO, "interests", "play the cello"),
    ],
  ),
  meet(
    "Quill catch-up",
    BEA,
    [
      ["S2", "Sam, you were my colleague at Quill for years, so you know how I work."],
      ["S2", "I am on parental leave until May."],
      ["S2", "I cannot work more than three days a week."],
      ["S2", "I can build websites."],
      ["S2", "I volunteer at the Quill Food Bank on Sundays."],
      ["S1", "It is good to hear from you."],
    ],
    [
      relationship(BEA, O, "colleague", "Sam, you were my colleague at Quill for years, so you know how I work."),
      situation(BEA, "career", "on parental leave", { domains: ["family"] }),
      constraint(BEA, "career", "cannot work more than three days a week"),
      capability(BEA, "career", "build websites"),
      affiliation(BEA, "volunteer", "Quill Food Bank"),
    ],
  ),
  meet(
    "Supplier call",
    CAL,
    [
      ["S2", "Sam, you were my supplier at Vale for years."],
      ["S2", "I am living in Berlin for the year."],
      ["S2", "I am an investor in Wren Robotics."],
      ["S2", "I need a co-founder who can code."],
      ["S2", "I cannot invest more than fifty thousand in any one company."],
      ["S1", "Berlin will suit you."],
    ],
    [
      relationship(CAL, O, "vendor", "Sam, you were my supplier at Vale for years."),
      situation(CAL, "home", "living in Berlin"),
      affiliation(CAL, "investor", "Wren Robotics"),
      need(CAL, "ventures", "a co-founder who can code"),
      constraint(CAL, "money", "cannot invest more than fifty thousand in any one company", { domains: ["ventures"] }),
    ],
  ),
  meet(
    "Childcare",
    DORA,
    [
      ["S2", "Sam, you are my uncle, so I hope you do not mind me asking."],
      ["S2", "I need a babysitter on Thursday evenings."],
      ["S2", "I am good at mediating disputes."],
      ["S2", "I cannot work weekends."],
      ["S1", "Of course I do not mind."],
    ],
    [
      relationship(DORA, O, "family", "Sam, you are my uncle, so I hope you do not mind me asking."),
      need(DORA, "family", "a babysitter on Thursday evenings", { also: ["a babysitter"] }),
      capability(DORA, "career", "mediating disputes"),
      constraint(DORA, "career", "cannot work weekends"),
    ],
  ),
  meet(
    "Flying lessons",
    EVAN,
    [
      ["S2", "Sam, you were my classmate at Pond College, remember?"],
      ["S2", "I am studying for a pilot's licence."],
      ["S2", "I know how to fix old motorbikes."],
      ["S2", "I do contract work for Pond Energy."],
      ["S2", "I cannot fly before April 10, 2026."],
      ["S1", "Of course I remember, you sat at the back."],
    ],
    [
      relationship(EVAN, O, "classmate", "Sam, you were my classmate at Pond College, remember?"),
      situation(EVAN, "education", "studying for a pilot's licence"),
      capability(EVAN, "interests", "fix old motorbikes"),
      affiliation(EVAN, "contractor", "Pond Energy"),
      constraint(EVAN, "travel", "cannot fly before April 10, 2026"),
    ],
  ),
  // No speaker is marked the owner and no speaker is named: nobody the lane can know.
  room(
    "Unnamed speakers",
    [null],
    [
      ["S1", "I want to learn the piano this year."],
      ["S2", "I am a dentist at the clinic on the corner."],
      ["S1", "I prefer working from home."],
      ["S2", "I need a new car."],
    ],
    [],
    { unmarked: true },
  ),
  room(
    "Unnamed, cut short",
    [null],
    [
      ["S2", "I cannot travel before"],
      ["S1", "the end of the month."],
      ["S1", "I founded a small bakery last year."],
      [null, "I am moving to the coast."],
    ],
    [],
    { unmarked: true },
  ),
  // Fragmented diarization: each sentence cut into pieces of two to six words whose labels flip,
  // each piece on its speaker's stream. Kai's lines come in on the remote stream, and the lane
  // marks them so; the owner's lines tie Kai only where they say who is spoken to, and the rest are
  // allowed.
  fragmentedCall(
    "Studio lease",
    KAI,
    [
      ["S1", "Kai, this year I want to open a second studio in the city."],
      ["S2", "I am the head of design at Heath Works."],
      ["S1", "I need a landlord who allows late opening hours."],
      ["S2", "I prefer small teams to big ones."],
      ["S1", "I cannot sign a lease before June."],
      ["S2", "I will send you the floor plans tomorrow."],
      ["S1", "Kai, I am good at negotiating with landlords."],
      ["S2", "I am moving to Porto in the spring."],
      ["S1", "Anyway, it was good to catch up properly, thanks."],
    ],
    [
      goal(O, "ventures", "open a second studio", { also: ["open a second studio in the city"] }),
      role(KAI, "head of design", "Heath Works"),
      prefers(KAI, "career", "small teams", { also: ["small teams to big ones"] }),
      commitment(KAI, O, "I will send you the floor plans tomorrow.", dayAfter(1)),
      capability(O, "ventures", "negotiating with landlords", { domains: ["home"] }),
      situation(KAI, "home", "moving to Porto", { also: ["moving to Porto in the spring"] }),
    ],
    [
      need(O, "ventures", "a landlord who allows late opening hours", { domains: ["home"] }),
      constraint(O, "ventures", "cannot sign a lease before June", { domains: ["home"] }),
    ],
    44,
    { scenario: "remote" },
  ),
  // ASR garble. A small model's wrong homophones and dropped words, each fact's phrase as
  // transcribed, never corrected: "fondant" for fund, "clawed" for Claude, "quite" for quiet,
  // "right" for write, "male" for mail, and a dropped article.
  garbled(
    "Grant ideas",
    [NOOR],
    [
      ["S1", "Noor, next year I want to raise a fondant for climate startups."],
      ["S2", "Nice. I am building a clawed agent for my research team."],
      ["S2", "I need a engineer who knows rust and go."],
      ["S1", "I prefer quite cafes to loud offices."],
      ["S2", "I can right grant applications in a weak."],
      ["S1", "I need lawyer who knows employment law."],
      ["S1", "I cannot travel until the fall."],
      ["S2", "I am the founder of Reed Labs."],
      ["S2", "I will male you the budget on Friday."],
      ["S1", "Great, that would really help me."],
    ],
    [
      goal(O, "ventures", "raise a fondant for climate startups", { also: ["raise a fondant"], domains: ["money"] }),
      situation(NOOR, "career", "building a clawed agent", {
        also: ["building a clawed agent for my research team"],
        domains: ["ventures"],
      }),
      need(NOOR, "career", "a engineer who knows rust and go", {
        also: ["engineer who knows rust and go"],
        domains: ["ventures"],
      }),
      prefers(O, "career", "quite cafes", { also: ["quite cafes to loud offices"], domains: ["interests"] }),
      capability(NOOR, "career", "right grant applications", {
        also: ["right grant applications in a weak"],
        domains: ["ventures"],
      }),
      need(O, "ventures", "lawyer who knows employment law", { domains: ["career"] }),
      constraint(O, "travel", "cannot travel until the fall"),
      affiliation(NOOR, "founder", "Reed Labs"),
      commitment(NOOR, O, "I will male you the budget on Friday.", FRIDAY),
    ],
  ),
  // A participant known by a name alone, whom a binding resolves.
  namedOnly(
    "Workshop space",
    IVO,
    [
      ["S1", "Ivo, thanks for coming over to see the space."],
      ["S2", "I am a carpenter at Heath Joinery."],
      ["S2", "This spring I want to start teaching evening classes."],
      ["S2", "I need a workshop with three-phase power."],
      ["S1", "I can build simple websites, so I could make you a booking page."],
      ["S2", "I will bring you my sketches on Thursday, March 5, 2026."],
      ["S1", "Lovely, see you then."],
    ],
    [
      role(IVO, "carpenter", "Heath Joinery"),
      goal(IVO, "career", "start teaching evening classes", { domains: ["ventures", "education"] }),
      need(IVO, "career", "a workshop with three-phase power", { domains: ["ventures"] }),
      capability(O, "career", "build simple websites", { domains: ["ventures"] }),
      commitment(IVO, O, "I will bring you my sketches on Thursday, March 5, 2026.", dayAfter(3)),
    ],
  ),
  // Fifty minutes of conversation, dense with each person's goals, needs, capabilities,
  // preferences, constraints, situation, promises, ideas and advice.
  longRoom("Long catch-up", LIV, LONG_LINES, LONG_FACTS),
  ...decision0134Meetings(),
  noCueRoom(),
]);
