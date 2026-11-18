import {
  type ClaimRecord,
  type DueItem,
  type EmailDueItem,
  isCoded,
  isStatement,
  type MessageLane,
  type OpenedItem,
  type OpenedRecord,
  parseOwnerAnswerBody,
  parseProposalBody,
  QUOTED_PROPOSAL_PIPELINE,
  type RestatementCheck,
  type TriageLane,
} from "@intelligence/contracts/personal";
import { keyVersionOf, matchKey } from "@intelligence/personal-beliefs";
import { askedPrompt, askMessage } from "./asked-version.ts";
import { ExtractFailure } from "./call-failure.ts";
import { type PersonalUnmapped, strip } from "./check.ts";
import { closeClaim } from "./close.ts";
import type { ExtractDeps } from "./config.ts";
import { askDecideModel } from "./decide-call.ts";
import { DEFAULT_THRESHOLDS } from "./decision-points.ts";
import { fillClaims } from "./fill.ts";
import { findingData, interpretItem, readRecord, readStored } from "./interpret.ts";
import {
  type ExtractOutcome,
  type Found,
  failedCall,
  failedPlan,
  type ItemEnds,
  itemEnds,
  itemRefusal,
  none,
  noPromptHere,
  opening,
  StepFailed,
  step,
} from "./item-ends.ts";
import { withheldBy } from "./lane-check.ts";
import { ownerQuoted } from "./owner-quoted.ts";
import { commitMessage, processFinding, restatementsOf } from "./process-item-steps.ts";
import {
  answerClaims,
  answerStatementClaims,
  answerText,
  proposalClaim,
  releasedClaim,
  STATEMENT_OWNER,
  statementClaims,
  statementText,
} from "./proposal.ts";
import { asksHold, recoveryAnswer } from "./recovery.ts";
import { decide, screenItem, screens } from "./screen.ts";
import { intakeRefusal } from "./standalone.ts";
import { triage } from "./triage.ts";

// The pipeline for one stored item, from triage to its commit, and every way it can end. An
// error from a port or a parser never leaves as text: it ends as a status and a code, or, for
// the run to act on, as one of the errors below or a model error that
// passes through (unavailable is deferred here; refused and the budget leave).

// Whether a claims_said check reads the claims of this item: the decide model on, with its model (no rung
// suspended), and the said point's line not off.
const saidRuns = (deps: ExtractDeps, ends: ItemEnds): boolean =>
  deps.decideModel !== undefined &&
  ends.decideClient !== undefined &&
  (deps.thresholds ?? DEFAULT_THRESHOLDS).said !== null;

// The claim intake's decide-model check of each claim against the quote, each refusal filed unmapped with
// its reason; or the item's end when the decide model could not answer.
async function intakeRefused(
  records: ClaimRecord[],
  quote: string,
  checks: "both" | "said" | "standalone",
  opened: ReturnType<typeof readRecord>,
  deps: ExtractDeps,
  ends: ItemEnds,
): Promise<PersonalUnmapped[] | ExtractOutcome> {
  const lane = "agent";
  if (deps.decideModel === undefined || ends.decideClient === undefined) return [];
  const decideModel = { ...deps.decideModel, model: ends.decideClient };
  const refused: PersonalUnmapped[] = [];
  try {
    for (const one of records) {
      const refusal = await intakeRefusal(
        one,
        quote,
        deps.thresholds ?? DEFAULT_THRESHOLDS,
        (prompt, data) => askDecideModel(prompt, data, opened.parsed, opened.read, { store: deps.store, decideModel }),
        checks,
      );
      if (refusal !== null) refused.push({ id: one.claim.id, proposedType: one.claim.content.type, reason: refusal });
    }
  } catch (error) {
    // A check failure is not evidence against earlier claims: a final commit would delete them.
    // Explicit owner confirmations bypass these inferred checks altogether.
    if (error instanceof ExtractFailure) return ends.defer(lane, error.code, true);
    if (itemRefusal(error) !== undefined) return ends.defer(lane, "model_refused_item", false);
    return failedCall(error, lane, ends);
  }
  return refused;
}

// No model request: code builds its one claim, or ends it `skipped` with `bad_proposal`, or with
// `client_scoped` for a client-scoped preference, whose card the commit raises. A claim of scope `all` goes
// through the restatement check.
async function processProposal(
  due: Extract<DueItem, { source: "agent_record" }>,
  record: OpenedRecord,
  deps: ExtractDeps,
  ends: ItemEnds,
): Promise<ExtractOutcome> {
  const lane = "agent";
  const { defer, final, generation } = ends;
  // A statement proposal is typed by the model, as a finding is.
  const body = parseProposalBody(record.body);
  if (body !== null && isStatement(body))
    return processStatement(
      due,
      record,
      {
        event: "statement_classified",
        shown: statementText(body),
        quote: body.quote,
        checks: "both",
        build: (read, candidates) => statementClaims(record, due, read, ends.generation, candidates),
      },
      deps,
      ends,
    );
  let built: ReturnType<typeof proposalClaim>;
  let opened: ReturnType<typeof readRecord>;
  try {
    opened = readRecord(record, due.compartments);
    built = proposalClaim(record, due, opened.read, generation);
  } catch (error) {
    return failedPlan(error, lane, ends, "check_failed");
  }
  if ("code" in built) return final(lane, "skipped", built.code);
  // A claim the claim checks refused is filed unmapped with its reason.
  const refused = (one: PersonalUnmapped) =>
    final(lane, "done", undefined, { claims: [], unmapped: [one], unresolved: 0, restatements: [] });
  if ("unmapped" in built) return refused(built.unmapped);
  // With the decide model on, a quoted proposal's line is asked claims_standalone and claims_said before its
  // card can be raised; a refusal files it unmapped. Its answer can only refuse: the claim
  // committed is the one code built. A record the owner confirmed is not asked again, released or
  // not; the owner's confirm outranks the model's refuse-only check (invariant 11). An interpretation is
  // in the agent's words, so its line is asked claims_standalone alone; there is no one quote it
  // must say.
  const quote = body?.quote ?? (body !== null && "statement" in body && body.statement !== undefined ? "" : undefined);
  if (
    built.record.claim.pipelineVersion === QUOTED_PROPOSAL_PIPELINE &&
    quote !== undefined &&
    !ownerConfirmed(record)
  ) {
    const checked = await intakeRefused(
      [built.record],
      quote,
      quote === "" ? "standalone" : "both",
      opened,
      deps,
      ends,
    );
    if (!Array.isArray(checked)) return checked;
    if (checked[0] !== undefined) return refused(checked[0]);
  }
  const restatements = await step(() => restatementsOf(due, [built.record], deps));
  if (restatements instanceof StepFailed) return defer(lane, "commit_failed", true);
  const quotes =
    body === null ? [] : ((body as { quotes?: string[] }).quotes ?? (body.quote === undefined ? [] : [body.quote]));
  const quoted =
    built.record.claim.pipelineVersion === QUOTED_PROPOSAL_PIPELINE && (await mayGrant(record, quotes, deps));
  return final(
    lane,
    "done",
    undefined,
    { claims: withReleased([built.record], record, due, generation), unmapped: [], unresolved: 0, restatements },
    quoted ? { ownerQuoted: true } : {},
  );
}

// A quoted proposal no release covers yet, whose quotes are the owner's own words in an item it cites
// that they sent (owner-quoted.ts), may be kept under the owner's standing release. A record their
// grant released already was found theirs at that commit, so a later run keeps it.
const mayGrant = async (record: OpenedRecord, quotes: readonly string[], deps: ExtractDeps): Promise<boolean> =>
  record.released?.grant === true ||
  (!ownerConfirmed(record) && quotes.length > 0 && (await ownerQuoted(quotes, record.item.cites, deps.store)));

// Agents state, the classifier types. A statement proposal is shown to the agent lane's model as a
// finding (statementText), with the type guide its prompt carries; code builds each claim of an
// owner's kind from the kind and fields the model gave (statementClaims), with the owner as
// subject, its quote as the passage, never the model's subject. A quoted one's claims are asked the
// intake's check against the owner's words, as a quoted proposal's are. An answer stored `typed` takes the
// same path (answerText, answerStatementClaims), its claims asked claims_said against the owner's words.
// The verdict is logged per agent client, ids, counts and a code only.
type Stated = {
  event: "statement_classified" | "answer_classified";
  shown: string;
  quote: string | undefined;
  checks: "both" | "said";
  build: (
    read: ReturnType<typeof readRecord>["read"],
    candidates: Parameters<typeof statementClaims>[4],
  ) => ReturnType<typeof statementClaims>;
};
async function processStatement(
  due: Extract<DueItem, { source: "agent_record" }>,
  record: OpenedRecord,
  stated: Stated,
  deps: ExtractDeps,
  ends: ItemEnds,
): Promise<ExtractOutcome> {
  const lane = "agent";
  const { defer, final, generation } = ends;
  const verdict = (
    code: "typed" | "untyped" | "withheld",
    counts: { candidates: number; typed: number; refused: number },
  ) =>
    deps.log.info({
      event: stated.event,
      ids: { client: record.item.client, record: record.item.recordId, evidence: due.evidenceId },
      counts: { ...counts, dropped: Math.max(0, counts.candidates - counts.typed - counts.refused) },
      code,
    });
  let opened: ReturnType<typeof readRecord>;
  let interpreted: Awaited<ReturnType<typeof interpretItem>>;
  try {
    opened = readRecord(record, due.compartments);
    const shown = readRecord({ ...record, body: stated.shown }, due.compartments);
    const asked = await askedPrompt("agent", shown.parsed, record.item.recordedAt, deps);
    interpreted = await interpretItem(
      shown.parsed,
      shown.read,
      lane,
      record.item.recordedAt,
      { ...deps, model: ends.model },
      asked,
      findingData(asked, shown.parsed, {
        ...record,
        ownerKeys: { names: [], addresses: [STATEMENT_OWNER] },
      }),
    );
  } catch (error) {
    return failedCall(error, lane, ends);
  }
  const { output } = interpreted;
  const candidates = output.claims.length;
  const withheld = withheldBy(output.narrowing);
  if (withheld !== undefined && !due.override) {
    verdict("withheld", { candidates, typed: 0, refused: 0 });
    return final(lane, "withheld", withheld);
  }
  const built = stated.build(opened.read, strip(output.claims));
  if ("code" in built) {
    verdict("untyped", { candidates, typed: 0, refused: 0 });
    return final(lane, "skipped", built.code);
  }
  let kept = built.records;
  let unmapped = built.unmapped;
  const checking = stated.checks === "both" || saidRuns(deps, ends);
  if (stated.quote !== undefined && checking && kept.length > 0 && !ownerConfirmed(record)) {
    const checked = await intakeRefused(kept, stated.quote, stated.checks, opened, deps, ends);
    if (!Array.isArray(checked)) return checked;
    const refused = new Set(checked.map((one) => one.id as string));
    kept = kept.filter((one) => !refused.has(one.claim.id));
    unmapped = [...unmapped, ...checked];
  }
  verdict(kept.length > 0 ? "typed" : "untyped", { candidates, typed: kept.length, refused: unmapped.length });
  // An answer is checked for no restatement: it is the owner's word, not the agent's.
  let restatements: RestatementCheck[] = [];
  if (stated.event === "statement_classified") {
    try {
      restatements = await restatementsOf(due, kept, deps);
    } catch {
      return defer(lane, "commit_failed", true);
    }
  }
  // A statement's quote is the owner's quotes joined (storedBodyOf).
  const quoted =
    stated.event === "statement_classified" &&
    stated.quote !== undefined &&
    kept.length > 0 &&
    (await mayGrant(record, stated.quote.split("\n\n"), deps));
  return final(
    lane,
    "done",
    undefined,
    { claims: withReleased(kept, record, due, generation), unmapped, unresolved: 0, restatements },
    quoted ? { ownerQuoted: true } : {},
  );
}

const withMatchKey = (record: ClaimRecord, key: string | undefined): ClaimRecord =>
  key === undefined ? record : { ...record, matchKey: key };

// The owner's confirm in force, or their release in force (which a confirm made), skips the claim
// intake's model check. A confirmed record whose release was refused (its label cannot narrow to
// `own`) is skipped too.
const ownerConfirmed = (record: OpenedRecord): boolean => record.confirmed || record.released !== undefined;

// Beside each claim of a record the owner released, its released claim, made by code from the
// store's release row. The restatement check reads the record's own claims alone.
function withReleased(
  claims: ClaimRecord[],
  record: OpenedRecord,
  due: Extract<DueItem, { source: "agent_record" }>,
  generation: number,
): ClaimRecord[] {
  const { released } = record;
  if (released === undefined) return claims;
  return [...claims, ...claims.flatMap((claim) => releasedClaim(claim, released, due.compartments, generation) ?? [])];
}

// An answer from the owner to a question the system asked. No restatement check: code builds one
// claim for each fact it lists, or ends it `skipped` with `bad_proposal`. The store keeps its
// claims as the owner's own and raises no card. Even so, with the decide model on each claim's line is asked
// claims_said beside the quote, and a refusal files it unmapped.
async function processAnswer(
  due: Extract<DueItem, { source: "agent_record" }>,
  record: OpenedRecord,
  deps: ExtractDeps,
  ends: ItemEnds,
): Promise<ExtractOutcome> {
  const lane = "agent";
  const { final, generation } = ends;
  // An answer stored `typed` is typed by the model; one stored before it keeps its facts, or builds
  // no claim when it gave none.
  const answer = parseOwnerAnswerBody(record.body);
  if (answer !== null && answer.typed === true)
    return processStatement(
      due,
      record,
      {
        event: "answer_classified",
        shown: answerText(answer),
        quote: answer.quote,
        checks: "said",
        build: (read, candidates) => answerStatementClaims(record, due, read, generation, candidates),
      },
      deps,
      ends,
    );
  let built: ReturnType<typeof answerClaims>;
  let opened: ReturnType<typeof readRecord>;
  try {
    opened = readRecord(record, due.compartments);
    built = answerClaims(record, due, opened.read, generation);
  } catch (error) {
    return failedPlan(error, lane, ends, "check_failed");
  }
  if ("code" in built) return final(lane, "skipped", built.code);
  const quote = answer?.quote;
  let unmapped: PersonalUnmapped[] = [];
  if (saidRuns(deps, ends) && quote !== undefined && !ownerConfirmed(record)) {
    const checked = await intakeRefused(built.records, quote, "said", opened, deps, ends);
    if (!Array.isArray(checked)) return checked;
    unmapped = checked;
  }
  const refused = new Set(unmapped.map((one) => one.id as string));
  const kept = built.records.filter((one) => !refused.has(one.claim.id));
  return final(lane, "done", undefined, {
    claims: withReleased(kept, record, due, generation),
    unmapped,
    unresolved: 0,
    restatements: [],
  });
}

export async function processItem(due: DueItem, deps: ExtractDeps): Promise<ExtractOutcome> {
  const ends = itemEnds(due.evidenceId, deps);
  // An agent record's lane is `agent`, set by code from its source kind; no owner's lane and
  // nothing in a body changes it.
  if (due.source === "agent_record") return processRecord(due, deps, ends);
  return processMessage(due, deps, ends);
}

async function processRecord(
  due: Extract<DueItem, { source: "agent_record" }>,
  deps: ExtractDeps,
  ends: ItemEnds,
): Promise<ExtractOutcome> {
  const { evidenceId } = due;
  const { final, generation } = ends;
  const lane = "agent";
  if (
    due.kind !== "finding" &&
    due.kind !== "proposal" &&
    due.kind !== "answer" &&
    due.kind !== "close" &&
    due.kind !== "fill"
  )
    return final(lane, "skipped", "not_a_finding");
  const record = await opening(() => deps.store.openRecord(evidenceId));
  if (record === null) return { status: "gone", ...none, live: false };
  const ended = keyedEnds(record, ends);
  if (due.kind === "proposal") return processProposal(due, record, deps, ended);
  if (due.kind === "answer") return processAnswer(due, record, deps, ended);
  // An agent's close of a commitment (one claim) and an explore task's fill: claims built by code,
  // never a model's.
  if (due.kind === "close" || due.kind === "fill") {
    const built = due.kind === "fill" ? fillClaims(record, generation) : closedClaims(closeClaim(record, generation));
    if ("code" in built) return ended.final(lane, "skipped", built.code);
    return ended.final(lane, "done", undefined, {
      claims: built.records,
      unmapped: [],
      unresolved: built.unresolved,
      restatements: [],
    });
  }
  return processFinding(due, record, deps, ends);
}

// A close's one claim in a fill's shape.
const closedClaims = (built: ReturnType<typeof closeClaim>) =>
  "code" in built ? built : { records: [built.record], unresolved: 0 };

// The ends of a record's claims built by code. Every end of a proposal or an answer names the
// release the run read, so a confirm that lands during the run leaves the record due. Each of the
// record's own claims carries its match key, at the key version of this run's generation, so the
// store can find an answer the owner already gave.
function keyedEnds(record: OpenedRecord, ends: ItemEnds): ItemEnds {
  const release = record.released?.ruling;
  const version = keyVersionOf(ends.generation);
  const keyed = (found: Found | undefined): Found | undefined => {
    if (found === undefined) return undefined;
    return {
      ...found,
      claims: found.claims.map((one) =>
        one.released !== undefined ? one : withMatchKey(one, matchKey(one.claim.content, version)),
      ),
    };
  };
  return {
    ...ends,
    final: ((lane, status, code, found, more) =>
      ends.final(
        lane,
        status,
        code,
        keyed(found),
        release === undefined ? more : { ...more, release },
      )) as typeof ends.final,
  };
}

// A message: rung 0 and the screens decide its lane, then the extract model's call and the check.
async function processMessage(due: EmailDueItem, deps: ExtractDeps, ends: ItemEnds): Promise<ExtractOutcome> {
  const { final } = ends;
  const opened = await openMessage(due, deps, ends);
  if ("status" in opened) return opened;
  const { rung0, screened, stored } = opened;
  const held = await recoveryScreen(due, stored, rung0.lane, deps, ends);
  if (held !== null) return held;
  if (!screened && rung0.lane === "skip") return final("skip", "skipped", rung0.code);
  const triaged = await decideTriage(due, stored, rung0, screened, deps, ends);
  if ("status" in triaged) return triaged;
  if (triaged.lane === "skip") return final("skip", "skipped", triaged.code);
  // The decide model gives none but a message's lanes; this narrows the type, as the check after rung 0
  // ended any other.
  if (!onMessagePath(triaged.lane)) return noPromptHere(ends);
  // An owner's lane of `agent` on a message is no lane a message has: read as correspondence.
  const lane = triaged.lane === "agent" ? "correspondence" : triaged.lane;

  const answered = await step(() =>
    askMessage(
      lane,
      stored,
      opened.opened,
      due.sentAt,
      { ...deps, model: ends.model },
      // A mark means nothing in another lane: an item moved since replays what it has.
      due.ask?.lane === lane ? due.ask.version : undefined,
    ),
  );
  if (answered instanceof StepFailed) return failedCall(answered.error, lane, ends);
  return commitMessage({ due, stored, triaged: triaged.lane, lane, ...answered }, deps, ends);
}

type Rung0 = ReturnType<typeof triage>;

// The lanes a message may go on with: its own, an owner's `agent`, which is read as correspondence, and
// a skip. A lane added later is no lane of a message until it is named here.
const onMessagePath = (lane: TriageLane): lane is MessageLane | "agent" | "skip" =>
  lane === "correspondence" || lane === "transaction" || lane === "agent" || lane === "skip";

// Rung 0 first, in triage's order. Its skips by the owner's lane or for no text end the item
// with no call; its bulk skip is left to the decide model when the decide model is on. With the owner's lane and release
// both set, the decide model has nothing to decide. With the decide model on, every item is opened first for the recovery
// screen, whatever the lane, the text or the direction.
async function openMessage(
  due: EmailDueItem,
  deps: ExtractDeps,
  ends: ItemEnds,
): Promise<
  | { rung0: Rung0; screened: boolean; opened: OpenedItem; stored: Awaited<ReturnType<typeof readStored>> }
  | ExtractOutcome
> {
  const { final } = ends;
  const rung0 = triage(due.triage, due.lane);
  // Any other lane has no prompt for a message: one given it by hand is skipped as having no text its
  // prompt reads, with no call. `pi extract retry` refuses to give it one.
  if (!onMessagePath(rung0.lane)) return noPromptHere(ends);
  const screened = deps.decideModel !== undefined && screens(due, rung0);
  if (deps.decideModel === undefined && rung0.lane === "skip") return final("skip", "skipped", rung0.code);

  const opened = await opening(() =>
    deps.store.open(due.evidenceId, { projects: deps.factKinds?.includes("correspondence") === true }),
  );
  if (opened === null) return { status: "gone", ...none, live: false };

  let stored: Awaited<ReturnType<typeof readStored>>;
  try {
    stored = await readStored(opened, due.compartments);
  } catch (error) {
    // An item rung 0 skips ends as it would without the decide model, unread.
    if (!screened && rung0.lane === "skip") return final("skip", "skipped", rung0.code);
    return failedCall(error, rung0.lane, ends);
  }
  return { rung0, screened, opened, stored };
}

// The recovery screen, before the decide-model call: a hold at or above the line ends the item with no
// status row, unless the owner released the message (`pi messages release`, which the store's mark
// refuses to hold again, or `--override`). No answer waits; a rejection is no decide model at all. The
// mark is written either way. A mark refused because a re-derive rewrote the row since it was opened ends
// the item as a commit would: superseded, with no attempt. Null: the item goes on.
async function recoveryScreen(
  due: EmailDueItem,
  stored: Awaited<ReturnType<typeof readStored>>,
  lane: TriageLane,
  deps: ExtractDeps,
  ends: ItemEnds,
): Promise<ExtractOutcome | null> {
  if (deps.decideModel === undefined || ends.decideClient === undefined) return null;
  let answer: Awaited<ReturnType<typeof recoveryAnswer>>;
  try {
    answer = await recoveryAnswer(stored.parsed, stored.read, due.triage, {
      store: deps.store,
      decideModel: { ...deps.decideModel, model: ends.decideClient },
    });
  } catch (error) {
    if (itemRefusal(error) !== undefined || error instanceof ExtractFailure) {
      if (due.override) return null;
      return ends.defer(lane, itemRefusal(error) === undefined ? "interpret_failed" : "model_refused_item", false);
    }
    return failedCall(error, lane, ends);
  }
  if (answer === "rejected" && !due.override) return ends.defer(lane, "interpret_failed", false);
  let held: boolean;
  try {
    held = await deps.store.markRecovery(
      due.evidenceId,
      !due.override && asksHold(answer, deps.thresholds ?? DEFAULT_THRESHOLDS),
    );
  } catch (error) {
    if (isCoded(error, "item_changed")) return { status: "superseded", ...none, live: ends.live() };
    return ends.defer(lane, "commit_failed", true);
  }
  return held ? { status: "held", ...none, live: ends.live() } : null;
}

// The decide-model call. Its holds come first, quarantine then special_category, unless the owner
// released the item; then its lane, at triage's line 5. A rejected answer leaves rung 0's lane.
async function decideTriage(
  due: EmailDueItem,
  stored: Awaited<ReturnType<typeof readStored>>,
  rung0: Rung0,
  screened: boolean,
  deps: ExtractDeps,
  ends: ItemEnds,
): Promise<Rung0 | ExtractOutcome> {
  if (!screened || deps.decideModel === undefined || ends.decideClient === undefined) return rung0;
  let answer: Awaited<ReturnType<typeof screenItem>>;
  try {
    answer = await screenItem(stored.parsed, stored.read, due.triage, {
      store: deps.store,
      decideModel: { ...deps.decideModel, model: ends.decideClient },
    });
  } catch (error) {
    return failedCall(error, rung0.lane, ends);
  }
  if (answer === "rejected") return rung0;
  const decided = decide(due, answer, deps.thresholds ?? DEFAULT_THRESHOLDS);
  if (decided.withhold !== undefined) return ends.final(decided.triaged.lane, "withheld", decided.withhold);
  return decided.triaged;
}
