import {
  type DecisionPointCall,
  type FactGrouping,
  type FactRuling,
  type GroupingMode,
  KEY_FIELDS,
  keyPhraseOf,
  LIFE_DOMAINS,
  type LifeDomain,
  type OwnerSideKind,
  PAIR_CALLS_PER_RUN,
  PAIR_KEYS,
  type Rung2Output,
  ULID_PATTERN,
} from "@intelligence/contracts/personal";
import { normal } from "@intelligence/personal-beliefs";
import { keyPhrase, polarPhrase } from "@intelligence/personal-core";
import { phraseSimilarity, SAME_FACT_SIMILARITY } from "@intelligence/personal-core/checks";
import { cutPassage, strongCite } from "./cite.ts";

// The same-fact sweep's rules. Which pairs are asked, rung 0, the `pair` slot, the check of the extract
// model's citations, the check code makes of every answer, and the fact_grouping row each answer becomes.
// Pure but for the climb and the model calls its caller hands in, so this package needs neither the ladder
// nor the model port (`pi extract` wires both). Nothing here writes a fact key, a label or a tier: a row
// names two fact keys code chose, and the audience and compartments code read.

// One belief an audience holds, as the grouping store reads it: its fact key fingerprint, its
// subject and type, its label, and the newest of its supporting claims, by valid time then id:
// that claim's typed fields, its passage (null when the store keeps none), its evidence id and,
// when the store gives it, its own id, which the judgment names.
export type SameFactBelief = {
  fp: string;
  subject: string;
  type: string;
  compartments: string[];
  at: string;
  fields: Readonly<Record<string, unknown>>;
  passage: string | null;
  evidence: string;
  claim?: string;
};

// `text` is the key phrase as the claim gives it, the words a model is shown.
type SameFactKey = SameFactBelief & {
  kind: OwnerSideKind;
  domain: LifeDomain | null;
  polarity: "prefers" | "avoids" | null;
  phrase: string;
  text: string;
};

// Two keys of one audience, `a` the lower fingerprint, and the keyed call's subject.
export type SameFactPair = { audience: string[]; a: SameFactKey; b: SameFactKey; subject: string };

const POLARITY: Readonly<Record<string, "prefers" | "avoids">> = {
  prefers: "prefers",
  likes: "prefers",
  avoids: "avoids",
  dislikes: "avoids",
};
const isDomain = (value: unknown): value is LifeDomain =>
  typeof value === "string" && (LIFE_DOMAINS as readonly string[]).includes(value);
const isKind = (type: string): type is OwnerSideKind => Object.hasOwn(KEY_FIELDS, type);

// A belief as the candidate rule reads it, or null for one it never pairs: a kind that is not
// owner-side, or a key phrase that normalizes to nothing. A preference's polarity counts version
// 3's synonyms as version 4's, and a leading negation turns `prefers` into `avoids`.
export function sameFactKey(belief: SameFactBelief): SameFactKey | null {
  if (!isKind(belief.type)) return null;
  const text = keyPhraseOf(belief.type, belief.fields);
  if (text === undefined) return null;
  let polarity: SameFactKey["polarity"] = null;
  let phrase: string;
  if (belief.type === "preference") {
    const given = POLARITY[String(belief.fields.polarity ?? "")] ?? null;
    const polar = polarPhrase(text);
    polarity = polar.negated && given === "prefers" ? "avoids" : given;
    phrase = polar.phrase;
  } else phrase = keyPhrase(text);
  if (phrase === "") return null;
  const domain = isDomain(belief.fields.domain) ? belief.fields.domain : null;
  return { ...belief, kind: belief.type, domain, polarity, phrase, text };
}

const factsSubject = (a: string, b: string): string => (a < b ? `facts:${a}:${b}` : `facts:${b}:${a}`);

// Newest first, then by fingerprint, so the order never depends on the order rows were read in.
const newestFirst = (x: SameFactKey, y: SameFactKey): number =>
  x.at !== y.at ? (x.at > y.at ? -1 : 1) : x.fp < y.fp ? -1 : x.fp > y.fp ? 1 : 0;
const sameGroup = (key: SameFactKey): string =>
  [key.subject, key.kind, key.domain ?? "", key.polarity ?? ""].join("\u0000");
const later = (pair: SameFactPair): string => (pair.a.at > pair.b.at ? pair.a.at : pair.b.at);

// Two keys it sees of one subject, one owner-side kind, one domain or none, and one polarity, among the
// PAIR_KEYS newest of that group, whose key phrases are equal or at least SAME_FACT_SIMILARITY alike.
// Newest pair first. A key the audience does not hold is not in `beliefs`, so it changes neither which
// keys are the newest nor any pair.
export function candidatePairs(audience: readonly string[], beliefs: readonly SameFactBelief[]): SameFactPair[] {
  const groups = new Map<string, SameFactKey[]>();
  for (const belief of beliefs) {
    const key = sameFactKey(belief);
    if (key === null) continue;
    groups.set(sameGroup(key), [...(groups.get(sameGroup(key)) ?? []), key]);
  }
  const pairs: SameFactPair[] = [];
  for (const group of groups.values()) {
    const newest = [...group].sort(newestFirst).slice(0, PAIR_KEYS);
    for (const [i, x] of newest.entries()) {
      for (const y of newest.slice(i + 1)) {
        if (x.fp === y.fp) continue;
        if (x.phrase !== y.phrase && phraseSimilarity(x.phrase, y.phrase) < SAME_FACT_SIMILARITY) continue;
        const [a, b] = x.fp < y.fp ? [x, y] : [y, x];
        pairs.push({ audience: [...audience], a, b, subject: factsSubject(a.fp, b.fp) });
      }
    }
  }
  return pairs.sort((x, y) =>
    later(x) !== later(y) ? (later(x) > later(y) ? -1 : 1) : x.subject < y.subject ? -1 : x.subject > y.subject ? 1 : 0,
  );
}

const holds = (outer: readonly string[], inner: readonly string[]): boolean =>
  inner.every((one) => outer.includes(one));

// The owner's ruling on the pair that counts in this audience. A split outranks a join, and binds
// every audience, whatever its label, as in fact-groups.ts: it only keeps two keys apart, which
// narrows and reveals nothing (invariant 5). A join counts only in an audience that holds its
// compartments.
function rulingOn(pair: SameFactPair, rulings: readonly FactRuling[]): "join" | "split" | null {
  const on = rulings.filter((one) => one.a === pair.a.fp && one.b === pair.b.fp);
  if (on.some((one) => one.verdict === "split")) return "split";
  return on.some((one) => one.verdict === "join" && holds(pair.audience, one.compartments)) ? "join" : null;
}

// Rung 0: a split says `different`, a join `same`, and two equal key phrases are one fact by code.
// Anything else goes up the ladder.
export function sameFactRung0(
  pair: SameFactPair,
  rulings: readonly FactRuling[],
): { output: "same" | "different"; reason: string } | "cannot_decide" {
  const ruling = rulingOn(pair, rulings);
  if (ruling === "split") return { output: "different", reason: "split" };
  if (ruling === "join") return { output: "same", reason: "join" };
  return pair.a.phrase === pair.b.phrase ? { output: "same", reason: "equal_phrase" } : "cannot_decide";
}

// The `pair` slot of both prompts: `{ type, a: { phrase, passage }, b: { phrase, passage } }`, the
// two key phrases as the claims give them and their passages, and nothing else of the claims.
export const pairSlot = (pair: SameFactPair): string =>
  JSON.stringify({
    type: pair.a.kind,
    a: { phrase: pair.a.text, passage: pair.a.passage === null ? null : cutPassage(pair.a.passage) },
    b: { phrase: pair.b.text, passage: pair.b.passage === null ? null : cutPassage(pair.b.passage) },
  });

// A `yes` needs every citation verified and at least one from each passage; a `no` every citation it
// gives. Code reads the passages it sent, never the model's.
export function verifyPairCites(output: Rung2Output, pair: SameFactPair): boolean {
  const passages = [pair.a.passage, pair.b.passage].map((one) => (one === null ? null : normal(cutPassage(one)).text));
  const found = output.cites.map((cite) => {
    const text = normal(cite.text).text.trim();
    return cite.slot !== "pair" || !strongCite(text)
      ? []
      : passages.flatMap((passage, n) => (passage?.includes(text) ? [n] : []));
  });
  if (found.some((where) => where.length === 0)) return false;
  return (
    output.answer !== "yes" || (found.some((where) => where.includes(0)) && found.some((where) => where.includes(1)))
  );
}

// Code's check of an answer: the pair is still of one audience, both keys among the keys that
// audience holds, of one subject, kind, domain and polarity, and no split stands on it. A model's
// `same` that fails it groups nothing.
export function checkPair(pair: SameFactPair, held: ReadonlySet<string>, rulings: readonly FactRuling[]): boolean {
  const { a, b } = pair;
  return (
    a.fp < b.fp &&
    held.has(a.fp) &&
    held.has(b.fp) &&
    holds(pair.audience, a.compartments) &&
    holds(pair.audience, b.compartments) &&
    a.subject === b.subject &&
    a.kind === b.kind &&
    a.domain === b.domain &&
    a.polarity === b.polarity &&
    rulingOn(pair, rulings) !== "split"
  );
}

// What the ladder's runners answer, structurally the ladder's Rung1Answer and Rung2Answer.
type DecideAnswer = { p: number; savedCall: string } | { rejected: string } | "unavailable" | "skipped";
type ExtractAnswer = { output: Rung2Output; savedCall: string } | { rejected: string } | "unavailable" | "skipped";
type ClimbAnswer = { call: DecisionPointCall; escalate: boolean } | { wait: "model_unavailable" | "escalated" };

// The ladder's climb of claims_same_fact for one pair, with the runners this module builds; the
// caller binds the registry and the run's thresholds.
export type ClimbSameFact = (input: {
  facts: SameFactPair;
  rung0: (pair: SameFactPair) => { output: string; reason: string } | "cannot_decide";
  rung1: () => Promise<DecideAnswer>;
  rung2: () => Promise<
    { output: Rung2Output; verified: boolean; savedCall: string } | { rejected: string } | "unavailable" | "skipped"
  >;
  choose: (band: "accept" | "reject", allowed: readonly string[]) => string;
  escalatedBefore: boolean;
}) => Promise<ClimbAnswer>;

// A judgment with its two keys' compartments (the card's label), whether the owner is asked on a
// card, the later of its two keys' times, by which cards go newest pair first, and the two claims
// it read when the store named them.
type SameFactRow = FactGrouping & { compartments: string[]; card: boolean; at: string; claims?: [string, string] };

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])].sort();

// Rung 0's answer is code's: a join or equal phrases `accepted` (D15, every mode), a split `split`, a
// ruling's join `joined`. A model's accept is a proposal: in `shadow` it is `proposed` with a card, in
// `apply` `accepted`. The middle band, an unsure the extract model among it, escalates to the owner's
// card in every mode; a reject is `rejected`.
export function rowOf(
  pair: SameFactPair,
  call: DecisionPointCall,
  calls: readonly string[],
  mode: Exclude<GroupingMode, "off">,
  reason: string | null,
): SameFactRow {
  const base = {
    audience: [...pair.audience].sort(),
    keys: [pair.a.fp, pair.b.fp] as [string, string],
    calls: [...calls],
    compartments: union(pair.a.compartments, pair.b.compartments),
    at: later(pair),
    ...(pair.a.claim === undefined || pair.b.claim === undefined
      ? {}
      : { claims: [pair.a.claim, pair.b.claim] as [string, string] }),
  };
  if (call.rung === 0) {
    const state = call.output === "different" ? "split" : reason === "join" ? "joined" : "accepted";
    return { ...base, band: call.output === "different" ? "reject" : "accept", rung: 0, state, card: false };
  }
  if (call.rung === 4) return { ...base, band: "middle", rung: 4, state: "proposed", card: true };
  const rung = call.rung === 1 ? 1 : 2;
  if (call.output === "same")
    return {
      ...base,
      band: "accept",
      rung,
      state: mode === "apply" ? "accepted" : "proposed",
      card: mode === "shadow",
    };
  return { ...base, band: "reject", rung, state: "rejected", card: false };
}

type SameFactInput = {
  mode: GroupingMode;
  // Each audience with the beliefs it holds.
  audiences: readonly { audience: string[]; beliefs: readonly SameFactBelief[] }[];
  // The joins and splits in force.
  rulings: readonly FactRuling[];
  // `<sorted audience>|<subject>` of every pair that already has a row: never asked twice.
  asked: ReadonlySet<string>;
};

export type SameFactModels = {
  climb: ClimbSameFact;
  decideModel?: (pair: SameFactPair, slot: string) => Promise<DecideAnswer>;
  extractModel?: (pair: SameFactPair, slot: string) => Promise<ExtractAnswer>;
};

export type SameFactSummary = {
  pairs: number;
  asked: number;
  rung0: number;
  calls: number;
  accept: number;
  middle: number;
  reject: number;
  refused: number;
  waiting: number;
  capped: number;
};

const askedKey = (audience: readonly string[], subject: string): string =>
  `${[...audience].sort().join(",")}|${subject}`;

// The most model calls one pair can take: the decide model, then the extract model.
const PAIR_CALLS = 2;
// A decision call's id.
const DECISION_CALL = new RegExp(`^dcc_${ULID_PATTERN}$`);

// The sweep: for each audience its candidate pairs not yet asked, rung 0, then the climb, at most PAIR_CALLS_PER_RUN
// model calls a run for each audience (each decide model or the extract model answer, a replay included), so a pair an
// audience cannot see never spends its budget (invariant 6); a pair starts only while its two calls fit. Then code's
// check of every answer. Answers the rows to write; nothing else.
export async function sweepSameFact(
  input: SameFactInput,
  models: SameFactModels,
): Promise<{ rows: SameFactRow[]; summary: SameFactSummary }> {
  const summary: SameFactSummary = {
    pairs: 0,
    asked: 0,
    rung0: 0,
    calls: 0,
    accept: 0,
    middle: 0,
    reject: 0,
    refused: 0,
    waiting: 0,
    capped: 0,
  };
  const rows: SameFactRow[] = [];
  if (input.mode === "off") return { rows, summary };
  const mode = input.mode;
  for (const { audience, beliefs } of input.audiences) {
    const held = new Set(beliefs.map((one) => one.fp));
    let used = 0;
    for (const pair of candidatePairs(audience, beliefs)) {
      summary.pairs += 1;
      if (input.asked.has(askedKey(audience, pair.subject))) continue;
      const settled = sameFactRung0(pair, input.rulings);
      if (settled === "cannot_decide" && used + PAIR_CALLS > PAIR_CALLS_PER_RUN) {
        summary.capped += 1;
        continue;
      }
      summary.asked += 1;
      const slot = pairSlot(pair);
      const calls: string[] = [];
      const saved = <T>(answer: T): T => {
        if (typeof answer === "object" && answer !== null)
          calls.push(
            "savedCall" in answer ? String(answer.savedCall) : "rejected" in answer ? String(answer.rejected) : "",
          );
        return answer;
      };
      const result = await models.climb({
        facts: pair,
        rung0: (one) => sameFactRung0(one, input.rulings),
        rung1: async () => {
          if (models.decideModel === undefined) return "skipped";
          summary.calls += 1;
          used += 1;
          return saved(await models.decideModel(pair, slot));
        },
        rung2: async () => {
          if (models.extractModel === undefined) return "skipped";
          summary.calls += 1;
          used += 1;
          const answer = saved(await models.extractModel(pair, slot));
          return typeof answer === "object" && "output" in answer
            ? { ...answer, verified: verifyPairCites(answer.output, pair) }
            : answer;
        },
        choose: (_band, allowed) => allowed[0] ?? "",
        escalatedBefore: false,
      });
      if ("wait" in result) {
        summary.waiting += 1;
        continue;
      }
      const row = rowOf(
        pair,
        result.call,
        calls.filter((id) => DECISION_CALL.test(id)),
        mode,
        settled === "cannot_decide" ? null : settled.reason,
      );
      if (result.call.rung === 0) summary.rung0 += 1;
      // Code checks every answer that would group, whatever rung gave it.
      if (row.band !== "reject" && !checkPair(pair, held, input.rulings)) {
        summary.refused += 1;
        continue;
      }
      summary[row.band] += 1;
      rows.push(row);
    }
  }
  return { rows, summary };
}
