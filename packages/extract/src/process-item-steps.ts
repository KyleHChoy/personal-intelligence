import type { InterpreterOutput } from "@intelligence/contracts";
import type {
  AskedLane,
  ClaimRecord,
  DueItem,
  EmailDueItem,
  ExtractionCommit,
  ItemProject,
  MessageLane,
  OpenedItem,
  OpenedRecord,
  RestatementCheck,
  TriageLane,
} from "@intelligence/contracts/personal";
import type { Interpreted } from "@intelligence/personal-core";
import type { Prompt } from "@intelligence/personal-models";
import { askedFinding } from "./asked-version.ts";
import { type personalCheck, strip } from "./check.ts";
import type { ExtractDeps } from "./config.ts";
import { askDecideModel } from "./decide-call.ts";
import { DEFAULT_THRESHOLDS } from "./decision-points.ts";
import { fitRecordSlot } from "./fit.ts";
import { findingData, interpretItem, passesThrough, readRecord } from "./interpret.ts";
import { type ExtractOutcome, type Found, failedCall, type ItemEnds, StepFailed, step } from "./item-ends.ts";
import { checkFindingClaims, checkMessageClaims, messageCandidates, withheldBy } from "./lane-check.ts";
import { fileable, notingUnresolved } from "./mentions.ts";
import { promptFor } from "./prompts.ts";
import { DECIDE_RECORD } from "./question-prompts.ts";
import {
  afterReask,
  askAgain,
  commitFound,
  narrowingAfter,
  reaskRecord,
  savedReask,
  withSharedDetail,
  wordingCodes,
  worthAsking,
} from "./refused.ts";
import { checkRestatement, heldFactKeys } from "./restatement.ts";
import { routedDue } from "./triage.ts";

// The steps of processItem (process-item.ts) that read a finding or a message through its model
// call and its check, and end it.

type Finding = Extract<DueItem, { source: "agent_record" }>;

// A store error throws; the caller defers the item, as a commit's error would.
export async function restatementsOf(
  due: Finding,
  claims: ClaimRecord[],
  deps: ExtractDeps,
): Promise<RestatementCheck[]> {
  const candidates =
    claims.length === 0
      ? []
      : await deps.store.restatementCandidates(
          due.evidenceId,
          claims.map((claim) => ({ claim, heldKeys: heldFactKeys(claim, due.compartments) })),
        );
  return claims.map((claim, i) => ({ claimId: claim.claim.id, ...checkRestatement(claim, candidates[i] ?? []) }));
}

// A finding: the record screen, the extract model's call, the check and the restatement check.
export async function processFinding(
  due: Finding,
  record: OpenedRecord,
  deps: ExtractDeps,
  ends: ItemEnds,
): Promise<ExtractOutcome> {
  const interpreted = await interpretFinding(due, record, deps, ends);
  if ("status" in interpreted) return interpreted;
  return commitFinding(due, record, interpreted, deps, ends);
}

type ReadFinding = {
  read: ReturnType<typeof readRecord>;
  interpreted: Awaited<ReturnType<typeof interpretItem>>;
  asked: Prompt;
};

async function interpretFinding(
  due: Finding,
  record: OpenedRecord,
  deps: ExtractDeps,
  ends: ItemEnds,
): Promise<ReadFinding | ExtractOutcome> {
  const lane = "agent";
  const { final } = ends;
  const lines = deps.thresholds ?? DEFAULT_THRESHOLDS;
  let read: ReturnType<typeof readRecord>;
  let interpreted: Awaited<ReturnType<typeof interpretItem>>;
  let asked: Prompt = promptFor(lane);
  try {
    read = readRecord(record, due.compartments);
    // The record screen: a finding the owner has not released is asked once, before the extract model,
    // whether it carries instructions. At or above the run's line it is withheld `quarantine`, and the
    // store's rule flags it in the same commit. A rejection goes on to the extract model.
    if (deps.decideModel !== undefined && ends.decideClient !== undefined && !due.override) {
      const answer = await askDecideModel(
        DECIDE_RECORD,
        { record: JSON.stringify(fitRecordSlot(record.body)) },
        read.parsed,
        read.read,
        { store: deps.store, decideModel: { ...deps.decideModel, model: ends.decideClient } },
      );
      if (answer !== "rejected" && (answer as { quarantine: number }).quarantine >= lines.record)
        return final(lane, "withheld", "quarantine");
    }
    asked = await askedFinding(record, read.parsed, deps);
    interpreted = await interpretItem(
      read.parsed,
      read.read,
      lane,
      record.item.recordedAt,
      { ...deps, model: ends.model },
      asked,
      findingData(asked, read.parsed, record),
    );
  } catch (error) {
    return failedCall(error, lane, ends);
  }
  return { read, interpreted, asked };
}

async function commitFinding(
  due: Finding,
  record: OpenedRecord,
  { read, interpreted, asked }: ReadFinding,
  deps: ExtractDeps,
  ends: ItemEnds,
): Promise<ExtractOutcome> {
  const lane = "agent";
  const { defer, final } = ends;
  const checks = (answer: Interpreted) => checkFinding(due, record, read, answer, asked, deps, ends);
  const ended = await checkedOrAgain(
    lane,
    interpreted,
    due.override,
    checks,
    asked,
    { parsed: read.parsed, read: read.read, sentAt: record.item.recordedAt },
    deps,
    ends,
  );
  if ("status" in ended) return ended;
  const restatements = await step(() => restatementsOf(due, ended.claims, deps));
  if (restatements instanceof StepFailed) return defer(lane, "commit_failed", true);
  return final(lane, "done", undefined, { ...ended, restatements });
}

// One answer's check, its counts, and how to file the names it left unresolved.
type Checked = {
  found: ReturnType<typeof personalCheck>;
  unresolved: number;
  mentions: NonNullable<ExtractionCommit["mentions"]>;
};

// A second answer is held to the same: it can narrow what the first did not. With PI_EXTRACT_REASK,
// an item whose every candidate was refused for its wording is asked again, once; a saved re-ask
// replays whichever way the switch stands, so its claims never go by a replay. Answers what the
// commit holds, or how the item ended.
async function checkedOrAgain(
  lane: AskedLane,
  first: Interpreted,
  override: boolean,
  checks: (answer: Interpreted) => Promise<Checked>,
  asked: Prompt,
  item: Parameters<typeof askAgain>[3],
  deps: ExtractDeps,
  ends: ItemEnds,
): Promise<Found | ExtractOutcome> {
  const held = ({ output }: Interpreted): Promise<ExtractOutcome> | null => {
    const withheld = withheldBy(output.narrowing);
    return withheld !== undefined && !override ? ends.final(lane, "withheld", withheld) : null;
  };
  const firstHeld = held(first);
  if (firstHeld !== null) return firstHeld;
  try {
    const checked = await checks(first);
    const kept = (one: Checked): Found => ({
      ...commitFound(one.found, item.parsed.evidenceId, deps),
      unresolved: one.unresolved,
      mentions: one.mentions,
    });
    const evidence = item.parsed.evidenceId;
    const codes =
      (await savedReask(asked, item, deps)) ??
      (deps.reask === true
        ? await worthAsking(wordingCodes(checked.found, checked.unresolved), asked, evidence, deps)
        : null);
    if (codes === null) return kept(checked);
    const again = await askAgain(lane, codes, asked, item, deps, ends);
    // Asked, with no answer to use: it rescued nothing.
    if (again === null) return { ...kept(checked), ...reaskRecord(asked, codes, false) };
    if ("status" in again) return again;
    const secondHeld = held(again);
    if (secondHeld !== null) return secondHeld;
    const narrowing = narrowingAfter(first.output.narrowing, again.output.narrowing);
    // A narrowing of either answer holds for both answers' claims.
    const firstNarrowed =
      narrowing === first.output.narrowing
        ? checked
        : await checks({ ...first, output: { ...first.output, narrowing } });
    const second = kept(await checks({ ...again, output: { ...again.output, narrowing } }));
    return { ...afterReask(kept(firstNarrowed), second), ...reaskRecord(asked, codes, second.claims.length > 0) };
  } catch (error) {
    if (passesThrough(error)) throw error;
    return ends.defer(lane, "check_failed", true);
  }
}

async function checkFinding(
  due: Finding,
  record: OpenedRecord,
  read: ReadFinding["read"],
  { output, inputHash }: Interpreted,
  asked: Prompt,
  deps: ExtractDeps,
  ends: ItemEnds,
): Promise<Checked> {
  const candidates = strip(output.claims);
  const names = notingUnresolved(record.context.identity);
  const { found, unresolved, ontology } = await checkFindingClaims(candidates, {
    parsed: read.parsed,
    read: read.read,
    record,
    due,
    promptVersion: asked.version,
    narrowing: due.override ? "none" : output.narrowing,
    inputHash,
    generation: ends.generation,
    repair: deps.repair === true,
    identity: names.identity,
  });
  return {
    found: { ...found, unmapped: withSharedDetail(found.unmapped, candidates, (type) => ontology.get(type)) },
    unresolved,
    mentions: fileable(candidates, read.parsed, names.unresolved, {
      document: true,
      fingerprint: (key) => deps.store.keyFingerprint(key),
    }),
  };
}

// A message read and in its lane: the check of what the extract model's call gave, and the item's end.
type ReadMessage = {
  due: EmailDueItem;
  opened: OpenedItem;
  stored: ReturnType<typeof readRecord>;
  // The lane triage gave, before an owner's `agent` is read as correspondence.
  triaged: TriageLane;
  lane: MessageLane;
  output: InterpreterOutput;
  inputHash: string;
  asked: Prompt;
  project: ItemProject | null;
};

export async function commitMessage(message: ReadMessage, deps: ExtractDeps, ends: ItemEnds): Promise<ExtractOutcome> {
  const { due, stored, lane, output, inputHash, asked } = message;
  const ended = await checkedOrAgain(
    lane,
    { output, inputHash },
    due.override,
    (answer) => checkMessage(message, answer, deps, ends),
    asked,
    { parsed: stored.parsed, read: stored.read, sentAt: due.sentAt, project: message.project },
    deps,
    ends,
  );
  if ("status" in ended) return ended;
  const { ask } = due;
  return ends.final(lane, "done", undefined, ended, ask?.lane === lane && ask.version === asked.version ? { ask } : {});
}

async function checkMessage(
  message: ReadMessage,
  { output, inputHash }: Interpreted,
  deps: ExtractDeps,
  ends: ItemEnds,
): Promise<Checked> {
  const { due, opened, stored, lane, asked } = message;
  const candidates = messageCandidates(lane, output.claims, stored.parsed, opened);
  const names = notingUnresolved(opened.context.identity);
  const { found, unresolved, ontology } = await checkMessageClaims(candidates, {
    parsed: stored.parsed,
    read: stored.read,
    opened,
    due: routedDue(due, message.triaged),
    lane,
    promptVersion: asked.version,
    narrowing: due.override ? "none" : output.narrowing,
    inputHash,
    generation: ends.generation,
    repair: deps.repair === true,
    identity: names.identity,
  });
  return {
    found: { ...found, unmapped: withSharedDetail(found.unmapped, candidates, (type) => ontology.get(type)) },
    unresolved,
    mentions: fileable(candidates, stored.parsed, names.unresolved, {
      document: false,
      fingerprint: (key) => deps.store.keyFingerprint(key),
    }),
  };
}
