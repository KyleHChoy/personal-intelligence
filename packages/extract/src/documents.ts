import type { ClaimCandidate, InterpreterOutput } from "@intelligence/contracts";
import type { DueDocument, OpenedItem } from "@intelligence/contracts/personal";
import type { Parsed, ReadItem } from "@intelligence/personal-core";
import { documentPassages, type Passage } from "@intelligence/personal-core/items";
import { strip } from "./check.ts";
import { EXTRACT_CONFIG, type ExtractDeps } from "./config.ts";
import { type CallPort, interpret, readStored, rendered } from "./interpret.ts";
import {
  type ExtractOutcome,
  type Found,
  failedCall,
  failedPlan,
  itemEnds,
  noPromptHere,
  opening,
  StepFailed,
  step,
} from "./item-ends.ts";
import { checkClaims, withheldBy } from "./lane-check.ts";
import { ontologyFor } from "./lane-versions.ts";
import { documentPrompt } from "./prompts.ts";
import { withSharedDetail } from "./refused.ts";
import { triageDocument } from "./triage.ts";

// The document lane: a due document opened, read by sections, cut into passages, triaged by rules,
// and sent in groups of passages, each one call under the model port, budgets and replay; then one
// commit for the document with every group's claims.

export const DOCUMENT_SETTLE_MS = 3_600_000;
export const DOCUMENT_MAX_CALLS = 8;

// One request of a document: its passages, the spans it lists, its data and its rendered prompt.
type DocumentGroup = {
  passages: Passage[];
  spans: ReadonlySet<string>;
  data: { document: string };
  text: string;
  inputHash: string;
};
type DocumentPlan = { parsed: Parsed; read: ReadItem; groups: DocumentGroup[]; leftOut: number };

// A passage that alone is over the bound ends the groups: it and what follows are left out, as
// everything past the last group is.
export function groupPassages(
  passages: Passage[],
  size: (group: Passage[]) => number,
  bound: number,
  most: number,
): { groups: Passage[][]; leftOut: number } {
  const groups: Passage[][] = [];
  let at = 0;
  while (at < passages.length && groups.length < most) {
    const group: Passage[] = [];
    while (at < passages.length && size([...group, passages[at] as Passage]) <= bound)
      group.push(passages[at++] as Passage);
    if (group.length === 0) break;
    groups.push(group);
  }
  return { groups, leftOut: passages.length - at };
}

// The `document` slot's value for one group: built by code from the title, the modified time and the
// group's passages, each with its span, heading and text.
function slotOf(parsed: Parsed, modified: string, passages: Passage[]): { document: string } {
  const text = parsed.texts[""] ?? "";
  const cut = (span: string): string => {
    const [start, end] = span.slice("chars:".length).split("-").map(Number);
    return text.slice(start, end);
  };
  return {
    document: JSON.stringify({
      citable: true,
      title: parsed.document?.title ?? "",
      modified,
      passages: passages.map((passage) => ({ span: passage.span, heading: passage.heading, text: cut(passage.span) })),
    }),
  };
}

// The sections the shared parse read, as core's derive keeps them.
function sectionsOf(parsed: Parsed): { heading: string; start: number; end: number }[] {
  return parsed.segments.map((segment, n) => {
    const [start, end] = segment.span.slice("chars:".length).split("-").map(Number);
    return { heading: parsed.document?.content.sections[n]?.heading ?? "", start: start ?? 0, end: end ?? 0 };
  });
}

// The document read and parsed by sections, its passages and its groups. Throws ExtractFailure
// `parse_failed` for a block the shared parse refuses.
export async function planDocument(opened: OpenedItem, compartment: string): Promise<DocumentPlan> {
  const { parsed, read } = await readStored(opened, [compartment], { sections: true });
  const passages = documentPassages(sectionsOf(parsed), parsed.texts[""] ?? "");
  const prompt = documentPrompt();
  const modified = opened.raw.observedAt;
  const size = (group: Passage[]): number => rendered(prompt, slotOf(parsed, modified, group)).text.length;
  const { groups, leftOut } = groupPassages(passages, size, EXTRACT_CONFIG.limits.promptChars, DOCUMENT_MAX_CALLS);
  return {
    parsed,
    read,
    leftOut,
    groups: groups.map((group) => {
      const data = slotOf(parsed, modified, group);
      return { passages: group, spans: new Set(group.map((one) => one.span)), data, ...rendered(prompt, data) };
    }),
  };
}

type GroupAnswer = { output: InterpreterOutput; inputHash: string; spans: ReadonlySet<string> };

// A narrowing that withholds on any group ends the whole document before any check, unless the
// owner released it, and no later group is sent. A call that does not answer throws, as `interpret`
// throws.
export async function askGroups(
  plan: DocumentPlan,
  port: CallPort,
  override: boolean,
): Promise<{ withheld: "quarantine" | "sensitive" } | { answers: GroupAnswer[] }> {
  const answers: GroupAnswer[] = [];
  for (const group of plan.groups) {
    const { output, inputHash } = await interpret(documentPrompt(), group.data, plan.parsed, plan.read, port);
    const withheld = withheldBy(output.narrowing);
    if (withheld !== undefined && !override) return { withheld };
    answers.push({ output, inputHash, spans: group.spans });
  }
  return { answers };
}

export async function checkGroups(
  answers: GroupAnswer[],
  plan: DocumentPlan,
  opened: OpenedItem,
  due: DueDocument,
  generation: number,
  repair?: boolean,
): Promise<Found> {
  const found: Found = { claims: [], unmapped: [], unresolved: 0 };
  for (const { output, inputHash, spans } of answers) {
    const narrowing = due.override ? "none" : output.narrowing;
    const candidates: ClaimCandidate[] = strip(output.claims);
    const { found: group, unresolved } = await checkClaims(
      candidates,
      { parsed: plan.parsed, read: plan.read, narrowing, changeKind: opened.changeKind, inputHash, document: true },
      { generation, ontology: ontologyFor("document"), identity: opened.context.identity },
      { parsed: plan.parsed, item: opened, due, lane: "document", passages: spans, repair: repair === true },
    );
    found.unresolved += unresolved;
    found.claims.push(...group.claims);
    found.unmapped.push(...withSharedDetail(group.unmapped, candidates, (type) => ontologyFor("document").get(type)));
    if (group.repairs !== undefined) found.repaired = (found.repaired ?? 0) + group.repairs.length;
  }
  return found;
}

// The pipeline for one stored document, from its screen to its commit, and every way it can
// end, as processItem for a message.
export async function processDocument(due: DueDocument, deps: ExtractDeps): Promise<ExtractOutcome> {
  const { evidenceId } = due;
  const ends = itemEnds(evidenceId, deps);
  const { defer, final, generation } = ends;

  const triaged = triageDocument(due.triage, due.lane, deps.now(), deps.documents?.days);
  if (triaged.lane === "skip") return final("skip", "skipped", triaged.code);
  // A message's lane, given a document by hand, has no prompt for one: `pi extract retry` refuses it.
  if (triaged.lane !== "document") return noPromptHere(ends);
  const lane = "document";

  const opened = await opening(() => deps.store.openDocument(evidenceId));
  if (opened === null) return { status: "gone", claims: 0, unmapped: 0, unresolved: 0, live: false };

  const plan = await step(() => planDocument(opened, due.compartment));
  if (plan instanceof StepFailed) return failedPlan(plan.error, lane, ends, "commit_failed");
  const counts = { groups: plan.groups.length, leftOut: plan.leftOut };
  // No passage fits a request: the text is too long to send in any.
  if (plan.groups.length === 0)
    return final(lane, "skipped", (plan.parsed.texts[""] ?? "") === "" ? "no_text" : "too_long", undefined, counts);

  const asked = await step(() =>
    askGroups(plan, { model: ends.model, calls: deps.store.calls(deps.modelId) }, due.override),
  );
  if (asked instanceof StepFailed) return failedCall(asked.error, lane, ends);
  if ("withheld" in asked) return final(lane, "withheld", asked.withheld, undefined, counts);

  const found = await step(() => checkGroups(asked.answers, plan, opened, due, generation, deps.repair === true));
  if (found instanceof StepFailed) return defer(lane, "check_failed", true);
  return final(lane, "done", undefined, found, counts);
}
