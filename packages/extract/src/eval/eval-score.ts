import type { CaptureTally } from "../capture-check.ts";
import { type FoundFact, type MeetingDetail, runKey, saidIn, sameStatement } from "./eval-facts.ts";
import { affiliation, type EvalMeetingFact } from "./eval-meetings-set.ts";
import { extrasAllowed, recallNeeded } from "./eval-rule.ts";

// How the lanes' evaluations score a set alike: each type's counts and gate, the one-to-one pairing
// of expected and found facts, the pooling of runs, and the lines they print.

// A type with fewer expected facts than this is printed and not gated.
export const EVAL_GATED_FROM = 10;

type TypeCounts = { type: string; expected: number; found: number; extra: number };
export type EvalTypeLine = TypeCounts & { gated: boolean; passed: boolean };

// A count line for each type, and the line of one type, filled as the set is scored. With `grow`, a
// type off the list gets a line of its own at the end.
export function typeCounts(
  types: readonly string[],
  grow = false,
): { counts: TypeCounts[]; line: (type: string) => TypeCounts } {
  const counts = types.map((type) => ({ type, expected: 0, found: 0, extra: 0 }));
  const line = (type: string): TypeCounts => {
    const known = counts.find((one) => one.type === type);
    if (known !== undefined || !grow) return known as TypeCounts;
    const added = { type, expected: 0, found: 0, extra: 0 };
    counts.push(added);
    return added;
  };
  return { counts, line };
}

// Over `runs` pooled runs of `of` facts each: the per-run line times the runs, so pooling rounds no
// line in the model's favour.
export const recalledAt = (found: number, of: number, runs = 1): boolean => found >= runs * recallNeeded(of);
export const extrasBound = (of: number, runs = 1): number => runs * extrasAllowed(of);

// Each type's line, gated when it has at least EVAL_GATED_FROM expected facts.
export const gatedLines = (counts: readonly TypeCounts[]): EvalTypeLine[] =>
  counts.map((one) => {
    const gated = one.expected >= EVAL_GATED_FROM;
    return { ...one, gated, passed: !gated || recalledAt(one.found, one.expected) };
  });

export const extrasOf = (lines: readonly TypeCounts[]): number => lines.reduce((sum, one) => sum + one.extra, 0);

// The runs' type lines summed, each gated at the per-run line times the runs.
export function pooledTypeLines(reports: readonly { types: readonly EvalTypeLine[] }[]): EvalTypeLine[] {
  const [first] = reports;
  if (first === undefined) throw new Error("no runs to pool");
  return first.types.map((line, at) => {
    const sum = (key: "expected" | "found" | "extra"): number =>
      reports.reduce((total, one) => total + (one.types[at]?.[key] ?? 0), 0);
    const pooled = { ...line, expected: sum("expected"), found: sum("found"), extra: sum("extra") };
    return { ...pooled, passed: !line.gated || recalledAt(pooled.found, line.expected, reports.length) };
  });
}

export function addDrops(into: CaptureTally, tally: CaptureTally): void {
  for (const [code, n] of Object.entries(tally)) into[code] = (into[code] ?? 0) + n;
}

// Each run's detail lines under its own run, each evidence id too, so a run's latency and cost
// are that run's (`callStatsByRun`).
export const detailByRun = (reports: readonly { detail: readonly MeetingDetail[] }[]): MeetingDetail[] =>
  reports.flatMap((one, at) =>
    one.detail.map((item) => ({
      ...item,
      id: runKey(at + 1, item.id),
      evidenceId: runKey(at + 1, item.evidenceId),
      ...(item.evidenceIds === undefined ? {} : { evidenceIds: item.evidenceIds.map((id) => runKey(at + 1, id)) }),
    })),
  );

// A kept claim as the evaluations compare it.
export function foundOf(record: {
  factKey: string;
  claim: { content: { type: string; subject: string; fields: Record<string, unknown> } };
}) {
  const { type, subject, fields } = record.claim.content;
  return {
    type,
    key: record.factKey,
    subject,
    counterparty: fields.counterparty,
    what: fields.what,
    due: fields.due,
    when: fields.when,
    said: saidIn(type, fields),
    domain: String(fields.domain ?? ""),
    fields,
  };
}

type Expected = { type: string; keys: readonly string[]; what: string | undefined; fact: EvalMeetingFact };

// One to one: each found fact matches at most one expected fact. A strict match first (type, fact
// key and words), so a pair both rules would form forms the strict way, then by `sameFact`: type,
// subject, polarity, the people named and the words. A found fact that is an allowed fact, or the
// employee affiliation a role at a named organization implies, is neither matched nor an extra; one
// `counted` refuses is neither either. A found fact that repeats a matched one or holds an expected
// fact's key is a repeat, not an extra.
export function pairFacts<E extends Expected, F extends FoundFact & { key: string }>(
  expected: readonly E[],
  found: readonly F[],
  sameFact: (fact: EvalMeetingFact, one: F) => boolean,
  allowed: readonly EvalMeetingFact[] = [],
  counted: (one: F) => boolean = () => true,
): { pairs: { fact: E; one: F }[]; lenient: { fact: E; one: F }[]; matched: E[]; extras: F[]; repeats: number } {
  const used = new Set<number>();
  const pairOf = (rule: (fact: E, one: F) => boolean) => (fact: E) => {
    const at = found.findIndex((one, n) => !used.has(n) && rule(fact, one));
    if (at < 0) return [];
    used.add(at);
    return [{ fact, one: found[at] as F }];
  };
  const strict = expected.flatMap(
    pairOf((fact, one) => one.type === fact.type && fact.keys.includes(one.key) && sameStatement(fact.what, one.what)),
  );
  const lenient = expected
    .filter((fact) => !strict.some((pair) => pair.fact === fact))
    .flatMap(pairOf((fact, one) => sameFact(fact.fact, one)));
  const pairs = [...strict, ...lenient];
  const matched = expected.filter((fact) => pairs.some((pair) => pair.fact === fact));
  const implied = expected.flatMap(({ fact }): EvalMeetingFact[] =>
    fact.type === "role" && fact.organization !== undefined
      ? [affiliation(fact.subject, "employee", fact.organization)]
      : [],
  );
  for (const fact of [...allowed, ...implied]) {
    const at = found.findIndex((one, n) => !used.has(n) && sameFact(fact, one));
    if (at >= 0) used.add(at);
  }
  const unused = found.filter((one, n) => !used.has(n) && counted(one));
  const extras = unused.filter(
    (one) =>
      !expected.some(
        (fact) =>
          (fact.type === one.type && fact.keys.includes(one.key)) ||
          (matched.includes(fact) && sameFact(fact.fact, one)),
      ),
  );
  return { pairs, lenient, matched, extras, repeats: unused.length - extras.length };
}

export function deckHeld(
  found: readonly { type: string; what: unknown; subject: string; counterparty: unknown }[],
  line: string,
  robin: string,
  owner: string,
): boolean {
  const onDeck = found.filter((one) => one.type === "commitment" && one.what === line);
  return (
    onDeck.some((one) => one.subject === robin && one.counterparty === owner) &&
    !onDeck.some((one) => one.subject === owner)
  );
}

// The lines every report prints the same way. `countedLines`: each type's counts, of the types the
// set expects or found, ungated.
export const countedLines = (types: readonly TypeCounts[]): string[] =>
  types
    .filter((one) => one.expected + one.found + one.extra > 0)
    .map((one) => `${one.type}: expected ${one.expected} found ${one.found} extra ${one.extra}`);
export const typeLineText = (one: EvalTypeLine): string =>
  `${one.type}: expected ${one.expected} found ${one.found} extra ${one.extra} ${one.gated ? `gated ${one.passed ? "ok" : "failed"}` : "not_gated"}`;
export const setLineText = (
  noun: string,
  count: number,
  report: { extras: number; extrasAllowed: number; failed: readonly string[] },
): string =>
  `${noun}: ${count} extras ${report.extras} of ${report.extrasAllowed} failed ${report.failed.length === 0 ? "none" : report.failed.join(",")}`;
export const scenarioLineText = (one: {
  scenario: string;
  expected: number;
  found: number;
  extra: number;
  passed: boolean;
}): string =>
  `scenario ${one.scenario}: expected ${one.expected} found ${one.found} extra ${one.extra} gated ${one.passed ? "ok" : "failed"}`;

// A pooled report's lines: the evaluation's own, then the runs pooled, each run's own result and
// each systematic shape, then the result.
export function pooledLines(
  lines: readonly string[],
  report: { pooled: number; each: readonly boolean[]; systematic: readonly string[] },
): string[] {
  const result = lines.at(-1) as string;
  return [
    ...lines.slice(0, -1),
    `pooled: runs ${report.pooled} not_gated`,
    ...report.each.map((passed, at) => `run ${at + 1}: ${passed ? "ok" : "failed"} not_gated`),
    ...report.systematic.map((one) => `systematic: ${one} not_gated`),
    result,
  ];
}
