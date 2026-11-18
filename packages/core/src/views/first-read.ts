import {
  APPLICATIONS_SHOWN,
  type ApplicationSign,
  type ApplicationState,
  type BeliefLine,
  type DeclineReason,
  type UntrustedString,
} from "@intelligence/contracts/personal";
import { dayIsOver, daysNamed, lastDayNamed } from "../own-dates.ts";
import { type Finding, namesPattern, reportedApplications, reportsOfSign } from "./agent-reports.ts";
import { titledDeadline } from "./open-items.ts";

// What leads a first read of the owner and what it computes. Pure, over rows the caller's token
// returned, so what the caller cannot see moves nothing. Every word served is the source's own; no
// model reads or writes any of this.

// The owner's own statement of a goal says it comes first. A pinned list of plain ways of saying it, in
// a statement they wrote; one it misses keeps the order it had.
const TOP_GOAL =
  /\b(?:number one|no\.? ?1|top|first|main|biggest|highest)\s+(?:goal|priority)\b|#1\s+(?:goal|priority)\b|\bmost important\s+(?:goal|priority|thing)\b/i;
// A statement that says it is not first says nothing of the kind.
const NOT_TOP = /\b(?:not|isn't|no longer|never)\b[^.!?]{0,24}$/i;
export const isTopGoal = (statement: string): boolean => {
  const found = TOP_GOAL.exec(statement);
  return found !== null && !NOT_TOP.test(statement.slice(0, found.index));
};

// The goal whose statement calls itself first, marked; then the owner's own order (`pi goal rank`, by
// `rankOf`), which is within a life domain, so it says nothing across domains and never outranks a goal
// they call first; the rest as given.
export function rankGoals<Goal extends { id?: string; statement: UntrustedString }>(
  goals: readonly Goal[],
  rankOf: ReadonlyMap<string, number> = new Map(),
): (Goal & { top?: true })[] {
  const place = (goal: Goal): number => rankOf.get(goal.id ?? "") ?? Number.POSITIVE_INFINITY;
  return goals
    .map((goal, index) => ({
      goal: isTopGoal(goal.statement.untrusted) ? { ...goal, top: true as const } : goal,
      index,
      place: place(goal),
    }))
    .sort((a, b) => {
      const first = Number("top" in b.goal) - Number("top" in a.goal);
      if (first !== 0) return first;
      return a.place === b.place ? a.index - b.index : a.place < b.place ? -1 : 1;
    })
    .map((one) => one.goal);
}

// Each state's wording in a subject line, tried in this order. A pinned list, general to anyone's mail,
// and deliberately narrow: mail about openings says "applications close" and "is hiring", which is no
// sign the owner applied. It can miss a confirmation worded otherwise.
const SUBJECT_STATES: readonly (readonly [ApplicationState, RegExp])[] = Object.freeze([
  [
    "closed",
    /\b(?:application|candidacy|role|position)\b.*\bnot\b.*\bmoving forward\b|\bnot\b.*\bmoving forward\b.*\b(?:application|candidacy|role|position)\b|\bregret to inform\b|\bwithdr[ae]w\w*\b.*\boffer\b|\boffer\b.*\bwithdrawn\b|\byour application\b.*\b(?:not|unsuccessful|declined|rejected)\b/i,
  ],
  // An update on an offer says nothing of which way it went: only its body can.
  ["offer", /\boffer letter\b|\byour offer (?:from|at|to join)\b/i],
  [
    "applied",
    /\bthanks? (?:you )?for (?:applying|your application)\b|\bapplication (?:received|submitted|confirmation|confirmed)\b|\breceived your application\b|\byou(?: have|'ve)? applied\b|\byour application (?:has been|was) (?:received|submitted)\b/i,
  ],
  [
    "in_progress",
    /\binterview (?:invitation|invite|request|scheduled|confirmation)\b|\binvit\w+ to (?:an? )?interview\b|\bschedule (?:an|your) interview\b|\byour application\b|\byour candidacy\b|\bupdate on your\b.{1,40}\boffer\b/i,
  ],
  ["deadline", /\bapplications? (?:deadline|due)\b|\bdeadline to apply\b|\bapply by\b/i],
]);
const SENT_APPLICATION = /\b(?:my|job) application\b|\bapplication (?:for|to)\b|\bapplying (?:for|to)\b/i;
const STATED_APPLICATION =
  /\b(?:applied (?:to|for)|applying (?:to|for)|application (?:to|for)|candidate for|candidacy)\b|(?<!\b(?:web|mobile|ios|android|desktop|software|phone|the)\s)\bapplication\s*(?:$|,|due\b|deadline\b|pending\b|submitted\b|in review\b)/i;
const STATED_KINDS: ReadonlySet<BeliefLine["kind"]> = new Set(["situation", "status", "goal"]);
export const isApplicationLine = (line: BeliefLine): boolean =>
  STATED_KINDS.has(line.kind) && STATED_APPLICATION.test(line.line.untrusted);
const ITEM_APPLICATION = /\b(?:applications?|apply|applying)\b/i;

export type ApplicationMessage = {
  id: string;
  subject: string;
  from: string | null;
  at: string;
  bulk: boolean;
  outbound: boolean;
  // Its own words say the thing ended (`saysEnded`), where the caller may read them.
  ended?: true;
};
export type ApplicationItem = {
  what: UntrustedString | null;
  due: string | null;
  source: { kind: string; id: string };
};

// What a message's subject says of an application: no sign is null. The caller reads a body only for
// a sign this finds.
export function subjectState(
  message: Pick<ApplicationMessage, "subject" | "bulk" | "outbound">,
): ApplicationState | null {
  if (message.outbound) return SENT_APPLICATION.test(message.subject) ? "applied" : null;
  const state = SUBJECT_STATES.find(([, wording]) => wording.test(message.subject))?.[0] ?? null;
  // A date to apply by in a mailing is an opening advertised, not one of the owner's.
  return state === "deadline" && message.bulk ? null : state;
}

// A body's own lines, above any quote of the mail before it, say the thing ended: a pinned list, as the
// subject's are. It can miss a refusal worded otherwise, and the sign then stays as its subject says.
const ENDED_BODY =
  /\b(?:no longer|unable to|not be|won['\u2019]?t be|will not|are not|not)\s+(?:able to\s+)?mov(?:e|ing) forward with\b|\bno longer able to\b[^.\n]{0,40}\bmove forward\b|\bregret to inform\b|\b(?:offer|application)\s+(?:has been|was|is)\s+(?:withdrawn|rescinded|cancelled|canceled)\b|\b(?:position|role)\s+has been\s+filled\b|\bdecided to (?:go|move) (?:forward )?with (?:another|other)\b/i;
const QUOTE_START = /^(?:>|On .*\bwrote:\s*$|-{2,}\s*(?:Original|Forwarded) |From:\s|_{5,}\s*$)/m;
const BODY_CODE_POINTS = 4000;
// What the writer wrote, above any quote of the mail before it.
export function ownWords(body: string): string {
  const quote = body.search(QUOTE_START);
  return (quote < 0 ? body : body.slice(0, quote)).slice(0, BODY_CODE_POINTS);
}
export const saysEnded = (body: string): boolean => ENDED_BODY.test(ownWords(body));

// The words that tell one application from another. One sender can carry several, so a later end takes
// only an earlier sign whose words stand inside its own, or the other way round. A subject of generic
// words alone names nothing: it ends an earlier offer, when it says offer, only if that sender's mail
// holds one offer, since a shared tracker's domain carries several employers'.
const GENERIC_SUBJECT = new Set(
  "your you our the and for from with update offer application applications applying applied role position thanks thank interview invitation invite candidacy not moving forward was has been letter withdrawn rescinded successful unsuccessful regret status decision fwd".split(
    " ",
  ),
);
// More words that name no one thing to a finding: an end of "Fellowship application" still ends its sign,
// and a finding that says "fellowship" is not thereby of that sign.
const NOT_A_SIGN_NAME = new Set([
  ...GENERIC_SUBJECT,
  ..."deadline due apply sunday monday tuesday wednesday thursday friday saturday situation goal candidate future lead program programme fellowship internship job summer winter spring fall jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august september october november december received next steps confirmation submitted submission analyst associate engineer manager intern director team".split(
    " ",
  ),
]);
const wordsOf = (subject: string, generic: ReadonlySet<string>): string[] =>
  subject
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !generic.has(word));
const namesOf = (subject: string): string[] => wordsOf(subject, GENERIC_SUBJECT);
const signNamesOf = (subject: string): string[] => wordsOf(subject, NOT_A_SIGN_NAME);
// A sentence that names nothing of its own: past its first word, no capitalized word that could name a thing. Pinned
// and English, like the rest; a name written in lower case reads as none.
const namesNothing = (sentence: string): boolean =>
  sentence
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
    .slice(1)
    .every((word) => !/^\p{Lu}/u.test(word) || NOT_A_SIGN_NAME.has(word.toLowerCase()) || word.length < 3);

function endsSign(
  end: { names: readonly string[]; offer: boolean },
  names: readonly string[],
  state: ApplicationState,
  offers: number,
) {
  if (end.names.length === 0) return end.offer && state === "offer" && offers <= 1;
  if (names.length === 0) return false;
  const inside = (a: readonly string[], b: readonly string[]): boolean => a.every((word) => b.includes(word));
  return inside(end.names, names) || inside(names, end.names);
}

const domainOf = (from: string | null): string => from?.slice(from.lastIndexOf("@") + 1).toLowerCase() ?? "";
const dayStart = (due: string): string => (due.length === 10 ? `${due}T00:00:00.000Z` : due);

// Every day a sign's words or date name, read against when it was said.
const signDays = (sign: ApplicationSign): string[] => [
  ...(sign.due === undefined ? [] : [sign.due.slice(0, 10)]),
  ...daysNamed(sign.what.untrusted, sign.at.slice(0, 10)),
];

// A deadline's day, from its date or its own words, read against when it was said.
function deadlineDay(sign: ApplicationSign): string | null {
  if (sign.due !== undefined) return sign.due.slice(0, 10);
  const said = sign.at.slice(0, 10);
  return titledDeadline(sign.what.untrusted, said) ?? lastDayNamed(sign.what.untrusted, said);
}

// A step toward something the owner said no to on a card, in the agent's words: its id, words, when and the code
// they gave, if any.
export type OwnerNo = { id: string; what: string; at: string; reason?: DeclineReason | null };

// How many signs only a finding gives, at most.
const REPORTED_SIGNS = 5;
// How many sentences are looked at for them: several can come to one row.
const REPORTED_READ = 20;

// The same subject from one domain counts once, its newest. A message whose own words ended it is `closed`, and
// an end takes earlier signs of the same thing from that domain with it. With `now`, a deadline whose day has
// gone says `passed`. With `findings`, a sign takes what agents reported of it, its state unmoved, and what only
// they report is listed as `reported`. With `ownerNoes`, a step the owner said no to that says application is
// listed as `owner_no`, which proves the no and not that they will not apply, or `step_handled` when the reason
// they gave was that it was already handled. The latest first, a date still ahead at the head, at most
// APPLICATIONS_SHOWN.
export function applicationSignsOf(input: {
  messages: readonly ApplicationMessage[];
  lines: readonly BeliefLine[];
  openItems: readonly ApplicationItem[];
  now?: Date;
  findings?: readonly Finding[];
  ownerNoes?: readonly OwnerNo[];
}): ApplicationSign[] {
  const signs: ApplicationSign[] = [];
  const seen = new Set<string>();
  const ended = new Map<string, { names: readonly string[]; offer: boolean }[]>();
  const offerSubjects = new Map<string, Set<string>>();
  for (const message of input.messages)
    if (subjectState(message) === "offer") {
      const domain = domainOf(message.from);
      offerSubjects.set(domain, (offerSubjects.get(domain) ?? new Set()).add(message.subject.toLowerCase()));
    }
  for (const message of [...input.messages].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))) {
    const said = subjectState(message);
    const state = message.ended === true && said !== null ? "closed" : said;
    const domain = domainOf(message.from);
    const key = `${domain}\n${message.subject.toLowerCase()}`;
    if (state === null || seen.has(key)) continue;
    seen.add(key);
    const names = namesOf(message.subject);
    const ends = ended.get(domain) ?? [];
    if (state !== "closed" && ends.some((end) => endsSign(end, names, state, offerSubjects.get(domain)?.size ?? 0)))
      continue;
    if (state === "closed") ended.set(domain, [...ends, { names, offer: /\boffer\b/i.test(message.subject) }]);
    signs.push({
      state,
      what: { untrusted: message.subject },
      ...(message.from === null ? {} : { from: { untrusted: message.from } }),
      at: message.at,
      message: message.id as ApplicationSign["message"] & string,
    });
  }
  for (const line of input.lines)
    if (isApplicationLine(line)) signs.push({ state: "stated", what: line.line, at: line.at, fact: line.fact });
  for (const item of input.openItems) {
    if (item.what === null || item.due === null || !ITEM_APPLICATION.test(item.what.untrusted)) continue;
    signs.push({
      state: "deadline",
      what: item.what,
      at: dayStart(item.due),
      due: item.due,
      ...(item.source.kind === "calendar"
        ? { event: item.source.id as ApplicationSign["event"] & string }
        : { fact: item.source.id }),
    });
  }
  for (const no of input.ownerNoes ?? [])
    if (ITEM_APPLICATION.test(no.what))
      signs.push({
        // A step closed as already handled says it was dealt with, which is the opposite of a refusal.
        state: no.reason === "already_handled" ? "step_handled" : "owner_no",
        what: { untrusted: no.what },
        at: no.at as ApplicationSign["at"],
        opportunity: no.id as ApplicationSign["opportunity"] & string,
        ...(no.reason === null || no.reason === undefined ? {} : { reason: no.reason }),
      });
  const { now } = input;
  const findings = input.findings ?? [];
  const named = signs.map((sign) => signNamesOf(sign.what.untrusted));
  const all = named.flat();
  const known = all.length === 0 ? () => false : (sentence: string) => namesPattern(all).test(sentence);
  const marked = signs.map((sign, index): ApplicationSign => {
    const day = sign.state === "deadline" && now !== undefined ? deadlineDay(sign) : null;
    const reported = reportsOfSign(findings, named[index] ?? []);
    return {
      ...sign,
      ...(day !== null && now !== undefined && dayIsOver(day, now) ? { passed: true as const } : {}),
      ...(reported.length === 0 ? {} : { reported }),
    };
  });
  // A sentence that names nothing can still be of a sign: the rest of its finding names it, which
  // reportedApplications reads, or it gives the day a sign's own words give. Two such sentences that give one
  // day are one row. The newest stands: findings come newest first. A sentence that names something stands.
  const signsDays = new Set(signs.flatMap(signDays));
  const daysTaken = new Set<string>();
  const onlyReported = reportedApplications(findings, known, REPORTED_READ, namesNothing)
    .flatMap((report): ApplicationSign[] => {
      const days = daysNamed(report.said.untrusted, report.at.slice(0, 10));
      if (namesNothing(report.said.untrusted)) {
        if (days.some((day) => signsDays.has(day) || daysTaken.has(day))) return [];
        for (const day of days) daysTaken.add(day);
      }
      const over = now !== undefined && days.length > 0 && days.every((day) => dayIsOver(day, now));
      return [
        {
          state: "reported",
          what: report.said,
          at: report.at,
          reported: [report],
          ...(over ? { passed: true as const } : {}),
        },
      ];
    })
    .slice(0, REPORTED_SIGNS);
  const newestFirst = (a: ApplicationSign, b: ApplicationSign): number => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
  const isNo = (sign: ApplicationSign): boolean => sign.state === "owner_no" || sign.state === "step_handled";
  const sourced = marked
    .filter((sign) => !isNo(sign))
    .sort(newestFirst)
    .slice(0, APPLICATIONS_SHOWN);
  // A no in an agent's words and what only a finding says take what room is left, so neither pushes a source's
  // sign off the list.
  const noes = marked.filter(isNo).sort(newestFirst);
  return [...sourced, ...noes, ...onlyReported].slice(0, APPLICATIONS_SHOWN);
}
