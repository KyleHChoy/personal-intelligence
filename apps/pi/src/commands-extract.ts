// The command table's rows for extraction and what steers it: the runs, the dream, relations, the
// ladder, learning, thresholds, the model key and the restricted worker.
import { MessageId } from "@intelligence/contracts/personal";
import {
  CAPTURE_REF,
  checkRetry,
  checkReview,
  checkWorldOptions,
  dreamFindingsOf,
  usage,
  valid,
  WORLD_LANES,
} from "./command-args.ts";
import {
  admin,
  dream,
  dreamOwner,
  extract,
  extractCheck,
  extractOwner,
  flag,
  KEY_FILE,
  ladder,
  learn,
  measure,
  models,
  PIPELINE_URL,
  pipeline,
  READER_URL,
  relations,
  restricted,
  text,
  thresholds,
  wake,
} from "./command-kit.ts";
import type { Rows } from "./command-types.ts";

export const EXTRACT: Rows = {
  // `--agent-records`, the proposal wake's run of agent records alone; `--capture
  // ID`, one stored meeting or moment alone, by its `cap_` id or capture key, as retry names one.
  extract: {
    scriptReads: "the timer, lib/wake-run and lib/canary-run read `busy`; the timer and lib/canary-run read `budget`",
    ...pipeline,
    args: "[--max-calls N] [--agent-records | --capture ID | --canary]",
    options: { "max-calls": text, "agent-records": flag, capture: text, canary: flag },
    check: ({ values }) => {
      const calls = values["max-calls"];
      if (calls !== undefined && !(typeof calls === "string" && /^[1-9]\d{0,5}$/.test(calls))) usage();
      const capture = values.capture;
      if (
        capture !== undefined &&
        (typeof capture !== "string" || !CAPTURE_REF.test(capture) || values["agent-records"] === true)
      )
        usage();
    },
    body: extract("extractCommand"),
  },
  // The document evaluation, `--world` and `--lane document` together or neither; the meeting
  // evaluation, with `--lane meeting`; the moment evaluation, with `--lane moment`; the
  // correspondence evaluation, with `--lane correspondence`; the notices and receipts, with
  // `--lane transaction`; the second-degree set, with `--lane second-degree`. On the synthetic
  // world alone, a model to compare with the configured one: `--vendor anthropic`, its `--model`
  // and `--effort`; `--detail`, each meeting's, moment group's or message's line; and
  // `--pseudonymise`, the set run twice, plain and pseudonymised, with the lines that differ.
  "extract check": {
    ...pipeline,
    args: "[--world --lane document|meeting|moment|correspondence|transaction|second-degree [--vendor openrouter|anthropic] [--model ID] [--effort low|medium|high|max] [--detail] [--runs 1-5] [--pseudonymise]]",
    options: {
      world: flag,
      lane: text,
      vendor: text,
      model: text,
      effort: text,
      detail: flag,
      runs: text,
      pseudonymise: flag,
    },
    check: ({ values }) => {
      if (
        (values.world === true) !== (values.lane !== undefined) ||
        (values.lane !== undefined && !(WORLD_LANES as readonly string[]).includes(values.lane as string))
      )
        usage();
      checkWorldOptions(values);
    },
    body: extractCheck("extractCheck"),
  },
  // The proposal wake's listener. It reads nothing and holds no key: it starts RUN,
  // the box's wake script, after each burst of agent proposals and owner answers.
  "extract wake": {
    role: "pipeline",
    requires: [PIPELINE_URL],
    args: "RUN",
    positionals: 1,
    body: wake("extractWake"),
  },
};

export const EXTRACT_UPKEEP: Rows = {
  // The match key of every card raised before card matching, once.
  "extract match-backfill": { ...pipeline, requires: [PIPELINE_URL, KEY_FILE], body: extract("extractMatchBackfill") },
  // Every key's current state as a trigger baseline.
  "triggers seed": { ...pipeline, requires: [PIPELINE_URL, KEY_FILE], body: extract("triggersSeed") },
  // The daily ageing, with no model setting and no key.
  "extract age": { ...pipeline, requires: [PIPELINE_URL, KEY_FILE], body: extract("extractAge") },
  "extract status": { ...admin, body: extractOwner("extractStatus") },
  // The value rows of claims stored before value rows existed, and the carry-over
  // check a generation raise runs before its claims are served. Ids and counts only.
  "extract value-fp-backfill": { ...admin, body: extractOwner("extractValueFpBackfill") },
  // With --reattach, each unfound ruling re-attached by code where its item now
  // holds exactly one fact of its type and subject, and an owner question for the doubtful ones;
  // counts only. --dry-run writes nothing. With --anchor, each ruling in force without its anchors
  // given them; counts only. With --gate, what the generation would do to the rulings in force and
  // whether the gate refuses it; ids and counts.
  "extract carry-over": {
    ...admin,
    args: "--generation N [--reattach [--dry-run] | --anchor | --gate]",
    options: { generation: text, reattach: flag, "dry-run": flag, anchor: flag, gate: flag },
    check: ({ values }) => {
      if (!(typeof values.generation === "string" && /^(0|[1-9]\d{0,3})$/.test(values.generation))) usage();
      if (values["dry-run"] === true && values.reattach !== true) usage();
      if ([values.reattach, values.anchor, values.gate].filter((one) => one === true).length > 1) usage();
    },
    body: extractOwner("extractCarryOver"),
  },
  // The owner's override of a model relation kind's switch for the relation step's judge, and the
  // one-time conversion of the same-fact groupings into relations. Counts and codes only.
  // The dream pass.
  dream: {
    scriptReads: 'the timer reads `busy` and the counts\' `"stopped":"ok"`, `"budget"` or `"unavailable"`',
    ...pipeline,
    args: "[--pass nightly|weekly] [--max-calls N] [--usd D] [--seconds S]",
    options: { pass: text, "max-calls": text, usd: text, seconds: text },
    positionals: 0,
    body: dream("dreamCommand"),
  },
  // The owner's line for a kind (or the checker's gate), the week's sample and the owner's mark
  // on one of it, the owner's lift of an agent's settlement, and the trial nights.
  "dream line": {
    ...admin,
    args: "KIND (VALUE | --unset) [--marks N]",
    options: { unset: flag, marks: text },
    positionals: [1, 2],
    body: dreamOwner("dreamLine"),
  },
  "dream model": {
    ...admin,
    args: "(check | screen) (ID | --unset)",
    options: { unset: flag },
    positionals: [1, 2],
    body: dreamOwner("dreamModel"),
  },
  "dream lines": { ...admin, args: "", options: {}, positionals: 0, body: dreamOwner("dreamLines") },
  "dream sample": { ...admin, args: "", options: {}, positionals: 0, body: dreamOwner("dreamSample") },
  "dream mark": {
    ...admin,
    args: "CHECK (right | wrong) [--new]",
    options: { new: flag },
    positionals: 2,
    body: dreamOwner("dreamMark"),
  },
  "dream settlements lift": {
    ...admin,
    args: "ID",
    options: {},
    positionals: 1,
    body: dreamOwner("dreamSettlementLift"),
  },
  // What dreaming found, each with its two claims' words, for the owner to read and judge.
  "dream findings": {
    ...admin,
    args: "[--kind KIND] [--limit N] [--effective]",
    options: { kind: text, limit: text, effective: flag },
    check: ({ values }) => void dreamFindingsOf(values),
    body: dreamOwner("dreamFindings"),
  },
  "dream nights": { ...admin, args: "", options: {}, positionals: 0, body: dreamOwner("dreamNights") },
  "dream trial": { ...admin, args: "", options: {}, positionals: 0, body: dreamOwner("dreamTrial") },
  "relations on": {
    ...admin,
    args: "KIND [--model ID]",
    options: { model: text },
    positionals: 1,
    body: relations("relationsOn"),
  },
  "relations off": {
    ...admin,
    args: "KIND [--model ID]",
    options: { model: text },
    positionals: 1,
    body: relations("relationsOff"),
  },
  "relations convert-groupings": { ...admin, body: relations("relationsConvertGroupings") },
  // Read-only: each owner's-audience fact, stored against computed, by code.
  // Read-only measurements, counts and milliseconds only.
  "extract measure-beliefs": {
    role: "reader",
    requires: [READER_URL, KEY_FILE, "PI_CLIENT_TOKEN"],
    body: measure("extractMeasureBeliefs"),
  },
  // `about` timed against its deadline and get_entity's, as measure-beliefs reads.
  "extract measure-about": {
    role: "reader",
    requires: [READER_URL, KEY_FILE, "PI_CLIENT_TOKEN"],
    body: measure("extractMeasureAbout"),
  },
  // get_entity's, get_self's and search's read paths, statement by statement.
  "extract measure-reads": {
    role: "reader",
    requires: [READER_URL, KEY_FILE, "PI_CLIENT_TOKEN"],
    args: "[--explain]",
    options: { explain: flag },
    body: measure("extractMeasureReads"),
  },
  "extract measure-disputes": {
    ...pipeline,
    requires: [PIPELINE_URL, KEY_FILE],
    body: measure("extractMeasureDisputes"),
  },
  "extract measure-projects": {
    ...pipeline,
    requires: [PIPELINE_URL, KEY_FILE],
    body: measure("extractMeasureProjects"),
  },
  "extract review": {
    ...admin,
    terminalOnly: true,
    args: "[--type T] [--sample N]",
    options: { type: text, sample: text },
    check: checkReview,
    body: extractOwner("extractReview"),
  },
  // The review as one document: the same sample, and its verdicts read back.
  // The export holds decrypted mail from every compartment, so it is printed to a terminal only.
  "extract review-export": {
    ...admin,
    terminalOnly: true,
    terminalHint: "review-export prints decrypted mail: run it in a terminal, not into a pipe or a file",
    args: "[--type T] [--sample N]",
    options: { type: text, sample: text },
    check: checkReview,
    body: extractOwner("extractReviewExport"),
  },
  "extract review-import": { ...admin, body: extractOwner("extractReviewImport") },
  // The done transaction-lane items from known correspondents, set waiting for the
  // correspondence lane, counted first with --dry-run; and one message's extraction, ids and codes.
  "extract reroute": {
    ...admin,
    args: "[--dry-run]",
    options: { "dry-run": flag },
    body: extractOwner("extractReroute"),
  },
  "extract item": {
    ...admin,
    args: "--message ID",
    options: { message: text },
    check: ({ values }) => {
      if (values.message === undefined || !valid(MessageId, values.message)) usage();
    },
    body: extractOwner("extractItem"),
  },
  "extract retry": {
    ...admin,
    args: "(--all | --status S | --message ID | --document ID) [--lane L] [--yes] | --kind meeting|moment [--status S] [--yes] | --in-lane correspondence|transaction|agent [--status S] [--yes] [--keep-answers [--fact-kinds LANES]] | --capture ID | --message ID --override",
    options: {
      all: flag,
      status: text,
      message: text,
      document: text,
      lane: text,
      yes: flag,
      override: flag,
      kind: text,
      capture: text,
      "in-lane": text,
      "keep-answers": flag,
      "fact-kinds": text,
    },
    check: checkRetry,
    body: extractOwner("extractRetry"),
  },
};

export const CALIBRATION: Rows = {
  // The ladder's calibration.
  "ladder review": {
    ...admin,
    terminalOnly: true,
    args: "--point P [--sample N]",
    options: { point: text, sample: text },
    check: ({ values }) => {
      const sample = values.sample;
      if (
        typeof values.point !== "string" ||
        (sample !== undefined &&
          !(typeof sample === "string" && /^[1-9]\d{0,2}$/.test(sample) && Number(sample) <= 500))
      )
        usage();
    },
    body: ladder("ladderReview"),
  },
  "ladder calibrate": { ...admin, args: "[--point P]", options: { point: text }, body: ladder("ladderCalibrate") },
  "ladder resume": { ...admin, args: "POINT", positionals: 1, body: ladder("ladderResume") },
  // Learning. The silence
  // sample is for a terminal only.
  "learn label": {
    ...admin,
    args: "CARD --labels L,...",
    options: { labels: text },
    positionals: 1,
    body: learn("learnLabel"),
  },
  "learn silences": {
    ...admin,
    terminalOnly: true,
    args: "[--sample N | --pending]",
    options: { sample: text, pending: flag },
    check: ({ values }) => {
      const sample = values.sample;
      if (
        (sample !== undefined && !(typeof sample === "string" && /^[1-9]\d?$/.test(sample) && Number(sample) <= 20)) ||
        (sample !== undefined && values.pending === true)
      )
        usage();
    },
    body: learn("learnSilences"),
  },
  "thresholds list": { ...admin, body: thresholds("thresholdsList") },
  "thresholds target": {
    ...admin,
    args: "POINT (--recall R | --miss M | --precision P)",
    options: { recall: text, miss: text, precision: text },
    positionals: 1,
    body: thresholds("thresholdsTarget"),
  },
  "thresholds grant": { ...admin, args: "PROPOSAL", positionals: 1, body: thresholds("thresholdsGrant") },
  "thresholds set": {
    ...admin,
    args: "POINT --name N --value V",
    options: { name: text, value: text },
    positionals: 1,
    body: thresholds("thresholdsSet"),
  },
  "thresholds revoke": { ...admin, args: "ID", positionals: 1, body: thresholds("thresholdsRevoke") },
  "models set-key": { ...admin, body: models("setKey") },
  "models import-key": {
    scriptReads: "the entrypoint reads `model_key_replaced` on its stderr",
    ...admin,
    requires: [...admin.requires, "PI_OPENROUTER_KEY"],
    modelKey: true,
    body: models("importKey"),
  },
  // The lift is not built: a stub here.
  "restricted list": { ...admin, body: restricted("restrictedList") },
  // The one-time reclassification of stored mail by the term screen; a dry run without --apply.
  "restricted reclassify": {
    ...admin,
    args: "[--apply]",
    options: { apply: flag },
    body: restricted("restrictedReclassify"),
  },
  "restricted lift": {
    ...admin,
    args: "--message ID --category C",
    options: { message: text, category: text },
    body: restricted("restrictedLift"),
  },
};

export const EXTRACT_TRIALS: Rows = {
  // The trial of prompt version 4 over the newest correspondence items, at
  // most 500, writing only saved calls, usage rows and exposure notes. Counts only.
  "extract trial": {
    ...pipeline,
    // --replay: the items whose version 4 call is saved, read again at no cost.
    // --second-degree: the lane's second-degree version, to price its backfill.
    // --lane and --fact-kinds: the transaction lane's items or the agent lane's findings, and the
    // lane's fact-kind version, beside each item's saved call of the version it was done under.
    // --own-lines: an agent app's moments, the owner's lines alone.
    args: "[--lane correspondence|transaction|agent] [--sample N] [--replay [--next-generation [--show-drops]]] [--project] [--second-degree | --fact-kinds [--show TYPES]] | --own-lines [--sample N] [--show TYPES]",
    options: {
      lane: text,
      sample: text,
      replay: flag,
      project: flag,
      "next-generation": flag,
      "show-drops": flag,
      "second-degree": flag,
      "fact-kinds": flag,
      show: text,
      "own-lines": flag,
    },
    check: ({ values }) => {
      const sample = values.sample;
      const own = values["own-lines"] === true;
      // A lane of its own, which takes --sample and --show alone.
      if (
        own &&
        (values.lane !== undefined ||
          values.replay === true ||
          values.project === true ||
          values["next-generation"] === true ||
          values["show-drops"] === true ||
          values["second-degree"] === true ||
          values["fact-kinds"] === true)
      )
        usage();
      if (
        sample !== undefined &&
        !(typeof sample === "string" && /^[1-9]\d{0,2}$/.test(sample) && Number(sample) <= 500)
      )
        usage();
      if (
        values.lane !== undefined &&
        values.lane !== "correspondence" &&
        values.lane !== "transaction" &&
        values.lane !== "agent"
      )
        usage();
      if (values["next-generation"] === true && values.replay !== true) usage();
      // Only a fact-kind trial of the mail lane reads a message's project.
      if (
        values.project === true &&
        (values["fact-kinds"] !== true || (values.lane ?? "correspondence") !== "correspondence")
      )
        usage();
      if (values["show-drops"] === true && values["next-generation"] !== true) usage();
      if (
        values["second-degree"] === true &&
        (values["fact-kinds"] === true || values.lane === "transaction" || values.lane === "agent")
      )
        usage();
      // The agent lane's trial is of its fact-kind version alone.
      if (values.lane === "agent" && values["fact-kinds"] !== true) usage();
      // Every done transaction item has its version 2 call saved, so that lane's trial asks the
      // fact-kind version or replays.
      if (values.lane === "transaction" && values["fact-kinds"] !== true && values.replay !== true) usage();
      if (
        values.show !== undefined &&
        ((values["fact-kinds"] !== true && !own) ||
          typeof values.show !== "string" ||
          !/^[a-z_.]+(,[a-z_.]+){0,9}$/.test(values.show))
      )
        usage();
    },
    body: extract("extractTrial"),
  },
  // The newest refused messages' saved answers read again, the repair off and on: no model, nothing
  // written. --show prints what each said, to a terminal only.
  "extract refusals": {
    ...pipeline,
    args: "[--sample N] [--show]",
    options: { sample: text, show: flag },
    check: ({ values }) => {
      const sample = values.sample;
      if (
        sample !== undefined &&
        !(typeof sample === "string" && /^[1-9]\d{0,2}$/.test(sample) && Number(sample) <= 500)
      )
        usage();
    },
    body: extract("extractRefusals"),
  },
  // The items whose candidates were refused for their fields, set waiting to replay their saved
  // answers under today's check. Over fifty without --yes it changes nothing and prints the count.
  "extract replay-refused": {
    ...admin,
    args: "[--yes]",
    options: { yes: flag },
    body: extractOwner("extractReplayRefused"),
  },
};
