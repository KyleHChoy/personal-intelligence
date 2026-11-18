import type { EvidenceId } from "@intelligence/contracts";
import type { PersonalLogger, PersonalPipelineStore } from "@intelligence/contracts/personal";
import { REASK_WINDOW } from "@intelligence/personal-core/planner";
import { createDb, type Db } from "../core/job-db.ts";
import { erasureLevel } from "../core/journal.ts";
import type { Keys } from "../core/keys.ts";
import { EXTRACT_SESSION } from "../core/locks.ts";
import { lockedSession } from "../core/session-lock.ts";
import { latestGrants } from "../core/thresholds.ts";
import { type Tx, unavailable } from "../core/tx.ts";
import { ownerDayOf } from "../core/zone.ts";
import type { AudienceBeliefs } from "../identity/grouping.ts";
import { itemProjects } from "../identity/project-bindings.ts";
import { buildDueDays } from "../identity/warmth-days.ts";
import { beliefDecisions } from "./belief-decisions.ts";
import { beliefClaimsOf } from "./belief-inputs.ts";
import { carryGate } from "./carry-gate.ts";
import { computedBeliefs } from "./computed-beliefs.ts";
import { knownIdentitiesOf } from "./known-identities.ts";
import {
  callCost,
  findCall,
  type LaneOff,
  noteModelRoute,
  recordRunRow,
  recordUsageRow,
  saveCall,
  spentSince,
} from "./pipeline-calls.ts";
import { raiseNeedQuestionCards, raiseReleasedCards } from "./pipeline-cards.ts";
import {
  backlogItems,
  dueDocuments,
  dueItems,
  findingBacklogItems,
  markRecovery,
  recoveryBacklogItems,
  refusedItems,
} from "./pipeline-due.ts";
import { captureNamed, dueCaptures, ownLineCandidates } from "./pipeline-due-captures.ts";
import {
  linkContextOf,
  openBlockDayItem,
  openCaptureItem,
  openItem,
  openMomentItem,
  openRecordItem,
} from "./pipeline-open.ts";
import { audiencesOf, keyFingerprint, modelSecret, ownerAudienceOf, suspensionsOf } from "./pipeline-read.ts";
import { restatementCandidates } from "./pipeline-restatement.ts";
import { commitBatch, countAttempts, deferItem, reaskRates, requeueRetries } from "./pipeline-write.ts";
import { type TriggerSeedSummary, triggerPass, triggerSeed } from "./triggers.ts";
import { setMatchKey, type UnkeyedCard, unkeyedCards } from "./unkeyed-cards.ts";

// The pipeline's store, run as pi_pipeline for `pi extract`. Every value goes to the database as a
// bind parameter.

// `extractLockFree` asks whether the extract lock is free, taking it and giving it back at once, so
// a command learns of a run in flight before it spends anything. `captureNamed` is `pi extract
// --capture`'s lookup of the meeting or moment the owner named.
export type Pipeline = PersonalPipelineStore & {
  triggerPass: NonNullable<PersonalPipelineStore["triggerPass"]>;
  // `pia triggers seed`: every key's current state as a baseline, raising nothing.
  triggerSeed(): Promise<TriggerSeedSummary>;
  erasureLevel(): Promise<"level" | "behind">;
  extractLockFree(): Promise<boolean>;
  captureNamed(value: string): Promise<{ evidenceId: EvidenceId; kind: "meeting" | "moment" } | null>;
  unkeyedCards(page: { size: number; after?: string }): Promise<UnkeyedCard[]>;
  setMatchKey(card: string, key: string): Promise<boolean>;
  // The dream lane's dollars and calls since the start of the UTC day, from
  // which `pi dream` starts its night, and whether one of its answers today carried no cost.
  dreamSpentToday(): Promise<{ microUsd: number; calls: number; costMissing: boolean }>;
  // The people's names, addresses, phones and handles the pseudonymiser replaces before a model call.
  knownIdentities(): ReturnType<typeof knownIdentitiesOf>;
  // The beliefs of the given kinds a reader of each active client's clearance and of the owner's is
  // given, computed as of the database's now(): the same-fact sweep's input, no stored answer read.
  sweepBeliefs(types: readonly string[]): Promise<AudienceBeliefs[]>;
  close(): Promise<void>;
};

// `lanesOff`: the lanes this process's switches have off, recorded in each run's
// row for `pia status --coverage`, which cannot read the extract process's environment. Null, the
// default, records none: a run that may start from a shell without the switches.
export function createPipeline({
  url,
  keys,
  log,
  journal,
  lanesOff = null,
}: {
  url: string;
  keys: Keys;
  log: PersonalLogger;
  journal?: string;
  lanesOff?: readonly LaneOff[] | null;
}): Pipeline {
  const db = createDb(url, log);
  const direct: Tx = { query: db.query, keys };
  const transaction = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => db.transaction((query) => fn({ query, keys }));

  // Once the lock's connection has gone nothing is written: another run may hold the lock by now,
  // and both would buy the same calls. Reads are not refused.
  const extract = lockedSession(db, EXTRACT_SESSION);
  const write = extract.write;
  const written = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => write(() => transaction(fn));

  // The evidence row's xmin for each item `open` returned in this run: `commit` and `calls.save`
  // throw when it has changed since.
  const seen = new Map<string, string>();

  return {
    withExtractLock: extract.withLock,
    extractLockFree: () =>
      db.session(async (query) => {
        const [lock] = await query<{ held: boolean }>(EXTRACT_SESSION.try);
        if (lock?.held !== true) return false;
        await query(EXTRACT_SESSION.give);
        return true;
      }),
    due: (limit, generation, options) => dueItems(direct, limit, generation, options),
    backlog: (limit, generation, prompt, options) => backlogItems(direct, limit, generation, prompt, options),
    findingBacklog: (limit, generation, prompt, options) =>
      findingBacklogItems(direct, limit, generation, prompt, options),
    refusedItems: (limit, generation, options) => refusedItems(direct, limit, generation, options),
    callCost: (promptId) => callCost(db.query, promptId),
    // The document lane's two, beside `due` and `open`; the meeting lane's two, beside the documents'.
    dueDocuments: (limit, generation, options) => dueDocuments(direct, limit, generation, options),
    ownLineCandidates: (limit, options) => ownLineCandidates(direct, limit, options),
    dueCaptures: (lane, limit, generation, options) => dueCaptures(direct, lane, limit, generation, options),
    captureNamed: (value) => captureNamed(direct, value),
    // What the link step reads of a meeting or a moment.
    linkContext: (evidenceId) => linkContextOf(direct, evidenceId),
    ...openers(direct, seen),
    // A moment group's members, each with the xmin its open saw, saved with the call.
    calls: (modelId, members = []) => ({
      find: (key) => findCall(direct, key, modelId),
      save: (record) =>
        written((tx) =>
          saveCall(
            tx,
            modelId,
            record,
            seen.get(record.key.evidenceId),
            members.map((evidenceId) => ({ evidenceId, xmin: seen.get(evidenceId) })),
          ),
        ),
    }),
    recordUsage: (event, lane = "extract") => write(() => recordUsageRow(direct, event, lane)),
    spentSince: (day) => spentSince(db.query, day),
    async carryGate(generation) {
      const gate = await carryGate(db.query, generation);
      return {
        refused: gate.refused,
        max: gate.max,
        unanchored: gate.unanchored.length,
        detached: gate.detached.length,
      };
    },
    spentOnPromptSince: (promptId, day) => spentSince(db.query, day, promptId),
    // A call is a usage row other than a key check, as `pi status` counts calls. The owner's day, in
    // their zone, as the night's rows are recorded.
    knownIdentities: () => knownIdentitiesOf(direct),
    async dreamSpentToday() {
      const [row] = await db.query<{ spent: string | null; calls: number; missing: boolean }>(
        `select sum(cost_microusd)::text as spent, count(*) filter (where outcome <> 'check')::int as calls, coalesce(bool_or(outcome = 'cost_missing'), false) as missing
         from vault.model_usage where lane = 'dream' and day = $1::date`,
        [await ownerDayOf(db.query)],
      );
      return { microUsd: Number(row?.spent ?? 0), calls: row?.calls ?? 0, costMissing: row?.missing === true };
    },
    recordRun: (run) => write(() => recordRunRow(direct, run, lanesOff)),
    // Nothing is written: the commit writes the answer, against the beliefs as stored when the candidates were
    // read.
    restatementCandidates: (evidenceId, asked) => transaction((tx) => restatementCandidates(tx, evidenceId, asked)),
    commit: (batch) => written((tx) => commitBatch(tx, batch, seen.get(batch.evidenceId), log)),
    keyFingerprint: (key) => keyFingerprint(keys, key),
    defer: (evidenceId, generation, outcome) => written((tx) => deferItem(tx, evidenceId, generation, outcome)),
    countAttempt: (evidenceIds, generation) => written((tx) => countAttempts(tx, evidenceIds, generation)),
    requeueRetries: () => write(() => requeueRetries(db.query)),
    reaskRates: (wording) => reaskRates(db.query, wording, REASK_WINDOW),
    ...beliefReads({ db, keys }),
    // The owner's needs asked as questions, each an about_you card, up to the cap.
    raiseNeedQuestions: (claimIds) =>
      claimIds.length === 0
        ? Promise.resolve({ raised: 0 })
        : written((tx) => raiseNeedQuestionCards(tx, claimIds, log)),
    raiseSettledClaims: () => written((tx) => raiseReleasedCards(tx, log)),
    // `pi extract match-backfill`'s two halves, each under the author word. The
    // cards of the two kinds with no match key whose claim still opens, with its content; and one
    // match key set on one card, only where it has none.
    unkeyedCards: (limit) => transaction((tx) => unkeyedCards(tx, limit)),
    setMatchKey: (card, key) => written((tx) => setMatchKey(tx, card, key)),
    // Each due label's warmth days, which the reads rank from under the reader's clearance.
    buildWarmth: () => write(() => buildDueDays(db, keys, log)),
    // One pass of the after-commit diff, whose trigger log the reasoner's wakes read.
    triggerPass: () => write(() => triggerPass(db, keys, log)),
    triggerSeed: () => write(() => triggerSeed(db, keys, log)),
    secret: (name) => modelSecret(db.query, keys, name),
    markRecovery: (evidenceId, hold) => written((tx) => markRecovery(tx, evidenceId, hold, seen)),
    recoveryBacklog: (limit, options) => recoveryBacklogItems(direct, limit, options),
    // The latest unrevoked grant of each point, version and name: the admin's own query.
    thresholds: () => latestGrants(db.query),
    suspensions: () => suspensionsOf(db.query),
    // Any failure is `unavailable`, and no request may then be sent.
    noteExposure: (modelId, promptId, evidenceIds) =>
      write(() => db.transaction((query) => noteModelRoute(query, modelId, promptId, evidenceIds))).catch(() => {
        throw unavailable();
      }),
    erasureLevel() {
      if (journal === undefined) return Promise.reject(new Error("the pipeline was made without the journal's path"));
      return erasureLevel(db.query, journal);
    },
    close: () => db.close(),
  };
}

// The item opens of one run. Each item an open returns has its evidence row's xmin kept in `seen`,
// which `commit` and `calls.save` compare.
function openers(
  direct: Tx,
  seen: Map<string, string>,
): Pick<Pipeline, "open" | "openDocument" | "openCapture" | "openMoment" | "openBlockDay" | "openRecord"> {
  const kept = async <T extends { xmin: string }>(evidenceId: EvidenceId, found: Promise<T | null>) => {
    const one = await found;
    if (one !== null) seen.set(evidenceId, one.xmin);
    return one;
  };
  return {
    open: async (evidenceId, options) =>
      (await kept(evidenceId, openItem(direct, evidenceId, undefined, options)))?.item ?? null,
    openDocument: async (evidenceId) =>
      (await kept(evidenceId, openItem(direct, evidenceId, "document")))?.item ?? null,
    openCapture: async (evidenceId) => (await kept(evidenceId, openCaptureItem(direct, evidenceId)))?.capture ?? null,
    // A moment, beside a meeting.
    async openMoment(evidenceId, options) {
      const found = await kept(evidenceId, openMomentItem(direct, evidenceId));
      if (found === null) return null;
      return options?.projects === true
        ? { ...found.moment, projects: await itemProjects(direct, null, found.moment.context.compartments) }
        : found.moment;
    },
    // A block day split for the activity step.
    openBlockDay: async (evidenceId) => (await kept(evidenceId, openBlockDayItem(direct, evidenceId)))?.day ?? null,
    openRecord: async (evidenceId) => (await kept(evidenceId, openRecordItem(direct, evidenceId)))?.record ?? null,
  };
}

// The reads beliefs are computed from: their claims, the owner's rulings and the audiences, and the
// beliefs of each audience computed as of the database's now().
function beliefReads({
  db,
  keys,
}: {
  db: Db;
  keys: Keys;
}): Pick<Pipeline, "audiences" | "beliefClaims" | "beliefDecisions" | "ownerAudience" | "sweepBeliefs"> {
  return {
    audiences: () => audiencesOf(db.query),
    beliefClaims: () => beliefClaimsOf(db.query, keys),
    beliefDecisions: () => beliefDecisions(db.query, keys),
    ownerAudience: () => ownerAudienceOf(db.query),
    async sweepBeliefs(types) {
      const audiences = await audiencesOf(db.query);
      const owner = await ownerAudienceOf(db.query);
      if (owner.length > 0 && !audiences.some((one) => one.join("\n") === owner.join("\n"))) audiences.push(owner);
      const keyed = await db.query<{ fact_key_fp: string }>(
        "select distinct fact_key_fp from knowledge.claims where type = any ($1::text[]) order by 1",
        [[...types]],
      );
      const [clock] = await db.query<{ now: Date }>("select now() as now");
      const factKeys = keyed.map((row) => row.fact_key_fp);
      const asOf = (clock?.now ?? new Date()).toISOString();
      const built: AudienceBeliefs[] = [];
      for (const audience of audiences)
        built.push({ audience, records: await computedBeliefs(db.query, keys, audience, factKeys, asOf) });
      return built;
    },
  };
}
