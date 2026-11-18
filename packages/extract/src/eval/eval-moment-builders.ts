// The moment evaluation set's vocabulary: its types, the synthetic people on reserved domains, the
// expected-fact helpers and the builders that shape mail, chats, long threads and iMessage sessions
// into moments. The builders number groups and moment keys from one counter in call order, so only
// the set itself calls them, once, when it loads.
import {
  type AffiliationRelation,
  type LifeDomain,
  MOMENT_TURNS_MAX,
  type MomentItem,
  type MomentTurn,
  type OwnerSideKind,
  type RelationshipRelation,
} from "@intelligence/contracts/personal";
import type { EvalMeetingFact, EvalSideFact } from "./eval-meetings-set.ts";
import { ulidOf } from "./eval-open.ts";

// `by`: the address of the speaker code must credit, or absent for nobody. `alt`: the other
// phrasings of a commitment's or a plan's `what` the fact accepts, such as a line with its
// sender's name before it. Every type of MOMENT_TYPES is covered, in the meeting set's shapes
// (an owner-side kind's key phrase, a role's title, an affiliation's organization, a
// relationship's sentence), each found by the words a model copies (`saidOf`).
export type EvalMomentFact = EvalMeetingFact & { by?: string; alt?: string[] };
// One group: its moments, one thread of one app on one local day, and what they say. `agentApp`:
// its moments came from an app an agent-app rule admitted. `bound`: a participant known by a name
// alone, by name to the person the sync's participant step binds it to, as the meeting set's
// name-only case is. `scenario`: a case gated on its own recall and extras. `imessage`: chats read
// from Messages' own database, their contacts by phone.
export type EvalMomentScenario = "thread" | "group_named" | "imessage";
export type EvalMomentGroup = {
  id: string;
  moments: MomentItem[];
  expected: EvalMomentFact[];
  agentApp?: boolean;
  bound?: Record<string, string>;
  scenario?: EvalMomentScenario;
};

export const EVAL_MOMENT_OWNER = "sam@harbor.example";
export const MOMENT_DECK_LINE = "I will send the deck by Friday.";
// Every moment is seen on START, a Monday. FRIDAY is the day the moment prompt's example reads
// "by Friday" said that Monday as.
const START = "2026-03-02";
export const dayAfter = (n: number): string =>
  new Date(Date.parse(`${START}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const FRIDAY = dayAfter(4);

export const LENA = "lena.park@north.example";
export const OMAR = "omar.reyes@field.example";
export const THEO = "theo.marsh@lake.example";
export const NINA = "nina.cole@ridge.example";
export const FRANK = "frank.hart@cove.example";
export const INES = "ines.ward@stone.example";
export const ROBIN = "robin.vale@example.org";
// People the chats name by a name alone. Their keys here are the set's own, for whom a fact is
// about; no moment shows them an address.
export const TESS = "tess.quill@named.example";
export const ARLO = "arlo.venn@named.example";
export const NAMES: Record<string, string> = {
  [LENA]: "Lena Park",
  [OMAR]: "Omar Reyes",
  [THEO]: "Theo Marsh",
  [NINA]: "Nina Cole",
  [FRANK]: "Frank Hart",
  [INES]: "Ines Ward",
  [ROBIN]: "Robin Vale",
  [TESS]: "Tess Quill",
  [ARLO]: "Arlo Venn",
  [EVAL_MOMENT_OWNER]: "Sam Harbor",
};

export const commitment = (subject: string, counterparty: string, what: string, due?: string): EvalMomentFact => ({
  type: "commitment",
  subject,
  counterparty,
  what,
  ...(due === undefined ? {} : { due }),
});
export const plan = (subject: string, counterparty: string, what: string, when: string): EvalMomentFact => ({
  type: "plan",
  subject,
  counterparty,
  what,
  when,
});
// The same, credited to `by`.
export const said = (by: string, fact: EvalMomentFact): EvalMomentFact => ({ ...fact, by });
// The person-fact types, as the meeting set writes them. A fact said in the subject's own line is
// credited to the subject (`own`); in a chat without turns, to nobody.
const side =
  (type: OwnerSideKind) =>
  (subject: string, domain: LifeDomain, phrase: string, more: Partial<EvalSideFact> = {}): EvalMomentFact => ({
    type,
    subject,
    domain,
    phrase,
    ...more,
  });
export const need = side("need");
export const capability = side("capability");
export const goal = side("goal");
export const constraint = side("constraint");
export const situation = side("situation");
export const prefers = (
  subject: string,
  domain: LifeDomain,
  phrase: string,
  more: Partial<EvalSideFact> = {},
): EvalMomentFact => side("preference")(subject, domain, phrase, { polarity: "prefers", ...more });
export const avoids = (
  subject: string,
  domain: LifeDomain,
  phrase: string,
  more: Partial<EvalSideFact> = {},
): EvalMomentFact => side("preference")(subject, domain, phrase, { polarity: "avoids", ...more });
export const role = (subject: string, title: string, organization?: string): EvalMomentFact => ({
  type: "role",
  subject,
  title,
  ...(organization === undefined ? {} : { organization }),
});
export const affiliation = (subject: string, relation: AffiliationRelation, organization: string): EvalMomentFact => ({
  type: "affiliation",
  subject,
  relation,
  organization,
});
export const relationship = (
  subject: string,
  counterparty: string,
  relation: RelationshipRelation,
  words: string,
): EvalMomentFact => ({ type: "relationship", subject, counterparty, relation, said: words });
export const own = (fact: EvalMomentFact): EvalMomentFact => ({ ...fact, by: fact.subject });

// A mail as a mail app shows it, with both addresses, so the people in it can be named.
export const mail = (from: string, to: string, lines: string[]): string =>
  `From: ${NAMES[from] ?? "Guest"} <${from}>\nTo: ${NAMES[to] ?? "Guest"} <${to}>\n\n${lines.join(" ")}`;
export const SIGN_OFF =
  "Thanks again for all the help this week, it really made a difference to how the whole thing came together.";

// One group of `texts`, each a mail moment of the thread `thread`, five minutes apart.
let serial = 0;
export function group(thread: string, texts: string[], expected: EvalMomentFact[]): EvalMomentGroup {
  serial += 1;
  const n = String(serial).padStart(2, "0");
  return {
    id: `moments-${n}`,
    moments: texts.map((text, at) => {
      // Within the Monday on the Mac's clock and in UTC: from 08:00, ten minutes a group and five
      // a moment, so up to 59 groups end by 17:55 on the Mac (22:55 UTC).
      const seen = `${START}T${String(8 + Math.floor(serial / 6)).padStart(2, "0")}:${String((serial % 6) * 10 + at * 5).padStart(2, "0")}:00-05:00`;
      return {
        kind: "moment",
        key: `moment:${ulidOf(`evaluation moment ${n} ${at}`)}`,
        revision: 0,
        observedAt: seen,
        endedAt: seen,
        app: { bundle: "test.example.mail", name: "Mail" },
        entity: "mail",
        thread,
        participants: [],
        text,
        read: "ax",
      };
    }),
    expected,
  };
}

// One chat moment of an app, its lines each the owner's (EVAL_MOMENT_OWNER), a participant's (by
// its address), the agent's (AGENT) or nobody's known (null) as Lens marks them; with `turns:
// false` it carries none, the current case. The participants are named and addressed, so they resolve.
export const AGENT = "agent";
const CHAT_APP = { bundle: "test.example.chat", name: "Chat" };
const AGENT_APP = { bundle: "test.example.agent", name: "Agent" };
export const CHAT_FILLER =
  "Anyway, the rest of the week looks busy but manageable, and the weather is meant to stay dry until Sunday at least.";
type Line = [string | null, string];
export function chat(
  thread: string,
  people: string[],
  lines: Line[],
  expected: EvalMomentFact[],
  options: { agentApp?: boolean; turns?: boolean } = {},
): EvalMomentGroup {
  const one = group(thread, [lines.map(([, text]) => text).join("\n")], expected);
  const item = one.moments[0] as MomentItem;
  const participants = people.map((address) => ({ name: NAMES[address] ?? "Guest", address }));
  let at = 0;
  const turns = lines.flatMap(([by, text]): MomentTurn[] => {
    const from = at;
    at += text.length + 1;
    if (by === null) return [];
    if (by === EVAL_MOMENT_OWNER) return [{ from, to: from + text.length, speaker: "owner" as const }];
    if (by === AGENT) return [{ from, to: from + text.length, speaker: "agent" as const }];
    return [{ from, to: from + text.length, speaker: "participant" as const, participant: people.indexOf(by) }];
  });
  const moment: MomentItem = {
    ...item,
    app: options.agentApp === true ? AGENT_APP : CHAT_APP,
    entity: "chat",
    participants,
    ...(options.turns === false ? {} : { turns }),
  };
  return { ...one, moments: [moment], ...(options.agentApp === true ? { agentApp: true } : {}) };
}

// A long conversation shaped like a real one that failed: the owner and people known by a name
// alone, the facts spread through chat that states none, sent as Lens sends a thread, each moment
// the lines new since the last, at most THREAD_MOMENT_CHARS code units and MOMENT_TURNS_MAX turns,
// every line's turn from the bubbles' layout. `chars` is the thread's length; the filler between
// facts is spoken by the people in turn.
const THREAD_MOMENT_CHARS = 3_900;
const THREAD_FILLER = [
  "haha yeah, that tracks",
  "wait, say more about that?",
  "ok that makes sense",
  "hmm, I'm not sure what to make of it",
  "what did you think of the panel on Tuesday?",
  "right, the second speaker kind of lost the room",
  "lol fair",
  "true, though it depends a lot on the timing",
  "sorry, one sec, someone's at the door",
  "back, where were we",
  "did you ever hear back from them about the event?",
  "no, not yet, it's been quiet all week",
  "funny how these things go",
  "yeah honestly",
  "that's a good question",
  "ha, exactly what I was thinking",
  "the weather has been so strange this week",
  "did you see the thread about the new office rules?",
  "oh man, yes, people were not happy",
  "anyway",
  "ok ok, go on",
  "interesting, I hadn't thought of it that way",
  "how was the drive back on Sunday?",
  "long, the traffic near the bridge was awful",
];
// The facts spread through `chars` code units of filler, spoken by the owner and the people in turn.
function withFiller(people: string[], facts: Line[], chars: number): Line[] {
  const speakers = [EVAL_MOMENT_OWNER, ...people];
  const lines: Line[] = [];
  let size = 0;
  let filler = 0;
  for (const [at, fact] of facts.entries()) {
    lines.push(fact);
    size += fact[1].length + 1;
    while (size < ((at + 1) * chars) / facts.length) {
      const line: Line = [
        speakers[filler % speakers.length] as string,
        THREAD_FILLER[filler % THREAD_FILLER.length] as string,
      ];
      filler += 1;
      lines.push(line);
      size += line[1].length + 1;
    }
  }
  return lines;
}

// The lines in moments as Lens sends a thread: at most THREAD_MOMENT_CHARS code units and
// MOMENT_TURNS_MAX turns a moment.
function chunked(lines: Line[]): Line[][] {
  const chunks: Line[][] = [[]];
  let chunk = 0;
  for (const line of lines) {
    const current = chunks[chunks.length - 1] as Line[];
    if (
      current.length > 0 &&
      (chunk + line[1].length + 1 > THREAD_MOMENT_CHARS || current.length >= MOMENT_TURNS_MAX)
    ) {
      chunks.push([line]);
      chunk = line[1].length + 1;
    } else {
      current.push(line);
      chunk += line[1].length + 1;
    }
  }
  return chunks;
}

export function thread(
  title: string,
  people: string[],
  facts: Line[],
  expected: EvalMomentFact[],
  chars: number,
  scenario: EvalMomentScenario,
): EvalMomentGroup {
  serial += 1;
  const n = String(serial).padStart(2, "0");
  const lines = withFiller(people, facts, chars);
  const chunks = chunked(lines);
  const participants = people.map((address) => ({ name: NAMES[address] ?? "Guest" }));
  const moments = chunks.map((part, at): MomentItem => {
    // Each thread in the afternoon on the Mac's clock, so its moments are on START in UTC too.
    const minutes = (title === "Founders" ? 16 : 15) * 60 + at * 5;
    const seen = `${START}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00-05:00`;
    let from = 0;
    const turns = part.map(([by, text]): MomentTurn => {
      const turn: MomentTurn =
        by === EVAL_MOMENT_OWNER
          ? { from, to: from + text.length, speaker: "owner" }
          : { from, to: from + text.length, speaker: "participant", participant: people.indexOf(by as string) };
      from += text.length + 1;
      return turn;
    });
    return {
      kind: "moment",
      key: `moment:${ulidOf(`evaluation moment ${n} ${at}`)}`,
      revision: 0,
      observedAt: seen,
      endedAt: seen,
      app: CHAT_APP,
      entity: "chat",
      thread: title,
      participants,
      text: part.map(([, text]) => text).join("\n"),
      read: "ax",
      turns,
    };
  });
  return {
    id: `moments-${n}`,
    moments,
    expected,
    bound: Object.fromEntries(people.map((address) => [NAMES[address] ?? "Guest", address])),
    scenario,
  };
}

// Messages read from chat.db, as Lens sends a session: one turn a message, the owner's or a
// participant's, each with its own time, the messages joined by line feeds, at most
// THREAD_MOMENT_CHARS a moment. The contacts are E.164 handles on 555 numbers with no name, each
// bound by the sync's step through a synthetic saved contact's phone (`bound`, by handle, to the
// contact's address). `earlyFirst`: the session's first line five hours before the rest, on the
// same day (every evaluation moment is seen on START), so a line's own time differs from the
// moment's end.
const HANDLES: Record<string, string> = {
  [LENA]: "+15555550301",
  [OMAR]: "+15555550302",
  [THEO]: "+15555550303",
  [NINA]: "+15555550304",
};
export function imessage(
  people: string[],
  facts: Line[],
  expected: EvalMomentFact[],
  chars: number,
  options: { title?: string; earlyFirst?: boolean } = {},
): EvalMomentGroup {
  serial += 1;
  const n = String(serial).padStart(2, "0");
  const lines = withFiller(people, facts, chars);
  const sorted = [...people].sort((a, b) => ((HANDLES[a] ?? "") < (HANDLES[b] ?? "") ? -1 : 1));
  const chunks = chunked(lines);
  let minute = 0;
  const moments = chunks.map((part, index): MomentItem => {
    // Each line a minute after the last, from 12:00 on the Mac's clock on START.
    const time = (offset: number): string => {
      const at = new Date(Date.parse(`${START}T12:00:00-05:00`) + offset * 60_000);
      return `${new Date(at.getTime() - 5 * 3_600_000).toISOString().slice(0, 19)}-05:00`;
    };
    let from = 0;
    const turns = part.map(([by, text], at): MomentTurn => {
      const when = index === 0 && at === 0 && options.earlyFirst === true ? time(-5 * 60) : time((minute += 1));
      const turn: MomentTurn =
        by === EVAL_MOMENT_OWNER
          ? { from, to: from + text.length, speaker: "owner", at: when }
          : {
              from,
              to: from + text.length,
              speaker: "participant",
              participant: sorted.indexOf(by as string),
              at: when,
            };
      from += text.length + 1;
      return turn;
    });
    return {
      kind: "moment",
      key: `moment:${ulidOf(`evaluation moment ${n} ${index}`)}`,
      revision: 0,
      observedAt: turns[0]?.at ?? time(0),
      endedAt: turns[turns.length - 1]?.at ?? time(0),
      app: { bundle: "com.apple.MobileSMS", name: "Messages" },
      entity: "chat",
      ...(options.title === undefined ? {} : { thread: options.title }),
      participants: sorted.map((address) => ({ handle: HANDLES[address] ?? "" })),
      text: part.map(([, text]) => text).join("\n"),
      read: "db",
      turns,
      source: "imessage",
      threadKey: `chat:${ulidOf(`evaluation thread ${n}`)}`,
    };
  });
  return {
    id: `moments-${n}`,
    moments,
    expected,
    bound: Object.fromEntries(people.map((address) => [HANDLES[address] ?? "", address])),
    scenario: "imessage",
  };
}

// A thread's sessions on several days, as the lane asks a thread's due days together: each session
// one moment of its own day (`day` after START), its lines a minute apart from 12:00 on the Mac's
// clock. No filler.
export function imessageDays(
  people: string[],
  sessions: { day: number; lines: Line[] }[],
  expected: EvalMomentFact[],
): EvalMomentGroup {
  serial += 1;
  const n = String(serial).padStart(2, "0");
  const sorted = [...people].sort((a, b) => ((HANDLES[a] ?? "") < (HANDLES[b] ?? "") ? -1 : 1));
  const moments = sessions.map(({ day, lines }, index): MomentItem => {
    const time = (minute: number): string =>
      `${new Date(Date.parse(`${dayAfter(day)}T12:00:00Z`) + minute * 60_000).toISOString().slice(0, 19)}-05:00`;
    let from = 0;
    const turns = lines.map(([by, text], at): MomentTurn => {
      const turn: MomentTurn =
        by === EVAL_MOMENT_OWNER
          ? { from, to: from + text.length, speaker: "owner", at: time(at) }
          : {
              from,
              to: from + text.length,
              speaker: "participant",
              participant: sorted.indexOf(by as string),
              at: time(at),
            };
      from += text.length + 1;
      return turn;
    });
    return {
      kind: "moment",
      key: `moment:${ulidOf(`evaluation moment ${n} ${index}`)}`,
      revision: 0,
      observedAt: time(0),
      endedAt: time(lines.length - 1),
      app: { bundle: "com.apple.MobileSMS", name: "Messages" },
      entity: "chat",
      participants: sorted.map((address) => ({ handle: HANDLES[address] ?? "" })),
      text: lines.map(([, text]) => text).join("\n"),
      read: "db",
      turns,
      source: "imessage",
      threadKey: `chat:${ulidOf(`evaluation thread ${n}`)}`,
    };
  });
  return {
    id: `moments-${n}`,
    moments,
    expected,
    bound: Object.fromEntries(people.map((address) => [HANDLES[address] ?? "", address])),
    scenario: "imessage",
  };
}
