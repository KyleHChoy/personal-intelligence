import { EvidenceId, TrustGroupId } from "@intelligence/contracts";
import {
  type DreamPass,
  isCoded,
  type PersonalLogger,
  SamePersonPairAnswer,
  type SourceCheckRow,
} from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { relationRules } from "@intelligence/personal-core/views";
import {
  afterScreen,
  capReached,
  checkSources,
  checkVerdictOf,
  type ExtractDeps,
  inChunks,
  nightOrder,
  pairReadable,
  pairSlot,
  type RelationCheck,
  relateClaims,
  relationJudge,
  SAME_PERSON_PROMPT,
  samePersonJudge,
  screenSplit,
  sourceCheckJudge,
  sweepOrder,
  verifyPairCites,
} from "@intelligence/personal-extract";
import { BudgetReached, completeKeyedWithReplay } from "@intelligence/personal-models";
import type {
  DreamStore,
  IdentityPairRow,
  Pipeline,
  RelationStore,
  SourceCheckStore,
  SweepCursor,
} from "@intelligence/personal-store";
import { SECOND_CHECK_POINT, sourceAsker } from "./dream-askers.ts";
import { relationAsker } from "./relations.ts";

// The pass in chunks (`pi dream`, as pi_pipeline). Each chunk takes the extract
// lock, does its work, saves and lets it go, so extraction runs between chunks; each chunk reads the
// day's spend afresh, through the night's budget, whose day line reads the lane's spend at every call.
//   1. The night's subjects in code's order, a chunk at a time: each subject's claims no run
//      has judged, the cheap screen first where one is set, the judge on what it flagged and
//      on the miss sample of what it passed over; then the census of every finding of the judge by the
//      second model, a keyed share of each kind the sample a line reads; then the conflicts
//      code could not settle, filed for the work tick; then each subject's review time.
//   2. The open same-person questions, judged and filed as candidates for the sweep, and the census
//      of each `same`.
//   3. The tail (runDream): the recall audit, the fulfilled-commitments sweep, the belief sample and
//      the hot slice on the second model, the switching job and the audit cards.
// Nothing here writes a merge, a claim or a label; what it writes takes effect only under a kind's
// line, which ships unset. Ids, counts and codes in its log lines.

type ModelClient = ExtractDeps["model"];
type Client = { model: ModelClient; modelId: string };

// How many subjects a chunk reviews, and how many identity pairs; how many findings a chunk's census
// reads; the claims a subject's sweep reads; the miss sample's and the line sample's starting shares.
const SUBJECTS_A_CHUNK = 5;
const PAIRS_A_CHUNK = 10;
const CENSUS_A_CHUNK = 20;
// One claim a batch: on the box a batch of two of the owner's claims held the lock over four minutes.
const SWEEP_CLAIMS = 1;
export const MISS_SHARE = 0.1;
export const SAMPLE_SHARE = 0.5;
// While extraction holds the lock: how long a chunk waits, and how many times.
const LOCK_WAIT_MS = 20_000;
const LOCK_TRIES = 30;
const NO_CAP = Number.MAX_SAFE_INTEGER;

export type DreamPassCounts = {
  pass: DreamPass;
  subjects: number;
  chunks: number;
  screen: { pairs: number; flagged: number; passed: number; missJudged: number };
  judge: { pairs: number; written: number; byKind: Record<string, number> };
  census: {
    checked: number;
    held: number;
    failed: number;
    sample: number;
    byKind: Record<string, { held: number; failed: number }>;
    // Why each failed: the checker's verdict, or the code of a check with none.
    failedBy: Record<string, number>;
  };
  findings: number;
  // What each stage spent of the night, in whole micro-dollars.
  microUsd: { screen: number; judge: number; census: number; identity: number };
  identity: {
    pairs: number;
    same: number;
    different: number;
    cantTell: number;
    uncited: number;
    checked: number;
    held: number;
    // Questions the judge could not ask, a side with no passage within the question's label; `bare` of
    // them, a side whose person has no belief-type claim under any label.
    unreadable: number;
    bare: number;
  };
  stopped: "ok" | "budget" | "unavailable" | "time" | "busy" | "held";
};

export type DreamPassDeps = {
  pass: DreamPass;
  relations: RelationStore;
  checks: SourceCheckStore;
  dream: DreamStore;
  pipeline: Pick<Pipeline, "noteExposure">;
  // Runs `work` under the extract lock, or answers that a run holds it.
  lock: <T>(work: () => Promise<T>) => Promise<T | "already_running">;
  judge: Client;
  screen: Client | null;
  checker: Client | null;
  caps: { usd: number | null; calls: number | null };
  calls: () => number;
  spent: () => number;
  deadline: number | null;
  // Whether a hold was set on the box since the pass began (the sync or read hold): it stops between chunks.
  held?: () => boolean;
  log: PersonalLogger;
  now: () => Date;
  wait?: (ms: number) => Promise<void>;
  selector?: (pair: string) => number;
  // Told after each chunk, with the counts so far and how many subjects are reviewed, so a long pass
  // can be watched while it runs.
  // `lockMs`: the longest any chunk has held the extract lock, the time extraction waited at worst.
  progress?: (counts: DreamPassCounts, dreamed: number, lockMs: number) => void;
};

const zero = (pass: DreamPass): DreamPassCounts => ({
  pass,
  subjects: 0,
  chunks: 0,
  screen: { pairs: 0, flagged: 0, passed: 0, missJudged: 0 },
  judge: { pairs: 0, written: 0, byKind: {} },
  census: { checked: 0, held: 0, failed: 0, sample: 0, byKind: {}, failedBy: {} },
  findings: 0,
  microUsd: { screen: 0, judge: 0, census: 0, identity: 0 },
  identity: { pairs: 0, same: 0, different: 0, cantTell: 0, uncited: 0, checked: 0, held: 0, unreadable: 0, bare: 0 },
  stopped: "ok",
});

export async function runDreamPass(deps: DreamPassDeps): Promise<DreamPassCounts> {
  const { relations, dream, log } = deps;
  const counts = zero(deps.pass);
  const judgeId = relationJudge(deps.judge.modelId);
  const screenId = deps.screen === null ? null : relationJudge(deps.screen.modelId);
  // A checker of the judge's own model is no second model: no census, so nothing takes effect.
  const checker = deps.checker !== null && deps.checker.modelId !== deps.judge.modelId ? deps.checker : null;
  const checkerId = checker === null ? null : sourceCheckJudge(checker.modelId);
  const rules = relationRules();
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const missed = (pair: string): boolean => (deps.selector ?? (() => 1))(pair) < MISS_SHARE;
  const askJudge = relationAsker({ relations, pipeline: deps.pipeline, client: deps.judge, log });
  const askScreen =
    deps.screen === null
      ? null
      : relationAsker({
          relations,
          pipeline: deps.pipeline,
          client: deps.screen,
          log,
          point: { id: "relation_screen", version: 1 },
        });
  const askCheck =
    checker === null
      ? null
      : sourceAsker({ checks: deps.checks, pipeline: deps.pipeline, client: checker, log, point: SECOND_CHECK_POINT });

  // Whether the owner trusts the second model now, read at each chunk: a check made while it is not
  // measures and decides nothing, so a drifting checker gives no finding effect.
  let live = false;
  // Whether the pass may start another chunk: within its time and its caps, no hold set on the box
  // meanwhile, and the model there.
  const mayGo = (): boolean => {
    if (counts.stopped !== "ok") return false;
    if (deps.held?.() === true) counts.stopped = "held";
    else if (deps.deadline !== null && Date.now() >= deps.deadline) counts.stopped = "time";
    else if (capReached(deps.caps, { microUsd: deps.spent(), calls: deps.calls() }) !== null) counts.stopped = "budget";
    return counts.stopped === "ok";
  };
  // Runs one stage's work and adds what it spent to the stage.
  const spending = async <T>(stage: keyof DreamPassCounts["microUsd"], work: () => Promise<T>): Promise<T> => {
    const before = deps.spent();
    try {
      return await work();
    } finally {
      counts.microUsd[stage] += deps.spent() - before;
    }
  };
  const stop = (why: "ok" | "budget" | "unavailable"): void => {
    if (counts.stopped === "ok" && why !== "ok") counts.stopped = why;
  };
  // One chunk under the lock, waiting while extraction holds it.
  let lockMs = 0;
  const locked = async (work: () => Promise<void>): Promise<boolean> => {
    for (let tries = 0; tries < LOCK_TRIES; tries += 1) {
      if (
        (await deps.lock(async () => {
          const taken = Date.now();
          try {
            live = await dream.linesLive();
            await work();
          } finally {
            lockMs = Math.max(lockMs, Date.now() - taken);
          }
        })) !== "already_running"
      )
        return true;
      await wait(LOCK_WAIT_MS);
    }
    counts.stopped = "busy";
    return false;
  };

  // The census of the judge's findings not yet read by the checker (relations), each saved as made.
  const census = async (): Promise<void> => {
    if (askCheck === null || checkerId === null) return;
    const clearance = await relations.ownerClearance();
    const cases = await dream.censusCases(judgeId, checkerId, clearance, CENSUS_A_CHUNK, SAMPLE_SHARE, live);
    const flag = new Map(cases.map((one) => [one.targetKey, one.census]));
    const run = await checkSources(cases, askCheck, { calls: NO_CAP }, async (row: SourceCheckRow) => {
      const isCensus = flag.get(row.targetKey) ?? true;
      // A check that was not saved (a restricted label) is not counted: the census loop ends when a
      // call adds no check.
      if ((await dream.saveChecks([{ ...row, census: isCensus }], checkerId, live)) === 0) return;
      counts.census.checked += 1;
      if (!isCensus) counts.census.sample += 1;
      const one = (counts.census.byKind[row.kind] ??= { held: 0, failed: 0 });
      if (row.verdict === "supported" && row.onCited) {
        counts.census.held += 1;
        one.held += 1;
      } else {
        counts.census.failed += 1;
        one.failed += 1;
        const why = row.verdict ?? (row.code as string);
        counts.census.failedBy[why] = (counts.census.failedBy[why] ?? 0) + 1;
      }
    });
    stop(run.stopped);
  };

  // One batch of a subject's claims: their jobs, the screen and the judge.
  // `paging.after` is where the subject's last batch left off, so a claim that cannot be marked (a
  // restricted one, or one that fails to open) is read once a pass and never starves the claims after
  // it. Answers whether the subject has more: a full batch.
  const subject = async (entity: string, paging: { after?: SweepCursor }): Promise<boolean> => {
    const now = deps.now().toISOString();
    const swept = await relations.sweep(
      judgeId,
      now,
      {
        calls: NO_CAP,
        candidates: rules.budget.candidatesPerSubject,
        limit: SWEEP_CLAIMS,
        subjects: [entity],
        ...(paging.after === undefined ? {} : { after: paging.after }),
      },
      sweepOrder,
    );
    if (swept.last !== null) paging.after = swept.last;
    let jobs = swept.jobs;
    if (askScreen !== null && screenId !== null && jobs.length > 0) {
      const asked = await dream.screenAnswers(
        screenId,
        jobs.map((job) => job.claim.key),
      );
      const screened = await spending("screen", () =>
        relateClaims(
          jobs,
          askScreen,
          { candidates: rules.budget.candidatesPerSubject, calls: NO_CAP },
          // Screened both ways at once, so an answer from either side stands for both orders.
          new Set(asked.flatMap((one) => [`${one.claimKey}\n${one.otherKey}`, `${one.otherKey}\n${one.claimKey}`])),
          {
            // The screen's answers are its own checks under its own judge, never a relation.
            each: async (part) => {
              if (part.checks.length > 0)
                await relations.save({ relations: [], checks: part.checks, marks: [] }, screenId, { dream: true });
            },
          },
        ),
      );
      stop(screened.stopped);
      if (screened.stopped === "unavailable") return false;
      const split = screenSplit([...asked, ...screened.checks]);
      counts.screen.pairs += screened.counts.pairs;
      counts.screen.flagged += split.flagged.size;
      counts.screen.passed += split.passed.size;
      const after = afterScreen(jobs, split, missed);
      jobs = after.jobs;
      counts.screen.missJudged += [...after.misses].filter((pair) => !swept.checked.has(pair)).length;
    }
    const judged = await spending("judge", () =>
      relateClaims(jobs, askJudge, { candidates: rules.budget.candidatesPerSubject, calls: NO_CAP }, swept.checked, {
        each: async (part) => {
          const marks = part.marks.filter((mark) => mark.state === "judged");
          if (part.relations.length + part.checks.length + marks.length > 0)
            await relations.save({ ...part, marks }, judgeId, { dream: true });
        },
      }),
    );
    stop(judged.stopped);
    counts.judge.pairs += judged.counts.pairs;
    counts.judge.written += judged.counts.written;
    for (const one of judged.relations) counts.judge.byKind[one.kind] = (counts.judge.byKind[one.kind] ?? 0) + 1;
    return counts.stopped === "ok" && swept.claims >= SWEEP_CLAIMS;
  };

  // The census in lock holds of its own, a few findings each, until none is left unread: a hold is
  // then the judge's work on one batch of claims or the checker's on a few findings, never both. Then
  // the conflicts of the subjects just swept, which need their checks, and only then are those
  // subjects reviewed: one whose census a stop cut short is swept again by the next pass, which asks
  // nothing twice.
  const checkAndMark = async (entities: readonly string[]): Promise<boolean> => {
    let before = -1;
    while (mayGo() && counts.census.checked !== before) {
      before = counts.census.checked;
      if (!(await locked(() => spending("census", census)))) return false;
    }
    if (counts.stopped !== "ok") return false;
    return locked(async () => {
      for (const entity of entities) counts.findings += await dream.fileFindings(judgeId, entity);
      await dream.markDreamed([...entities], judgeId);
      dreamed += entities.length;
    });
  };

  // 1. The night's subjects. Each batch of a subject's claims is a chunk, with a lock hold of its own,
  // so no hold is longer than the judge's work on one batch. One progress line a chunk, the last of a
  // group of subjects after they are reviewed, so it counts them.
  const clearance = await relations.ownerClearance();
  const order = nightOrder(await dream.subjects(judgeId, deps.pass, clearance, deps.now().toISOString()));
  counts.subjects = order.length;
  let dreamed = 0;
  let owed = false;
  const tell = (): void => {
    if (owed) deps.progress?.(counts, dreamed, lockMs);
    owed = false;
  };
  // First the findings no check has read yet, an earlier pass's included: what is already found
  // takes effect before the pass spends anything on finding more.
  const caughtUp = await checkAndMark([]);
  for (const group of caughtUp ? inChunks(order, SUBJECTS_A_CHUNK) : []) {
    if (!mayGo()) break;
    const swept: string[] = [];
    for (const entity of group) {
      const paging: { after?: SweepCursor } = {};
      let left = true;
      while (left && mayGo()) {
        tell();
        const ran = await locked(async () => {
          left = await subject(entity, paging);
        });
        if (!ran) break;
        counts.chunks += 1;
        owed = true;
      }
      if (left || counts.stopped !== "ok") break;
      swept.push(entity);
    }
    const marked = await checkAndMark(swept);
    tell();
    if (!marked) break;
  }
  tell();

  // 2. The open same-person questions, and the census of each `same`.
  // A question the judge could not ask, or whose answer cited nothing, saves no candidate and stays
  // open, so each read skips the questions this pass already tried; the next pass tries them again.
  const pairJudge = samePersonJudge(deps.judge.modelId);
  const tried = new Set<string>();
  while (mayGo()) {
    let more = false;
    const done = await locked(async () => {
      const pairs = await dream.identityPairs(pairJudge, PAIRS_A_CHUNK, tried);
      more = pairs.length === PAIRS_A_CHUNK;
      for (const pair of pairs) {
        if (counts.stopped !== "ok") break;
        tried.add(pair.question);
        await spending("identity", () => judgePair(pair));
      }
      if (checker !== null) {
        const sames = await dream.identityCensusCases(
          pairJudge,
          samePersonJudge(checker.modelId),
          PAIRS_A_CHUNK,
          SAMPLE_SHARE,
          live,
        );
        for (const pair of sames) {
          if (counts.stopped !== "ok") break;
          await spending("census", () => checkPair(pair));
        }
      }
    });
    if (done) deps.progress?.(counts, dreamed, lockMs);
    if (!done || !more) break;
  }
  return counts;

  async function judgePair(pair: IdentityPairRow): Promise<void> {
    if (!pairReadable(pair)) {
      counts.identity.unreadable += 1;
      if (pair.bare === true) counts.identity.bare += 1;
      return;
    }
    counts.identity.pairs += 1;
    const answer = await askPair(deps.judge, pair, { id: "same_person_pair", version: 1 });
    if (answer === "unavailable" || answer === "budget") return stop(answer);
    if (answer === null || !verifyPairCites(answer, pair)) {
      counts.identity.uncited += 1;
      return;
    }
    if (answer.verdict === "same") counts.identity.same += 1;
    else if (answer.verdict === "different") counts.identity.different += 1;
    else counts.identity.cantTell += 1;
    await dream.saveCandidate(pair, pairJudge, answer.verdict);
  }

  async function checkPair(pair: IdentityPairRow & { census: boolean }): Promise<void> {
    if (checker === null) return;
    const answer = await askPair(checker, pair, { id: "same_person_check", version: 1 });
    if (answer === "unavailable" || answer === "budget") return stop(answer);
    const verdict = answer === null || !verifyPairCites(answer, pair) ? null : checkVerdictOf(answer.verdict);
    counts.identity.checked += await dream.saveIdentityCheck(
      pair,
      pairJudge,
      samePersonJudge(checker.modelId),
      { verdict, code: verdict === null ? "uncited" : null },
      live,
    );
    if (verdict === "supported") counts.identity.held += 1;
  }

  // One pair through the keyed replay on `client`, at `point`, its items noted as exposed first.
  async function askPair(
    client: Client,
    pair: IdentityPairRow,
    point: { id: string; version: number },
  ): Promise<SamePersonPairAnswer | null | "unavailable" | "budget"> {
    const refs = [...new Set([...pair.a, ...pair.b].map((one) => one.evidenceId))].sort();
    const calls = dream.calls();
    try {
      await deps.pipeline.noteExposure(
        client.modelId,
        SAME_PERSON_PROMPT.id,
        refs.map((id) => EvidenceId.parse(id)),
      );
      const response = await completeKeyedWithReplay(
        client.model,
        calls.store,
        {
          promptId: SAME_PERSON_PROMPT.id,
          promptVersion: SAME_PERSON_PROMPT.version,
          data: { pair: pairSlot(pair) },
          label: { compartments: pair.compartments, readers: [THE_OWNER] },
          trustGroup: TrustGroupId.parse("personal-openrouter"),
        },
        { point: point.id, version: point.version, subject: pair.subject, refs, modelId: client.modelId },
        pair.compartments,
        [SAME_PERSON_PROMPT],
      );
      return SamePersonPairAnswer.parse(response.output);
    } catch (error) {
      if (error instanceof BudgetReached) return "budget";
      if ((await calls.lastId()) !== null) return null;
      const code = isCoded(error) ? error.code : undefined;
      if (typeof code !== "string") throw error;
      log.warn({ event: "same_person_call_failed", code });
      return "unavailable";
    }
  }
}

// The screen's answers already saved under its judge, as the split reads them.
export type ScreenAnswer = Pick<RelationCheck, "claimKey" | "otherKey" | "firstAnswer" | "secondAnswer">;
