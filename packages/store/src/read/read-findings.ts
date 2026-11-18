import { DAY_MS } from "@intelligence/personal-core";
import { type Finding, namesPattern } from "@intelligence/personal-core/views";
import { stamp } from "../core/db.ts";
import type { Ctx } from "../core/read-ctx.ts";
import { CORRECTED } from "../core/visibility.ts";
import { type RecordRow, recordItem } from "./read-pack-items.ts";

// Every row is one the caller's token returns and its masked text is what the caller would be served,
// so what it cannot see moves nothing and a masked value is no oracle. A corrected record is left out,
// as a pack leaves it out. Only a client that could read these words already is given them, a function
// of its registration: the Self view, and a tool that serves records, or a pack whose notes do.

// How many of the newest records one call opens, and how far back they count.
const FINDINGS_SCAN = 100;
const FINDINGS_DAYS = 30;

const SERVES_RECORDS: readonly string[] = ["read_record", "find_records", "build_context_pack"];
// What a client's registration lets `next` and its signs read: never the owner's data, the
// registration alone decides it.
export const readsBodies = (mail: boolean, tools: readonly string[]): boolean => mail && tools.includes("read_message");
export const nextAccess = (views: readonly string[], tools: readonly string[]) => ({
  mail: views.includes("people"),
  bodies: readsBodies(views.includes("people"), tools),
  tasks: views.includes("work") && tools.includes("list_opportunities"),
});

export const readsFindings = (views: readonly string[], tools: readonly string[]): boolean =>
  views.includes("self") && tools.some((tool) => SERVES_RECORDS.includes(tool));

// A pack's NOTES_LEFT_OUT, kept to the window so the read does not grow with every record ever written.
const RECENT_NOTES = `
  select w.id, w.kind, w.client_name, w.created_at, w.compartments, w.body_enc, w.project_id
  from ledger.agent_writes w
  where w.kind in ('note', 'finding') and w.body_enc is not null and w.created_at >= $2
    and not ${CORRECTED}
  order by w.created_at desc, w.id
  limit $1`;

export async function recentFindings(ctx: Ctx, now: Date): Promise<Finding[]> {
  const since = new Date(now.getTime() - FINDINGS_DAYS * DAY_MS).toISOString();
  const rows = await ctx.run<RecordRow & { project_id?: string | null }>(RECENT_NOTES, [FINDINGS_SCAN, since]);
  return rows.flatMap((row) => {
    const item = recordItem(ctx, row, "notes", false, undefined);
    const text = item?.kind === "record" ? item.record.body?.untrusted : undefined;
    if (text === undefined) return [];
    const filed = row.project_id === null || row.project_id === undefined ? {} : { project: row.project_id };
    return [{ id: row.id, client: row.client_name, at: stamp(row.created_at), text, ...filed }];
  });
}

const AFTER_A_SUBJECT =
  /^(?:['\u2019]s\b|,|\s+(?:is|was|has|had|will|would|said|says|asked|asks|replied|replies|wrote|writes|sent|sends|moved|moves|confirmed|confirms|agreed|agrees|offered|offers|proposed|proposes|wants|wanted|needs|needed|called|calls|emailed|emails|met|meets|works|worked|joined|joins)\b)/u;
// A sentence that lists short things after a colon ("Delivered today: a, b, c, d") says nothing about any one
// of them. A person named before the colon is its subject. Brackets are left out, as a person's details are
// often in them, and a colon inside a time is none.
const LIST_ITEMS = 4;
const LIST_ITEM_WORDS = 6;
function listedIn(sentence: string, at: readonly number[]): boolean {
  const colon = sentence.lastIndexOf(": ");
  if (colon < 0 || at.some((index) => index < colon)) return false;
  const items = sentence
    .slice(colon + 2)
    .replace(/\([^)]*\)/g, " ")
    .split(/[,;]/);
  return (
    items.length >= LIST_ITEMS &&
    items.every((item) => item.trim() !== "" && item.trim().split(/\s+/).length <= LIST_ITEM_WORDS)
  );
}

// Capitalized runs of two words or more, which is how a finding writes a full name. What reads as a date, or a
// run of capitals such as a time zone, is none.
const NAME_RUN = /(?<![\p{L}\p{N}])\p{Lu}\p{Ll}[\p{L}'\u2019-]*(?:\s+\p{Lu}\p{Ll}[\p{L}'\u2019-]*)+/gu;
const NO_NAME_WORD =
  /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
const SEVERAL_OTHERS = 3;
// Words that make a person the far end of what the sentence's subject did. "With" and "for" do not: a call with
// someone is theirs too.
const AFTER_A_PREPOSITION = /\b(?:from|by|to|via|cc)\s+$/i;
const VERB_AFTER_A_NAME = /^\s+\p{Ll}/u;
const PREPOSITION_NEXT = /^\s+(?:from|by|to|with|of|about|for|at|via|on|in)\b/i;

const capitalized = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

// A person's name, whole words: the name as held, or an address, in any case. One word alone can be an
// ordinary word ("Will"), so it counts only with a capital, and can be someone else's first name, so
// not when a capitalized word follows that is none of this person's. Opening a sentence the capital says
// nothing ("Mark the card as done"), so there it counts only as the subject of a verb of what people do,
// or a possessive. At least three letters.
//
// And the sentence must be about them, as far as code can tell: not only in a list, three other names or more
// is someone else's news, and so is one opened by another person with this one only at the far end of what
// they did ("A B holds ... from this person"). Naming a second person stays: "C emailed: this person has moved".
export function namesTest(names: readonly string[], addresses: readonly string[]): (sentence: string) => boolean {
  const usable = names.map((name) => name.trim()).filter((name) => name.length >= 3);
  const whole = [...usable.filter((name) => /\s/.test(name)), ...addresses.filter((one) => one.includes("@"))];
  const single = usable.filter((name) => !/\s/.test(name)).map(capitalized);
  const anyCase = whole.length === 0 ? null : new RegExp(namesPattern(whole).source, "giu");
  const theirWords = new Set(usable.flatMap((name) => name.toLowerCase().split(/[^\p{L}\p{N}]+/u)));
  const first =
    single.length === 0 ? null : new RegExp(`${namesPattern(single).source}(?:[\\s]+(\\p{Lu}[\\p{L}\\p{N}]*))?`, "gu");
  const mentions = (sentence: string): number[] => [
    ...(anyCase === null ? [] : [...sentence.matchAll(anyCase)].map((found) => found.index)),
    ...(first === null
      ? []
      : [...sentence.matchAll(first)].flatMap((found) => {
          const next = found[1];
          if (found.index === 0 && !AFTER_A_SUBJECT.test(sentence.slice(found[0].length)) && next === undefined)
            return [];
          return next === undefined || theirWords.has(next.toLowerCase()) ? [found.index] : [];
        })),
  ];
  const isOthers = (run: string): boolean =>
    run.split(/\s+/).every((word) => !theirWords.has(word.toLowerCase()) && !NO_NAME_WORD.test(word));
  return (sentence) => {
    const at = mentions(sentence);
    if (at.length === 0 || listedIn(sentence, at)) return false;
    const others = new Set([...sentence.matchAll(NAME_RUN)].map((found) => found[0]).filter(isOthers));
    if (others.size >= SEVERAL_OTHERS) return false;
    const opening = [...sentence.matchAll(NAME_RUN)].find((found) => found.index === 0);
    if (opening === undefined || !isOthers(opening[0])) return true;
    const after = sentence.slice(opening[0].length);
    const opensWithAnother = VERB_AFTER_A_NAME.test(after) && !PREPOSITION_NEXT.test(after);
    return !opensWithAnother || !at.every((index) => AFTER_A_PREPOSITION.test(sentence.slice(0, index)));
  };
}
