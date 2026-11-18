import type { ClaimCandidate, EvidenceId, OntologyType, Timestamp } from "@intelligence/contracts";
import type { ItemProject, TriageLane } from "@intelligence/contracts/personal";
import type { RepairRule } from "@intelligence/personal-beliefs";
import type { Interpreted, Parsed, ReadItem } from "@intelligence/personal-core";
import { reaskWorthAsking } from "@intelligence/personal-core/planner";
import type { Prompt } from "@intelligence/personal-models";
import { ExtractFailure } from "./call-failure.ts";
import { type PersonalUnmapped, refusalWords } from "./check.ts";
import type { ExtractDeps } from "./config.ts";
import { fieldsDetail } from "./fields-detail.ts";
import { interpret, savedCall } from "./interpret.ts";
import { type ExtractOutcome, type Found, failedCall, type ItemEnds, itemRefusal } from "./item-ends.ts";
import { messageProjectData } from "./project-named.ts";
import { CALLED_PROMPTS } from "./prompts.ts";
import { REASK_SUFFIX, WORDING_ISSUES, type WordingIssue } from "./reask-prompt.ts";

// What becomes of a refused candidate before it is filed: the detail its row keeps, the commit's
// count of repairs, and the one re-ask.

// The shared check's `bad_fields` carries no detail: each answer whose fields its type's schema
// refuses gives it, by type in the answer's order. Codes only, for a refusal row and a report.
export function withSharedDetail(
  unmapped: readonly PersonalUnmapped[],
  candidates: readonly ClaimCandidate[],
  typeOf: (type: string) => OntologyType | null,
): PersonalUnmapped[] {
  const shared = new Map<string, ReturnType<typeof fieldsDetail>[]>();
  for (const candidate of candidates) {
    const detail = fieldsDetail(typeOf(candidate.type), candidate.fields);
    if (detail.issue !== undefined) shared.set(candidate.type, [...(shared.get(candidate.type) ?? []), detail]);
  }
  return unmapped.map((one) => {
    if (one.reason !== "bad_fields" || one.issue !== undefined) return one;
    const detail = shared.get(one.proposedType)?.shift();
    return detail === undefined ? one : { ...one, ...refusalWords(detail) };
  });
}

// One check's result as a commit holds it, its repairs counted in a log line by rule: codes and
// counts only, never a value.
export function commitFound(
  found: { claims: Found["claims"]; unmapped: PersonalUnmapped[]; repairs?: RepairRule[] },
  evidence: EvidenceId,
  deps: Pick<ExtractDeps, "log">,
): Pick<Found, "claims" | "unmapped" | "repaired"> {
  const { repairs, ...kept } = found;
  if (repairs === undefined) return kept;
  const counts: Record<string, number> = {};
  for (const rule of repairs) counts[rule] = (counts[rule] ?? 0) + 1;
  deps.log.info({ event: "extract_repaired", counts, ids: { evidence } });
  return { ...kept, repaired: repairs.length };
}

const isWording = (issue: string | undefined): issue is WordingIssue =>
  (WORDING_ISSUES as readonly (string | undefined)[]).includes(issue);

// The codes of an item whose every candidate was refused for its wording, in order and once each;
// null for any other item: one with a claim kept, one refused for anything else, or one with a
// candidate held for a person (a second answer could not be merged with its mentions).
export function wordingCodes(found: { claims: unknown[]; unmapped: PersonalUnmapped[] }, unresolved: number) {
  if (found.claims.length > 0 || found.unmapped.length === 0 || unresolved > 0) return null;
  if (!found.unmapped.every((one) => one.reason === "bad_fields" && isWording(one.issue))) return null;
  return WORDING_ISSUES.filter((code) => found.unmapped.some((one) => one.issue === code));
}

// What a re-ask reads of its item.
type AskedItem = { parsed: Parsed; read: ReadItem; sentAt: Timestamp; project?: ItemProject | null };

// As the commit's contract holds an item's filed mentions.
const MAX_FILED = 200;

// The re-ask of a prompt, the same version under its own id; none for a prompt that has none.
const reaskOf = (asked: Prompt): Prompt | undefined =>
  CALLED_PROMPTS.find((one) => one.id === `${asked.id}${REASK_SUFFIX}` && one.version === asked.version);

// The wording a re-ask is counted under: its prompt's id and version, and the start of its text's
// hash, so a change to either the lane's wording or the re-ask's note starts a new count.
const wordingOf = (prompt: Prompt): string => `${prompt.id}@${prompt.version}#${prompt.textHash.slice(0, 12)}`;

// What a commit records of the re-ask it followed; none for a prompt that has no re-ask.
export function reaskRecord(asked: Prompt, codes: readonly WordingIssue[], rescued: boolean): Pick<Found, "reask"> {
  const prompt = reaskOf(asked);
  return prompt === undefined ? {} : { reask: { codes: [...codes], wording: wordingOf(prompt), rescued } };
}

// The stop rule (personal-core's reask-stop.ts): these codes are asked again only while one of them
// still rescues something under this wording. A re-ask already saved is not asked here: it replays
// at no cost. The counts failing to read stops nothing.
export async function worthAsking(
  codes: readonly WordingIssue[] | null,
  asked: Prompt,
  evidence: EvidenceId,
  deps: Pick<ExtractDeps, "store" | "log">,
): Promise<readonly WordingIssue[] | null> {
  const prompt = reaskOf(asked);
  if (codes === null || prompt === undefined) return codes;
  const rates = await deps.store.reaskRates(wordingOf(prompt)).catch(() => []);
  if (reaskWorthAsking(codes, rates)) return codes;
  deps.log.info({ event: "extract_reask_stopped", code: "no_rescue", ids: { evidence } });
  return null;
}

// The slot for a set of codes, with the message's own.
const reaskData = (asked: Prompt, item: AskedItem, codes: readonly WordingIssue[]): Record<string, string> => ({
  ...messageProjectData(asked, item.parsed, item.sentAt, item.project ?? null),
  refused: JSON.stringify({ refused: codes }),
});

// Every set of codes a re-ask can name, in the order wordingCodes writes them: each non-empty subset
// of the issues, each a saved call to look for.
const CODE_SETS: readonly (readonly WordingIssue[])[] = Array.from(
  { length: 2 ** WORDING_ISSUES.length - 1 },
  (_, at) => WORDING_ISSUES.filter((_, bit) => ((at + 1) >> bit) & 1),
);

// The codes this item's re-ask was asked with, or null when it has none saved. The saved call is
// the mark that it was asked: it outlives a re-derive and either switch, and only the owner's retry
// removes it. So a check that later gives other codes buys no second call, and a replay finds the
// second answer whichever way the switches stand.
export async function savedReask(
  asked: Prompt,
  item: AskedItem,
  deps: ExtractDeps,
): Promise<readonly WordingIssue[] | null> {
  const prompt = reaskOf(asked);
  if (prompt === undefined) return null;
  const calls = deps.store.calls(deps.modelId);
  for (const codes of CODE_SETS)
    if (await savedCall(prompt, reaskData(asked, item, codes), item.parsed, calls)) return codes;
  return null;
}

// The one re-ask of an item, through the saved calls and the run's client, under the run's and the
// day's budget. It is only asked of a first answer: nothing re-asks a re-ask. No answer (none usable,
// or the vendor refused the request) is null, and the item ends on what it has. The model away waits
// the item with no attempt, and the run's own errors pass through, as for a first call.
export async function askAgain(
  lane: TriageLane,
  codes: readonly WordingIssue[],
  asked: Prompt,
  item: AskedItem,
  deps: ExtractDeps,
  ends: ItemEnds,
): Promise<Interpreted | null | ExtractOutcome> {
  const prompt = reaskOf(asked);
  if (prompt === undefined) return null;
  try {
    return await interpret(prompt, reaskData(asked, item, codes), item.parsed, item.read, {
      model: ends.model,
      calls: deps.store.calls(deps.modelId),
    });
  } catch (error) {
    if (error instanceof ExtractFailure || itemRefusal(error) !== undefined) return null;
    return failedCall(error, lane, ends);
  }
}

// A second answer can narrow, and never undo what the first narrowed.
export const narrowingAfter = <N extends string>(first: N, second: N): N => (second === "none" ? first : second);

// What the commit holds after a re-ask: the second answer's claims, and the first's for any other
// fact, so a claim of the second answer stays when a switch turned later lets the first keep its own,
// and one statement gives one claim. Both answers' refusals stand, each once, unless that very
// candidate was kept: a reworded candidate has another id, and its row says what was refused.
export function afterReask(first: Found, second: Found): Found & { reasked: true } {
  const secondKeys = new Set(second.claims.map((one) => one.factKey));
  const secondIds = new Set(second.claims.map((one) => one.claim.id as string));
  const claims = [
    ...first.claims.filter((one) => !secondKeys.has(one.factKey) && !secondIds.has(one.claim.id)),
    ...second.claims,
  ];
  const kept = new Set(claims.map((one) => one.claim.id as string));
  const refused = new Map(
    [...second.unmapped, ...first.unmapped].filter((one) => !kept.has(one.id)).map((one) => [one.id, one] as const),
  );
  const filed = new Map(
    [...(first.mentions ?? []), ...(second.mentions ?? [])].map((one) => [JSON.stringify(one), one] as const),
  );
  const repaired = (first.repaired ?? 0) + (second.repaired ?? 0);
  return {
    claims,
    unmapped: [...refused.values()],
    unresolved: first.unresolved + second.unresolved,
    mentions: [...filed.values()].slice(0, MAX_FILED),
    ...(repaired === 0 ? {} : { repaired }),
    reasked: true,
  };
}
