import { AGENT_REPORTS_SHOWN, type AgentReport, dayIn, type OpenItem } from "@intelligence/contracts/personal";
import { daysNamed } from "../own-dates.ts";

// What agents' findings say beside the structured fields. Pure, over findings the caller's token
// returned. A finding is a model's words, so nothing here moves a state, a date or a status: it only
// sets a sentence, marked unconfirmed and naming its record, beside the field. A reply closes nothing,
// and neither does this. Matching is by whole words in the masked text, pinned and English, so it can
// miss a finding worded otherwise, or set one beside a field it is not about; either way the field
// stands, and the record says what the agent meant.

export type Finding = { id: string; client: string; at: string; text: string; project?: string };

// A row of a list takes the newest report alone: fifteen items and fifteen signs would otherwise hold
// ninety sentences on one page.
const REPORTS_ON_A_LIST_ROW = 1;
// A sentence served beside a field, at most this many code points.
const SAID_CODE_POINTS = 240;
const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<!\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Dr|Mr|Mrs|Ms|Prof|St)\.)(?<=[.!?])\s+|\n+/u)
    .map((one) => one.trim())
    .filter((one) => one !== "");

const report = (finding: Finding, sentence: string): AgentReport => {
  const points = [...sentence];
  return {
    said: {
      untrusted: points.length <= SAID_CODE_POINTS ? sentence : `${points.slice(0, SAID_CODE_POINTS - 1).join("")}…`,
    },
    record: finding.id as AgentReport["record"],
    client: finding.client,
    at: finding.at as AgentReport["at"],
    unconfirmed: true,
  };
};

// The first sentence of each finding that `matches`, newest finding first, at most `most`.
function reportsWhere(
  findings: readonly Finding[],
  matches: (sentence: string, finding: Finding) => boolean,
  most: number = AGENT_REPORTS_SHOWN,
): AgentReport[] {
  const newest = [...findings].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1));
  const reports: AgentReport[] = [];
  for (const finding of newest) {
    const sentence = sentencesOf(finding.text).find((one) => matches(one, finding));
    if (sentence !== undefined) reports.push(report(finding, sentence));
    if (reports.length === most) break;
  }
  return reports;
}

// A person, by a test of their names.
export const reportsNaming = (findings: readonly Finding[], names: (sentence: string) => boolean): AgentReport[] =>
  reportsWhere(findings, names);

// A sentence says where a project stands only with one of these words. Pinned English: a date on something else
// ("the log is due Sunday") and advice with the name in it say nothing of its state.
const SAYS_STATE =
  /\b(?:shipp?(?:ed|ing)|launch(?:ed|ing)|released?|deployed|merged|built|building|finished|completed?|done|started|paused|stalled|blocked|on hold|in progress|delayed|behind|ahead|ready|live|signed|closed|cancell?ed|dropped|decided|agreed|raised|won|lost|moved|waiting on|pending|testing|next step)\b/i;
// A sentence is about a project when its name begins in its first words: past those, the name is in passing.
const ABOUT_WITHIN_WORDS = 4;
const wordsIn = (text: string): string[] => text.trim().split(/\s+/u);
const headOf = (sentence: string, name: string): string =>
  wordsIn(sentence)
    .slice(0, ABOUT_WITHIN_WORDS + wordsIn(name).length - 1)
    .join(" ");

// A project's: the first sentence of each finding that says a state, and is filed under it or names it in its first
// words. It can miss one worded otherwise; the record stands either way.
export const reportsOfProject = (
  findings: readonly Finding[],
  project: string,
  name: string,
  names: (sentence: string) => boolean,
): AgentReport[] =>
  reportsWhere(
    findings,
    (sentence, finding) => SAYS_STATE.test(sentence) && (finding.project === project || names(headOf(sentence, name))),
  );

// Words that say a dated thing changed.
const SAYS_CHANGED =
  /\b(?:moved?|moving|reschedul\w*|postpon\w*|pushed|cancel\w*|called off|no longer|decided not|withdr[ae]w\w*|changed)\b/i;

// An open item: a sentence that names the item's own day and says it changed. Beside the item it is said
// of, whatever the item's words: an item's line can be as short as "that works", and code cannot read
// which call a finding means from that.
export function reportsOfDay(findings: readonly Finding[], day: string): AgentReport[] {
  return reportsWhere(
    findings,
    (sentence, finding) => SAYS_CHANGED.test(sentence) && daysNamed(sentence, finding.at.slice(0, 10)).includes(day),
    REPORTS_ON_A_LIST_ROW,
  );
}

// A meeting: a sentence that says it changed and names its day or a person at it, by a whole name or
// a first name. Whole words, pinned and English, as the rest here; it can set a sentence beside the wrong
// meeting, marked, and the meeting stands as its calendar says.
export function reportsOfMeeting(
  findings: readonly Finding[],
  meeting: { day: string; names: readonly string[] },
): AgentReport[] {
  const whole = meeting.names.length === 0 ? null : namesPattern(meeting.names);
  // A first name only as written, so "will" and "mark" in a sentence are nobody.
  const firsts = meeting.names
    .flatMap((name) => name.trim().split(/\s+/u).slice(0, 1))
    .filter((one) => one.length >= 3);
  const first = firsts.length === 0 ? null : new RegExp(namesPattern(firsts).source, "u");
  return reportsWhere(
    findings,
    (sentence, finding) =>
      SAYS_CHANGED.test(sentence) &&
      (daysNamed(sentence, finding.at.slice(0, 10)).includes(meeting.day) ||
        whole?.test(sentence) === true ||
        first?.test(sentence) === true),
    REPORTS_ON_A_LIST_ROW,
  );
}

// A person's next meeting: a sentence that names them and its day and says it changed. It moves no slot; it
// says not to read the slot as firm.
export function reportsOfPersonsMeeting(
  findings: readonly Finding[],
  day: string,
  names: (sentence: string) => boolean,
): AgentReport[] {
  return reportsWhere(
    findings,
    (sentence, finding) =>
      names(sentence) && SAYS_CHANGED.test(sentence) && daysNamed(sentence, finding.at.slice(0, 10)).includes(day),
    REPORTS_ON_A_LIST_ROW,
  );
}

// Each item with what agents reported of its day. An item with no date has nothing to match.
export function withItemReports<Item extends Pick<OpenItem, "due" | "remindAt" | "reported">>(
  items: readonly Item[],
  findings: readonly Finding[],
  zone: string | null,
): Item[] {
  if (findings.length === 0) return [...items];
  return items.map((item) => {
    const dated = item.due ?? item.remindAt ?? null;
    if (dated === null) return item;
    const day = dated.length === 10 ? dated : dayIn(new Date(dated), zone);
    const reported = reportsOfDay(findings, day);
    return reported.length === 0 ? item : { ...item, reported };
  });
}

// A sentence that says the owner is or is not applying, or gives a deadline to. Pinned and narrow: "should
// apply" and "applications close" say nothing of what they did, and "was applied to the thread" and
// "Rhea applied to" are no application of the owner's: it opens the sentence, or a pronoun or "the owner"
// says it.
const SAYS_APPLYING =
  /^(?:applying|applied)\s+(?:for|to)\b|\b(?:owner|he|she|they|i)\b(?:\s+(?:is|are|am|has|have|had|was|were|also|now|already|just|currently))*\s+(?:applying|applied)\s+(?:for|to)\b|\bdecided\s+not\s+to\s+apply\b|\bnot\s+applying\b|\bwithdr[ae]w\w*\s+(?:the\s+|an?\s+|their\s+|his\s+|her\s+)?application\b|\bapplication\b[^.]{0,80}\bdeadline\b|\bdeadline\b[^.]{0,80}\b(?:apply|application)\b/i;
const saysApplying = (sentence: string): boolean => SAYS_APPLYING.test(sentence);

// What is only reported, for `reported` signs: the sentences saying so that `known` did not take. A finding is one
// piece of work, so a sentence that names nothing (`nameless`) is of what the rest of its finding names, if that is
// known. A sentence that names something else stands.
export function reportedApplications(
  findings: readonly Finding[],
  known: (sentence: string) => boolean,
  most: number,
  nameless: (sentence: string) => boolean = () => false,
): AgentReport[] {
  return reportsWhere(
    findings,
    (sentence, finding) => saysApplying(sentence) && !known(sentence) && !(nameless(sentence) && known(finding.text)),
    most,
  );
}

// What is reported of one sign: a sentence saying so that holds one of its names.
export function reportsOfSign(findings: readonly Finding[], names: readonly string[]): AgentReport[] {
  if (names.length === 0) return [];
  const pattern = namesPattern(names);
  return reportsWhere(findings, (sentence) => saysApplying(sentence) && pattern.test(sentence), REPORTS_ON_A_LIST_ROW);
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const namesPattern = (names: readonly string[]): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escaped).join("|")})(?![\\p{L}\\p{N}])`, "iu");
