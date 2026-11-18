import { dayIn } from "@intelligence/contracts/personal";

// The bar a new mail or chat commitment passes. No model: a commitment's `what` is the passage's own
// slice, and this reads only its words and who code credits as its speaker. It refuses a remark, an
// ask and a promise credited the wrong way round. It knows English: a line in another language has
// none of these words, so only its length is judged, and not that where a script has no spaces. The
// lists stay small on purpose: a line they miss still lapses by its date or is closed by hand.

type CommitmentRefusal =
  | { reason: "not_a_promise"; issue: "no_object" | "remark" | "ask" | "hedged" | "conditional" }
  | { reason: "wrong_direction"; issue: "speaker_says_i" | "speaker_says_you" | "own_counterparty" };

const wordsIn = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[’']/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
const setOf = (words: string): ReadonlySet<string> => new Set(words.split(" "));

// What opens a line and says nothing of who acts.
const OPENERS = setOf("ok okay k sure yes yeah yep yup alright and so but then well hey hi");
const I_WORDS = setOf("i ill im id ive lemme");
const ASK_WORDS = setOf("please pls plz");
const ASK_VERBS = setOf("can could would will");
const YOU_WILL = setOf("youll youre");
// What the person spoken to will only receive: "You'll have the draft" is the speaker's to send.
const RECEIVES = setOf("have get receive hear");

// Words no action or object rests on: the frame of a promise, pronouns, where and when, and the
// objects that name nothing ("the rest", "it").
const FILLER = setOf(
  [
    "i ill im id ive lemme we well wed were lets let me my us our you youll youre your yours he hell she shell they theyll him her them his their",
    "it its this that these those the a an and or to for of in on at by with from up out back over about off",
    "be am is are was been will would can could shall should going gonna try just also do done doing",
    "there here now soon later beforehand today tonight tomorrow tmrw tmr week weekend morning afternoon evening night",
    "monday tuesday wednesday thursday friday saturday sunday second seconds sec minute minutes min moment bit time",
    "rest stuff thing things something anything everything care way know see",
  ].join(" "),
);
// A time of day is no object: "at 5", "5pm". A larger number is an amount, which is.
const CLOCK = /^(?:1[0-2]|[1-9])(?:am|pm)?$|^am$|^pm$/;
// What only expresses a feeling, or carries one to someone else.
const FEELING = setOf(
  "apologize apologise apologies sorry thanks thank thx congrats congratulate congratulations hope wish appreciate regards",
);
// A script written without spaces gives one long word, so length says nothing of it.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const CARRIES = setOf("tell say pass");
// A pronoun can be a promise's object: "I'll send it" is real when something says what it is.
const PRONOUNS = setOf("it that this them those these");
// A person is an object once a date says when: "I'll pay him Friday", not "I'll pay him".
const PEOPLE = setOf("you him her us");
const DOES = setOf("do doing");
// A date in the line's own words, beside the claim's `due`.
const WHEN = setOf("monday tuesday wednesday thursday friday saturday sunday tomorrow tmrw tmr tonight today");
// What in the words before says nothing of a thing: a reaction, or what follows "have a".
const REACTIONS = setOf(
  "sounds sound good great cool perfect awesome nice fine lovely happy wonderful day one night plan",
);
const GREETINGS = setOf("hi hey hello dear");
const ARTICLES = setOf("the a an your my our");
// A message's headers, which name people the promise is not about.
const HEADER = /^\s*(?:from|to|cc|bcc|subject|date)\s*:/i;
// How far back the words before may name the object.
const BEFORE_CHARS = 200;
// Where a promise starts, past a courtesy: "Thanks for the intro, will send the deck". A leading
// "will" counts only at a clause's head. "well" is too common to read as "we'll" with no apostrophe.
const PROMISE_AT =
  /\bi['\u2019]?ll\b|\bi will\b|\bi can\b(?!['\u2019]t)|\bwe['\u2019]ll\b|\bwe will\b|(?<=^|[.,;:!?\n]\s*)will\b/iu;

// What, before a promise's verb, says it may not happen: "I'll probably send it". Past the verb it
// hedges a detail: "I'll send it, probably Friday".
const HEDGES = setOf("prob probably maybe perhaps possibly");
const PROMISE_FRAME = setOf("i ill im id ive we well wed will can just");
// A standby that waits on a need no one has shown: "we'll write to you if changes are necessary". Words
// before it in another clause make it a side remark: "I'll send it Friday, tell me if more is needed".
const STANDBY = /\bif\b[^.!?\n]*\b(?:necessary|needed|required)\b/iu;
const OTHER_CLAUSE = /[.,;!?\n]|\band\b/iu;
// Where a clause ends, and the reason or moment that may trail a look.
const CLAUSE_END = /[.!?\n]/u;
const TRAILING = /\s(?:when|once|cause|because|cuz|since)\b.*$/iu;
// Words that name no object when nothing else in the clause does: "I'll take a look", "I'll see what
// I can get done". What each is about, when the clause says, is left standing.
const LOOKS = setOf("take have go look");
const SEEKS = setOf("what get find");

const counted = (text: string): string[] =>
  wordsIn(text).filter((word) => !FILLER.has(word) && !OPENERS.has(word) && !CLOCK.test(word));

// Whether a clause names an object of its own. A look's moment or reason is no object of the look.
function clauseHasObject(clause: string): boolean {
  if (counted(clause).includes("look")) return counted(clause.replace(TRAILING, "")).some((word) => !LOOKS.has(word));
  if (/\bsee what\b/iu.test(clause)) return counted(clause).some((word) => !SEEKS.has(word));
  return counted(clause).length > 0;
}

// Whether a standby's condition is all the line promises.
function isStandby(what: string): boolean {
  const at = what.search(STANDBY);
  return at >= 0 && !OTHER_CLAUSE.test(what.slice(0, at));
}

// Who the line's own words say will act, past any opener: the speaker, the person spoken to, or an
// ask of them.
function voiceOf(words: readonly string[]): "i" | "you" | "ask" | null {
  const at = words.findIndex((word) => !OPENERS.has(word));
  if (at < 0) return null;
  const [first, second] = [words[at] as string, words[at + 1]];
  if ((ASK_WORDS.has(first) && second !== "note") || (ASK_VERBS.has(first) && second === "you")) return "ask";
  if (I_WORDS.has(first) || (first === "let" && second === "me")) return "i";
  const verbAt = YOU_WILL.has(first) ? at + 1 : first === "you" && second === "will" ? at + 2 : -1;
  if (verbAt < 0) return null;
  const [verb, next] = [words[verbAt], words[verbAt + 1]];
  return verb !== undefined && RECEIVES.has(verb) && next !== "to" ? null : "you";
}

// Whether the words before name a thing a pronoun can stand for: an article and a noun ("the signed
// lease"), or a name, a capital that opens no clause. A clause of thanks or greeting names nothing.
// Words alone are not enough: "Love you both. Happy birthday!" has plenty and names nothing.
function namesAThing(before: string): boolean {
  for (const line of before.slice(-BEFORE_CHARS).split("\n")) {
    if (HEADER.test(line)) continue;
    for (const clause of line.split(/[.,;:!?]+/)) {
      const said = clause.split(/[^\p{L}\p{N}'\u2019]+/u).filter((word) => word !== "");
      const words = said.map((word) => word.toLowerCase().replace(/['\u2019]/gu, ""));
      if (words.some((word) => FEELING.has(word)) || GREETINGS.has(words[0] ?? "")) continue;
      const counts = (word: string): boolean => !FILLER.has(word) && !OPENERS.has(word) && !CLOCK.test(word);
      for (const [at, word] of words.entries()) {
        if (ARTICLES.has(word)) {
          const noun = words.slice(at + 1).find((one) => !REACTIONS.has(one));
          if (noun !== undefined && counts(noun)) return true;
        }
        if (at > 0 && /^\p{Lu}/u.test(said[at] as string) && counts(word)) return true;
      }
    }
  }
  return false;
}

// Whether a promise with one word of action and a pronoun for its object says what it means: a date,
// or for a thing, words just before it that name it. A person named in the line needs no rule here:
// that is already an object. A person stands only on a due day after the line's own: "I'll call you in
// a sec", dated the day it was said, is over before anything could act on it. The model dates `due`
// from the line's time, shown to it in UTC, or by the owner's clock where the words give it away. So
// the line's day is the earlier of its UTC date and its date in the owner's zone: a due on or before
// that is on or before the line's day by either reading, and a "tomorrow" said in the evening west of
// UTC, dated the owner's next day, is kept. With no zone set it is the UTC date.
export function lineDay(said: string, zone: string | null): string | null {
  const at = new Date(said);
  if (!Number.isFinite(at.getTime())) return null;
  const utc = dayIn(at, null);
  const local = zone === null ? utc : dayIn(at, zone);
  return local < utc ? local : utc;
}
function pronounStands(
  words: readonly string[],
  content: readonly string[],
  due: unknown,
  before: string,
  day: string | null,
): boolean {
  const dated = typeof due === "string" || words.some((word) => WHEN.has(word));
  const sameDay = typeof due === "string" && day !== null && due.slice(0, 10) <= day;
  if (dated && !sameDay && content.length === 1 && words.some((word) => PEOPLE.has(word))) return true;
  if (!words.some((word) => PRONOUNS.has(word))) return false;
  if (content.length === 0 && !words.some((word) => DOES.has(word))) return false;
  return dated || namesAThing(before);
}

export function commitmentRefusal(claim: {
  what: string;
  subject: string;
  counterparty: unknown;
  // Who code credits as the words' speaker, if anyone.
  speaker: string | undefined;
  due?: unknown;
  // The passage's words before the `what`.
  before?: string;
  // When the line was said, an ISO timestamp, and the owner's time zone, null while unset.
  said?: string;
  zone?: string | null | undefined;
}): CommitmentRefusal | null {
  const day = claim.said === undefined ? null : lineDay(claim.said, claim.zone ?? null);
  // An ask stays an ask, whatever it goes on to say.
  if (voiceOf(wordsIn(claim.what)) === "ask") return { reason: "not_a_promise", issue: "ask" };
  // A promise after a courtesy is the promise: "Thanks, I'll send the lease".
  const promised = PROMISE_AT.exec(claim.what);
  const words = wordsIn(promised === null ? claim.what : claim.what.slice(promised.index));
  const voice = voiceOf(words);
  if (voice === "ask") return { reason: "not_a_promise", issue: "ask" };
  const content = words.filter((word) => !FILLER.has(word) && !OPENERS.has(word) && !CLOCK.test(word));
  const [head] = content;
  if (head !== undefined && (FEELING.has(head) || (CARRIES.has(head) && content.some((word) => FEELING.has(word)))))
    return { reason: "not_a_promise", issue: "remark" };
  if (HEDGES.has(words.find((word) => !PROMISE_FRAME.has(word)) ?? ""))
    return { reason: "not_a_promise", issue: "hedged" };
  if (isStandby(claim.what)) return { reason: "not_a_promise", issue: "conditional" };
  if (
    content.length < 2 &&
    !UNSPACED.test(claim.what) &&
    !pronounStands(words, content, claim.due, claim.before ?? "", day)
  )
    return { reason: "not_a_promise", issue: "no_object" };
  // The talk after a promise lends it no object: "I'll do that. Fair enough". A later promise can have
  // one, "Will do. I'll send the deck", and all the line's words can say what a pronoun stands for:
  // "I'll do it once the deck is in". A line with no "I'll" to start from is not judged by clause: "Yes!
  // We're on it and will write back about the contract" begins with an answer.
  if (promised !== null && !UNSPACED.test(claim.what)) {
    const promise = claim.what.slice(promised.index);
    const promises = promise.split(CLAUSE_END).filter((clause) => PROMISE_AT.test(clause));
    if (!promises.some(clauseHasObject)) {
      const named = counted(promises[0] ?? promise);
      const before = `${claim.before ?? ""}\n${promise.replace(/^[^.!?\n]*\s/u, "")}`;
      if (!pronounStands(words, named, claim.due, before, day)) return { reason: "not_a_promise", issue: "no_object" };
    }
  }
  if (claim.subject === claim.counterparty) return { reason: "wrong_direction", issue: "own_counterparty" };
  if (claim.speaker !== undefined) {
    if (voice === "i" && claim.subject !== claim.speaker) return { reason: "wrong_direction", issue: "speaker_says_i" };
    if (voice === "you" && claim.subject === claim.speaker)
      return { reason: "wrong_direction", issue: "speaker_says_you" };
  }
  return null;
}
