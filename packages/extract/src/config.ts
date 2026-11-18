import {
  type EvidenceId,
  type LabelBinding,
  type LabelCheck,
  PipelineConfig,
  type SignedLabel,
  TrustGroupId,
} from "@intelligence/contracts";
import type { FactKindLane, PersonalLogger, PersonalPipelineStore } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS, THE_OWNER } from "@intelligence/personal-core";
import type { ModelClient } from "@intelligence/personal-models";
import type { RunThresholds } from "./decision-points.ts";

// Part of every claim id, and what "done" means: raised with any change that alters what an item
// yields, so every item is due again; an item whose prompt did not change replays its saved call. A
// new prompt version need not raise it: an item already done keeps its claims, which the belief
// rules re-judge at every rebuild, and the owner asks one again with `pi extract retry`, one live
// call each. Generation 5 is the atomic versions' (personal_correspondence version 4,
// personal_agent_record version 3) and fact key version 2's (`keyVersionOf`).
export const EXTRACT_GENERATION = 5;

// The generation in every call key. It never changes, so when raising EXTRACT_GENERATION makes
// items due again, each replays its saved call instead of asking the model.
export const CALL_GENERATION = 0;

// What every path of a run reads. `modelId` is the configured model id, recorded with each saved call;
// it decides nothing. `generation` is EXTRACT_GENERATION when absent; only a test passes another.
export type RunCore = {
  store: PersonalPipelineStore;
  model: ModelClient;
  modelId: string;
  log: PersonalLogger;
  now: () => Date;
  compartments?: string[];
  generation?: number;
};

// The owner's switches: what each lane and version may ask. A new switch goes here.
type LaneSwitches = {
  // Set when the owner has switched documents on (PI_EXTRACT_DOCUMENTS), with the days a document
  // stays in the lane after its last edit (PI_EXTRACT_DOCUMENT_DAYS); absent, no document is taken.
  documents?: { days: number };
  // Absent, meetings are still taken, committed `not_extracted` with their participants, and no
  // meeting is sent to a model.
  meetings?: true;
  // Absent, moments are still taken, each committed `not_extracted`, and no moment is sent to a
  // model.
  moments?: true;
  // Absent, an agent app's moment is committed `agent_app` and sent to no model.
  ownLines?: { dayMicroUsd: number };
  // Set by PI_EXTRACT_MOMENTS_MODE=continuous: the moment groups, each due once its latest moment
  // is MOMENT_SETTLE_MS old. Absent, the batched mode: the moments first pushed by the latest 00:00
  // or 12:00 on the owner's clock, one group per thread, day and label.
  momentsContinuous?: true;
  // A new item of the correspondence, meeting or moment lane, or a new agent finding, is then asked
  // its lane's second-degree version (asked-version.ts); an item whose call of the current version
  // is saved keeps it and replays it. Absent, every lane asks its current version. Never moves the
  // generation.
  secondDegree?: true;
  // Set by PI_EXTRACT_FACT_KINDS, the lanes the owner has switched on. A new item of a lane named
  // is asked its fact-kind version (asked-version.ts); an item whose call of the current or the
  // second-degree version is saved keeps it and replays it. Absent, nothing changes. Never moves the
  // generation.
  factKinds?: readonly FactKindLane[];
  // Set by PI_EXTRACT_REPAIR: a text value the exact match refuses is tried once by repairText, in
  // every lane but the meeting's, whose durable grounding already reads a restatement. A switch
  // since it changes what a replay stores. Absent, a refused value stays refused.
  repair?: true;
  // Set by PI_EXTRACT_REASK: an item of a message or a finding whose every candidate was refused for
  // its wording is asked again, once, under the run's and the day's budget. Absent, never.
  reask?: true;
};

// The other models, and the lines a run applies to the decide model's answers.
type RunModels = {
  // The moment lane's own client and model id, set by PI_EXTRACT_MOMENT_MODEL or
  // PI_EXTRACT_MOMENT_EFFORT. Every moment group's call, saved call and exposure note goes under
  // it. Absent, the moment lane asks `model` under `modelId`, as every other lane does.
  moment?: { model: ModelClient; modelId: string };
  // The decide-model client and its configured model id. Absent, every item takes the plain extraction path.
  // The decide model being on changes no generation, so no claim id.
  decideModel?: { model: ModelClient; modelId: string };
  // The lines this run applies, read once when it starts from the owner's grants. Absent,
  // every default.
  thresholds?: RunThresholds;
};

// What kind of run this is, and the steps after it.
type RunShape = {
  // The proposal wake's run. Agent records alone: no decide-model backlog, no mail, no meeting, document or
  // moment; the belief rebuild, the run's row and its line as any run's.
  agentRecords?: true;
  // `pi extract --capture`: the one stored meeting the owner named, or the group that holds the
  // moment they named, through its lane alone. No decide-model backlog, block day, mail, document or other
  // capture item; the belief rebuild, the run's row and its line as any run's. Set by `runCapture`
  // alone.
  capture?: CaptureRef;
  // The relation step, which `pi extract` wires (its store, its model client and the run's spend
  // lines). Run after the rebuild and before the after-commit diff, which consumes the rechecks it
  // reads. Absent, no step runs.
  relations?: () => Promise<void>;
  // The daily time proposals, which `pi extract` wires when the owner has set PI_EXTRACT_TIME:
  // after the relation step, on a whole run alone. Absent, no step runs.
  timeProposals?: () => Promise<void>;
  // The pipeline's pass over the three warmth lanes' gap flags, which `pi extract`
  // wires: after the day build, on every run but the standing check's. Absent, no pass runs.
  gapLanes?: () => Promise<void>;
};

export type ExtractDeps = RunCore & LaneSwitches & RunModels & RunShape;

export type CaptureRef = { evidenceId: EvidenceId; kind: "meeting" | "moment" };

// The shared pipeline's configuration for personal extraction. `specialCategoryCompartment` is a
// name no compartment has and no key is made for: the shared schema requires one, and the shared
// `check` reads it only for a `special_category` narrowing, which reaches `check` only after the
// owner's release, as `none`.
export const EXTRACT_CONFIG: PipelineConfig = Object.freeze(
  PipelineConfig.parse({
    vault: "personal",
    replyChainDepth: 0,
    gateway: "personal-openrouter",
    limits: { ...PERSONAL_LIMITS, promptChars: 60_000 },
    specialCategoryCompartment: "unused",
  }),
);

export const EXTRACT_TRUST_GROUP = TrustGroupId.parse(EXTRACT_CONFIG.gateway);

// The `verifyLabel` the shared `verify` is given for one stored item: it accepts only a label of
// exactly the row's compartments, read by the owner alone: a message's one, or an agent record's
// whole label. The item's signature and key reference are the core's sentinels, and nothing reads
// them.
export const verifyLabelFor =
  (compartments: readonly string[]) =>
  (signed: SignedLabel, _binding: LabelBinding): LabelCheck => {
    const { compartments: given, readers } = signed.label;
    const wanted = [...compartments].sort();
    const label = [...given].sort();
    const exact =
      label.length === wanted.length &&
      label.every((one, i) => one === wanted[i]) &&
      readers.length === 1 &&
      readers[0] === THE_OWNER;
    return exact ? { ok: true, label: signed.label } : { ok: false, reason: "wrong_binding" };
  };
